/** 云端模型调用留痕：出网载荷（已脱敏）必须可查、可清空。 */
import type { Db } from './database.ts';

export interface LlmCallRecord {
  purpose: string;
  redactedPayload: string;
  provider: string;
  ok: boolean;
  latencyMs: number;
}

export interface LlmRepo {
  log(record: LlmCallRecord, now: string): void;
  list(limit: number): Array<LlmCallRecord & { id: number; createdAt: string }>;
  count(): number;
  clear(): number;
}

export function createLlmRepo(db: Db): LlmRepo {
  const count = (): number => {
    const row = db.prepare('SELECT COUNT(*) AS n FROM llm_call_log').get() as { n: number };
    return Number(row.n);
  };

  return {
    log(record, now): void {
      db.prepare(
        'INSERT INTO llm_call_log (purpose, redacted_payload, provider, ok, latency_ms, created_at) VALUES (?,?,?,?,?,?)',
      ).run(record.purpose, record.redactedPayload, record.provider, record.ok ? 1 : 0, record.latencyMs, now);
    },

    list(limit): Array<LlmCallRecord & { id: number; createdAt: string }> {
      const rows = db
        .prepare('SELECT * FROM llm_call_log ORDER BY id DESC LIMIT ?')
        .all(limit) as unknown as Array<{
        id: number;
        purpose: string;
        redacted_payload: string;
        provider: string;
        ok: number;
        latency_ms: number;
        created_at: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        purpose: row.purpose,
        redactedPayload: row.redacted_payload,
        provider: row.provider,
        ok: row.ok === 1,
        latencyMs: row.latency_ms,
        createdAt: row.created_at,
      }));
    },

    count,

    clear(): number {
      const before = count();
      db.prepare('DELETE FROM llm_call_log').run();
      return before;
    },
  };
}

/** 每日运行记录仓储（幂等键 + 快照 + 推送状态）。 */
import type { Db } from './database.ts';

export interface DailyRunRecord {
  runKey: string;
  localDate: string;
  metricsJson: string;
  advicesJson: string;
  revision: number;
  pushedAt: string | null;
  channel: string | null;
  pushStatus: string | null;
}

interface RunRow {
  run_key: string;
  local_date: string;
  metrics_json: string;
  advices_json: string;
  revision: number;
  pushed_at: string | null;
  channel: string | null;
  push_status: string | null;
}

function rowToRun(row: RunRow): DailyRunRecord {
  return {
    runKey: row.run_key,
    localDate: row.local_date,
    metricsJson: row.metrics_json,
    advicesJson: row.advices_json,
    revision: row.revision,
    pushedAt: row.pushed_at,
    channel: row.channel,
    pushStatus: row.push_status,
  };
}

export interface RunRepo {
  get(runKey: string): DailyRunRecord | null;
  save(record: Omit<DailyRunRecord, 'revision' | 'pushedAt' | 'channel' | 'pushStatus'> & { revision?: number }): void;
  markPushed(args: { runKey: string; at: string; channel: string; status: string; revision: number }): void;
  nextRevision(runKey: string): number;
  latestForDate(localDate: string): DailyRunRecord | null;
  listRecent(limit: number): DailyRunRecord[];
  countPushedSince(isoDate: string): number;
}

export function createRunRepo(db: Db): RunRepo {
  const get = (runKey: string): DailyRunRecord | null => {
    const row = db.prepare('SELECT * FROM daily_run WHERE run_key = ?').get(runKey) as unknown as RunRow | undefined;
    return row ? rowToRun(row) : null;
  };

  return {
    get,

    save(record): void {
      db.prepare(
        `INSERT INTO daily_run (run_key, local_date, metrics_json, advices_json, revision, pushed_at, channel, push_status)
         VALUES (?,?,?,?,?,NULL,NULL,NULL)
         ON CONFLICT(run_key) DO UPDATE SET
           metrics_json=excluded.metrics_json,
           advices_json=excluded.advices_json,
           revision=excluded.revision`,
      ).run(
        record.runKey,
        record.localDate,
        record.metricsJson,
        record.advicesJson,
        record.revision ?? 1,
      );
    },

    markPushed(args): void {
      db.prepare('UPDATE daily_run SET pushed_at=?, channel=?, push_status=?, revision=? WHERE run_key=?').run(
        args.at,
        args.channel,
        args.status,
        args.revision,
        args.runKey,
      );
    },

    nextRevision(runKey): number {
      const existing = get(runKey);
      return (existing?.revision ?? 0) + 1;
    },

    latestForDate(localDate): DailyRunRecord | null {
      const row = db
        .prepare('SELECT * FROM daily_run WHERE local_date = ? ORDER BY revision DESC LIMIT 1')
        .get(localDate) as unknown as RunRow | undefined;
      return row ? rowToRun(row) : null;
    },

    listRecent(limit): DailyRunRecord[] {
      return (
        db.prepare('SELECT * FROM daily_run ORDER BY local_date DESC, revision DESC LIMIT ?').all(limit) as unknown as RunRow[]
      ).map(rowToRun);
    },

    countPushedSince(isoDate): number {
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM daily_run WHERE pushed_at IS NOT NULL AND pushed_at >= ?')
        .get(isoDate) as { n: number };
      return Number(row.n);
    },
  };
}

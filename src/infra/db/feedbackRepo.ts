/** 建议反馈仓储：把"忽略/不准/稍后提醒/关闭规则"变成可用的降噪状态。 */
import type { FeedbackState } from '../../domain/types.ts';
import type { Db } from './database.ts';

export type FeedbackAction = 'viewed' | 'ignored' | 'snoozed' | 'inaccurate' | 'record_added';

export interface FeedbackEntry {
  adviceId: string;
  ruleId: string;
  action: FeedbackAction;
  reason?: string | null;
  note?: string | null;
}

export interface FeedbackRepo {
  add(entry: FeedbackEntry, now: string): void;
  state(): FeedbackState;
  muteRule(ruleId: string, now: string): void;
  unmuteRule(ruleId: string): void;
  mutedRules(): string[];
  inaccurateCounts(): Record<string, number>;
  /** 清零某规则的"不准"计数（设置页用） */
  resetInaccurate(ruleId: string): void;
  listRecent(limit: number): Array<FeedbackEntry & { id: number; createdAt: string }>;
}

export const COOLDOWN_PREFIX = 'until=';

export function cooldownReason(untilDate: string): string {
  return `${COOLDOWN_PREFIX}${untilDate}`;
}

export function parseCooldown(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (!reason.startsWith(COOLDOWN_PREFIX)) return null;
  const value = reason.slice(COOLDOWN_PREFIX.length).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

interface FeedbackRow {
  id: number;
  advice_id: string;
  rule_id: string;
  action: string;
  reason: string | null;
  note: string | null;
  created_at: string;
}

export function createFeedbackRepo(db: Db): FeedbackRepo {
  const state = (): FeedbackState => {
    const muted = (db.prepare('SELECT rule_id FROM rule_pref WHERE muted = 1').all() as unknown as Array<{ rule_id: string }>).map(
      (r) => r.rule_id,
    );

    const inaccurateRows = db
      .prepare("SELECT rule_id, COUNT(*) AS n FROM advice_feedback WHERE action='inaccurate' GROUP BY rule_id")
      .all() as unknown as Array<{ rule_id: string; n: number }>;
    const inaccurateCounts: Record<string, number> = {};
    for (const row of inaccurateRows) inaccurateCounts[row.rule_id] = Number(row.n);

    const snoozeRows = db
      .prepare("SELECT rule_id, reason FROM advice_feedback WHERE action='snoozed' ORDER BY id DESC")
      .all() as unknown as Array<{ rule_id: string; reason: string | null }>;
    const cooldownUntil: Record<string, string> = {};
    for (const row of snoozeRows) {
      const until = parseCooldown(row.reason);
      if (!until) continue;
      const current = cooldownUntil[row.rule_id];
      if (!current || until > current) cooldownUntil[row.rule_id] = until;
    }

    return { mutedRuleIds: muted, cooldownUntil, inaccurateCounts };
  };

  return {
    add(entry, now): void {
      db.prepare(
        'INSERT INTO advice_feedback (advice_id, rule_id, action, reason, note, created_at) VALUES (?,?,?,?,?,?)',
      ).run(entry.adviceId, entry.ruleId, entry.action, entry.reason ?? null, entry.note ?? null, now);
    },

    state,

    muteRule(ruleId, now): void {
      db.prepare(
        `INSERT INTO rule_pref (rule_id, muted, updated_at) VALUES (?,1,?)
         ON CONFLICT(rule_id) DO UPDATE SET muted=1, updated_at=excluded.updated_at`,
      ).run(ruleId, now);
    },

    unmuteRule(ruleId): void {
      db.prepare('UPDATE rule_pref SET muted=0 WHERE rule_id=?').run(ruleId);
    },

    mutedRules(): string[] {
      return state().mutedRuleIds;
    },

    inaccurateCounts(): Record<string, number> {
      return state().inaccurateCounts;
    },

    resetInaccurate(ruleId): void {
      db.prepare("DELETE FROM advice_feedback WHERE action='inaccurate' AND rule_id=?").run(ruleId);
    },

    listRecent(limit): Array<FeedbackEntry & { id: number; createdAt: string }> {
      return (
        db.prepare('SELECT * FROM advice_feedback ORDER BY id DESC LIMIT ?').all(limit) as unknown as FeedbackRow[]
      ).map((row) => ({
        id: row.id,
        adviceId: row.advice_id,
        ruleId: row.rule_id,
        action: row.action as FeedbackAction,
        reason: row.reason,
        note: row.note,
        createdAt: row.created_at,
      }));
    },
  };
}

/** 账单变更审计：编辑/删除都留痕，日报快照与账单出现差异时可以回溯。 */
import type { Db } from './database.ts';

export interface AuditEntry {
  billId: string;
  action: 'create' | 'update' | 'delete' | 'restore';
  beforeJson?: string | null;
  afterJson?: string | null;
}

export interface AuditRepo {
  append(entry: AuditEntry, now: string): void;
  listForBill(billId: string, limit: number): Array<AuditEntry & { id: number; createdAt: string }>;
  count(): number;
}

export function createAuditRepo(db: Db): AuditRepo {
  return {
    append(entry, now): void {
      db.prepare('INSERT INTO bill_audit (bill_id, action, before_json, after_json, created_at) VALUES (?,?,?,?,?)').run(
        entry.billId,
        entry.action,
        entry.beforeJson ?? null,
        entry.afterJson ?? null,
        now,
      );
    },

    listForBill(billId, limit): Array<AuditEntry & { id: number; createdAt: string }> {
      const rows = db
        .prepare('SELECT * FROM bill_audit WHERE bill_id=? ORDER BY id DESC LIMIT ?')
        .all(billId, limit) as unknown as Array<{
        id: number;
        bill_id: string;
        action: string;
        before_json: string | null;
        after_json: string | null;
        created_at: string;
      }>;
      return rows.map((row) => ({
        id: row.id,
        billId: row.bill_id,
        action: row.action as AuditEntry['action'],
        beforeJson: row.before_json,
        afterJson: row.after_json,
        createdAt: row.created_at,
      }));
    },

    count(): number {
      const row = db.prepare('SELECT COUNT(*) AS n FROM bill_audit').get() as { n: number };
      return Number(row.n);
    },
  };
}

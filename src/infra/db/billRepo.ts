/** 账单仓储：单机 SQLite，日期查询走 epoch 毫秒，避免不同时区偏移的字符串比较陷阱。 */
import type { Bill, BillStatus, Direction } from '../../domain/types.ts';
import { addDays, dayWindow, zonedStartOfDay } from '../../domain/analysis/period.ts';
import type { Db } from './database.ts';

interface BillRow {
  bill_id: string;
  amount_minor: number;
  currency: string;
  direction: string;
  category_id: string | null;
  occurred_at: string;
  occurred_at_ms: number;
  merchant: string | null;
  account_id: string | null;
  payment_method: string | null;
  note: string | null;
  tags: string | null;
  source: string;
  source_ref: string | null;
  refund_of: string | null;
  status: string;
  recurring_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export function rowToBill(row: BillRow): Bill {
  let tags: string[] = [];
  if (row.tags) {
    try {
      const parsed: unknown = JSON.parse(row.tags);
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      tags = [];
    }
  }
  return {
    billId: row.bill_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    direction: row.direction as Direction,
    categoryId: row.category_id,
    occurredAt: row.occurred_at,
    merchant: row.merchant,
    accountId: row.account_id,
    paymentMethod: row.payment_method,
    tags,
    note: row.note,
    source: row.source as Bill['source'],
    sourceRef: row.source_ref,
    refundOf: row.refund_of,
    status: row.status as BillStatus,
    recurringId: row.recurring_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface BillFilter {
  fromDate?: string;
  toDate?: string;
  timeZone: string;
  direction?: Direction;
  categoryId?: string | null;
  minMinor?: number;
  maxMinor?: number;
  status?: BillStatus[];
  keyword?: string;
  tag?: string;
  source?: string;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

export interface BillRepo {
  insert(bill: Bill): void;
  /** 幂等插入：source_ref 冲突时返回 duplicate，不抛错 */
  insertIfNew(bill: Bill): 'inserted' | 'duplicate';
  getById(billId: string): Bill | null;
  /** 乐观锁更新：版本不匹配返回 false */
  update(next: Bill, expectedVersion: number): boolean;
  softDelete(billId: string, at: string): boolean;
  restore(billId: string): boolean;
  count(includeDeleted?: boolean): number;
  listByLocalDay(date: string, timeZone: string): Bill[];
  listByLocalRange(fromDate: string, toDate: string, timeZone: string): Bill[];
  query(filter: BillFilter): Bill[];
  /** 疑似重复候选：同金额同币种，发生于给定天数窗口内 */
  findSimilar(args: {
    amountMinor: number;
    currency: string;
    occurredAtMs: number;
    timeZone: string;
    windowDays: number;
    merchant?: string | null;
  }): Bill[];
}

function insertSql(): string {
  return `INSERT OR IGNORE INTO bill (
    bill_id, amount_minor, currency, direction, category_id, occurred_at, occurred_at_ms,
    merchant, account_id, payment_method, note, tags, source, source_ref, refund_of,
    status, recurring_id, version, created_at, updated_at, deleted_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
}

function toParams(bill: Bill): Array<string | number | null> {
  return [
    bill.billId,
    bill.amountMinor,
    bill.currency,
    bill.direction,
    bill.categoryId,
    bill.occurredAt,
    Date.parse(bill.occurredAt),
    bill.merchant,
    bill.accountId,
    bill.paymentMethod,
    bill.note,
    JSON.stringify(bill.tags ?? []),
    bill.source,
    bill.sourceRef,
    bill.refundOf,
    bill.status,
    bill.recurringId,
    bill.version,
    bill.createdAt,
    bill.updatedAt,
    bill.deletedAt,
  ];
}

export function createBillRepo(db: Db): BillRepo {
  const listRange = (startMs: number, endMs: number): Bill[] =>
    (db
      .prepare(
        `SELECT * FROM bill WHERE deleted_at IS NULL AND occurred_at_ms >= ? AND occurred_at_ms < ?
         ORDER BY occurred_at_ms ASC, bill_id ASC`,
      )
      .all(startMs, endMs) as unknown as BillRow[]).map(rowToBill);

  return {
    insert(bill: Bill): void {
      db.prepare(insertSql()).run(...toParams(bill));
    },

    insertIfNew(bill: Bill): 'inserted' | 'duplicate' {
      const result = db.prepare(insertSql()).run(...toParams(bill));
      return Number(result.changes) > 0 ? 'inserted' : 'duplicate';
    },

    getById(billId: string): Bill | null {
      const row = db.prepare('SELECT * FROM bill WHERE bill_id = ?').get(billId) as unknown as BillRow | undefined;
      return row ? rowToBill(row) : null;
    },

    update(next: Bill, expectedVersion: number): boolean {
      const result = db
        .prepare(
          `UPDATE bill SET amount_minor=?, currency=?, direction=?, category_id=?, occurred_at=?,
             occurred_at_ms=?, merchant=?, account_id=?, payment_method=?, note=?, tags=?, source=?,
             source_ref=?, refund_of=?, status=?, recurring_id=?, version=version+1, updated_at=?,
             deleted_at=?
           WHERE bill_id=? AND version=?`,
        )
        .run(
          next.amountMinor,
          next.currency,
          next.direction,
          next.categoryId,
          next.occurredAt,
          Date.parse(next.occurredAt),
          next.merchant,
          next.accountId,
          next.paymentMethod,
          next.note,
          JSON.stringify(next.tags ?? []),
          next.source,
          next.sourceRef,
          next.refundOf,
          next.status,
          next.recurringId,
          next.updatedAt,
          next.deletedAt,
          next.billId,
          expectedVersion,
        );
      return Number(result.changes) > 0;
    },

    softDelete(billId: string, at: string): boolean {
      const result = db
        .prepare('UPDATE bill SET deleted_at=?, updated_at=?, version=version+1 WHERE bill_id=? AND deleted_at IS NULL')
        .run(at, at, billId);
      return Number(result.changes) > 0;
    },

    restore(billId: string): boolean {
      const result = db
        .prepare('UPDATE bill SET deleted_at=NULL, version=version+1 WHERE bill_id=? AND deleted_at IS NOT NULL')
        .run(billId);
      return Number(result.changes) > 0;
    },

    count(includeDeleted = false): number {
      const sql = includeDeleted ? 'SELECT COUNT(*) AS n FROM bill' : 'SELECT COUNT(*) AS n FROM bill WHERE deleted_at IS NULL';
      const row = db.prepare(sql).get() as { n: number };
      return Number(row.n);
    },

    listByLocalDay(date: string, timeZone: string): Bill[] {
      const w = dayWindow(date, timeZone);
      return listRange(w.startMs, w.endMs);
    },

    listByLocalRange(fromDate: string, toDate: string, timeZone: string): Bill[] {
      return listRange(zonedStartOfDay(fromDate, timeZone), zonedStartOfDay(addDays(toDate, 1), timeZone));
    },

    query(filter: BillFilter): Bill[] {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (!filter.includeDeleted) where.push('deleted_at IS NULL');
      if (filter.fromDate) {
        where.push('occurred_at_ms >= ?');
        params.push(zonedStartOfDay(filter.fromDate, filter.timeZone));
      }
      if (filter.toDate) {
        where.push('occurred_at_ms < ?');
        params.push(zonedStartOfDay(addDays(filter.toDate, 1), filter.timeZone));
      }
      if (filter.direction) {
        where.push('direction = ?');
        params.push(filter.direction);
      }
      if (filter.categoryId !== undefined) {
        if (filter.categoryId === null) where.push('category_id IS NULL');
        else {
          where.push('category_id = ?');
          params.push(filter.categoryId);
        }
      }
      if (filter.minMinor !== undefined) {
        where.push('amount_minor >= ?');
        params.push(filter.minMinor);
      }
      if (filter.maxMinor !== undefined) {
        where.push('amount_minor <= ?');
        params.push(filter.maxMinor);
      }
      if (filter.status && filter.status.length > 0) {
        where.push(`status IN (${filter.status.map(() => '?').join(',')})`);
        params.push(...filter.status);
      }
      if (filter.source) {
        where.push('source = ?');
        params.push(filter.source);
      }
      if (filter.keyword && filter.keyword.trim() !== '') {
        where.push('(merchant LIKE ? OR note LIKE ? OR tags LIKE ?)');
        const like = `%${filter.keyword.trim()}%`;
        params.push(like, like, like);
      }
      if (filter.tag) {
        where.push('tags LIKE ?');
        params.push(`%"${filter.tag}"%`);
      }
      const sql = `SELECT * FROM bill ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY occurred_at_ms DESC, bill_id DESC LIMIT ? OFFSET ?`;
      params.push(filter.limit ?? 200, filter.offset ?? 0);
      return (db.prepare(sql).all(...params) as unknown as BillRow[]).map(rowToBill);
    },

    findSimilar(args): Bill[] {
      const half = args.windowDays * 24 * 60 * 60 * 1000;
      const rows = db
        .prepare(
          `SELECT * FROM bill
           WHERE deleted_at IS NULL AND currency = ? AND amount_minor = ?
             AND occurred_at_ms BETWEEN ? AND ?
             ${args.merchant ? 'AND merchant = ?' : ''}
           ORDER BY occurred_at_ms`,
        )
        .all(
          ...(args.merchant
            ? [args.currency, args.amountMinor, args.occurredAtMs - half, args.occurredAtMs + half, args.merchant]
            : [args.currency, args.amountMinor, args.occurredAtMs - half, args.occurredAtMs + half]),
        ) as unknown as BillRow[];
      return rows.map(rowToBill);
    },
  };
}

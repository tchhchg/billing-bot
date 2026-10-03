/**
 * 「条目」仓储：账单信息与建议的统一落点。
 *
 * 为什么需要它：账单有 bill 表可逐条列举，但**建议原本只活在日报快照里**，
 * 无法逐条列举、也无法追踪"是否已发到邮箱"。这张表补上这个缺口。
 */
import type { DatabaseSync } from 'node:sqlite';

export type ItemKind = 'bill' | 'advice';
export type ItemStatus = 'pending' | 'sent' | 'failed';
export type ItemSource = 'agent' | 'manual' | 'rules';

export interface AdviceItem {
  itemId: string;
  kind: ItemKind;
  title: string;
  body: string;
  source: ItemSource;
  localDate: string;
  /** 归属存疑（无法判断是账单信息还是建议），待人确认 */
  needsConfirm: boolean;
  status: ItemStatus;
  sentAt: string | null;
  sendError: string | null;
  billId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ItemRow {
  item_id: string;
  kind: string;
  title: string;
  body: string;
  source: string;
  local_date: string;
  needs_confirm: number;
  status: string;
  sent_at: string | null;
  send_error: string | null;
  bill_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToItem(row: ItemRow): AdviceItem {
  return {
    itemId: row.item_id,
    kind: row.kind === 'bill' ? 'bill' : 'advice',
    title: row.title,
    body: row.body,
    source: (row.source === 'manual' || row.source === 'rules' ? row.source : 'agent') as ItemSource,
    localDate: row.local_date,
    needsConfirm: row.needs_confirm !== 0,
    status: (row.status === 'sent' || row.status === 'failed' ? row.status : 'pending') as ItemStatus,
    sentAt: row.sent_at,
    sendError: row.send_error,
    billId: row.bill_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface AdviceItemRepo {
  insert(item: AdviceItem): void;
  getById(itemId: string): AdviceItem | null;
  listRecent(limit: number): AdviceItem[];
  /** 待发 + 发送失败（失败的要重试，所以也算"队列里"） */
  listQueued(): AdviceItem[];
  listByLocalDate(localDate: string): AdviceItem[];
  markSent(itemIds: readonly string[], at: string): void;
  markFailed(itemIds: readonly string[], error: string, at: string): void;
  counts(): { total: number; pending: number; failed: number; sent: number; needsConfirm: number };
}

export function createAdviceItemRepo(db: DatabaseSync): AdviceItemRepo {
  return {
    insert(item) {
      db.prepare(
        `INSERT INTO advice_item (item_id, kind, title, body, source, local_date, needs_confirm, status,
           sent_at, send_error, bill_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        item.itemId,
        item.kind,
        item.title,
        item.body,
        item.source,
        item.localDate,
        item.needsConfirm ? 1 : 0,
        item.status,
        item.sentAt,
        item.sendError,
        item.billId,
        item.createdAt,
        item.updatedAt,
      );
    },

    getById(itemId) {
      const row = db.prepare('SELECT * FROM advice_item WHERE item_id = ?').get(itemId) as ItemRow | undefined;
      return row ? rowToItem(row) : null;
    },

    listRecent(limit) {
      const rows = db
        .prepare('SELECT * FROM advice_item ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .all(limit) as unknown as ItemRow[];
      return rows.map(rowToItem);
    },

    listQueued() {
      const rows = db
        .prepare("SELECT * FROM advice_item WHERE status IN ('pending','failed') ORDER BY created_at ASC")
        .all() as unknown as ItemRow[];
      return rows.map(rowToItem);
    },

    listByLocalDate(localDate) {
      const rows = db
        .prepare('SELECT * FROM advice_item WHERE local_date = ? ORDER BY created_at ASC')
        .all(localDate) as unknown as ItemRow[];
      return rows.map(rowToItem);
    },

    markSent(itemIds, at) {
      const statement = db.prepare("UPDATE advice_item SET status='sent', sent_at=?, send_error=NULL, updated_at=? WHERE item_id=?");
      for (const id of itemIds) statement.run(at, at, id);
    },

    markFailed(itemIds, error, at) {
      const statement = db.prepare("UPDATE advice_item SET status='failed', send_error=?, updated_at=? WHERE item_id=?");
      for (const id of itemIds) statement.run(error, at, id);
    },

    counts() {
      const read = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
      return {
        total: read('SELECT COUNT(*) AS n FROM advice_item'),
        pending: read("SELECT COUNT(*) AS n FROM advice_item WHERE status='pending'"),
        failed: read("SELECT COUNT(*) AS n FROM advice_item WHERE status='failed'"),
        sent: read("SELECT COUNT(*) AS n FROM advice_item WHERE status='sent'"),
        needsConfirm: read('SELECT COUNT(*) AS n FROM advice_item WHERE needs_confirm=1'),
      };
    },
  };
}

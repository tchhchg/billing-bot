/** 导入批次与列映射模板仓储（文件哈希幂等 + 模板复用）。 */
import type { Db } from './database.ts';

export interface ImportBatchRecord {
  batchId: string;
  fileName: string;
  fileSha256: string;
  sourceKind: string;
  mappingJson: string | null;
  okCount: number;
  dupCount: number;
  failCount: number;
  reportJson: string | null;
}

export interface ColumnMapping {
  /** CSV 列名 → 账单字段 */
  columns: Record<string, string>;
  /** 金额单位：major（元）或 minor（分） */
  amountUnit?: 'major' | 'minor';
  /** 文件编码；留空自动探测 */
  encoding?: string;
  /** 表头所在行号（0 起） */
  headerRow?: number;
  /** 需要跳过的行匹配（如"不计收支"） */
  skipPatterns?: string[];
  dateFormat?: string;
}

export interface ImportRepo {
  batchExists(fileSha256: string, sourceKind: string): boolean;
  saveBatch(record: ImportBatchRecord, now: string): void;
  listBatches(limit: number): Array<ImportBatchRecord & { createdAt: string }>;
  saveMapping(args: { sourceKind: string; name: string; mapping: ColumnMapping; now: string }): void;
  getMapping(sourceKind: string, name: string): ColumnMapping | null;
  listMappings(sourceKind?: string): Array<{ sourceKind: string; name: string; mapping: ColumnMapping; lastUsedAt: string }>;
  touchMapping(sourceKind: string, name: string, now: string): void;
  clearBatches(): void;
}

interface BatchRow {
  batch_id: string;
  file_name: string;
  file_sha256: string;
  source_kind: string;
  mapping_json: string | null;
  ok_count: number;
  dup_count: number;
  fail_count: number;
  report_json: string | null;
  created_at: string;
}

export function createImportRepo(db: Db): ImportRepo {
  return {
    batchExists(fileSha256, sourceKind): boolean {
      const row = db
        .prepare('SELECT 1 AS ok FROM import_batch WHERE file_sha256=? AND source_kind=?')
        .get(fileSha256, sourceKind);
      return row !== undefined;
    },

    saveBatch(record, now): void {
      db.prepare(
        `INSERT INTO import_batch (batch_id, file_name, file_sha256, source_kind, mapping_json, ok_count, dup_count, fail_count, report_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(batch_id) DO UPDATE SET ok_count=excluded.ok_count, dup_count=excluded.dup_count, fail_count=excluded.fail_count, report_json=excluded.report_json`,
      ).run(
        record.batchId,
        record.fileName,
        record.fileSha256,
        record.sourceKind,
        record.mappingJson,
        record.okCount,
        record.dupCount,
        record.failCount,
        record.reportJson,
        now,
      );
    },

    listBatches(limit): Array<ImportBatchRecord & { createdAt: string }> {
      const rows = db.prepare('SELECT * FROM import_batch ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as BatchRow[];
      return rows.map((row) => ({
        batchId: row.batch_id,
        fileName: row.file_name,
        fileSha256: row.file_sha256,
        sourceKind: row.source_kind,
        mappingJson: row.mapping_json,
        okCount: row.ok_count,
        dupCount: row.dup_count,
        failCount: row.fail_count,
        reportJson: row.report_json,
        createdAt: row.created_at,
      }));
    },

    saveMapping(args): void {
      db.prepare(
        `INSERT INTO csv_mapping (source_kind, name, mapping_json, created_at, last_used_at) VALUES (?,?,?,?,?)
         ON CONFLICT(source_kind, name) DO UPDATE SET mapping_json=excluded.mapping_json, last_used_at=excluded.last_used_at`,
      ).run(args.sourceKind, args.name, JSON.stringify(args.mapping), args.now, args.now);
    },

    getMapping(sourceKind, name): ColumnMapping | null {
      const row = db
        .prepare('SELECT mapping_json FROM csv_mapping WHERE source_kind=? AND name=?')
        .get(sourceKind, name) as { mapping_json: string } | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.mapping_json) as ColumnMapping;
      } catch {
        return null;
      }
    },

    listMappings(sourceKind): Array<{ sourceKind: string; name: string; mapping: ColumnMapping; lastUsedAt: string }> {
      const rows = (
        sourceKind
          ? db.prepare('SELECT * FROM csv_mapping WHERE source_kind=? ORDER BY last_used_at DESC').all(sourceKind)
          : db.prepare('SELECT * FROM csv_mapping ORDER BY last_used_at DESC').all()
      ) as unknown as Array<{ source_kind: string; name: string; mapping_json: string; last_used_at: string }>;
      const out: Array<{ sourceKind: string; name: string; mapping: ColumnMapping; lastUsedAt: string }> = [];
      for (const row of rows) {
        try {
          out.push({
            sourceKind: row.source_kind,
            name: row.name,
            mapping: JSON.parse(row.mapping_json) as ColumnMapping,
            lastUsedAt: row.last_used_at,
          });
        } catch {
          // 坏模板直接跳过，不阻塞列表
        }
      }
      return out;
    },

    touchMapping(sourceKind, name, now): void {
      db.prepare('UPDATE csv_mapping SET last_used_at=? WHERE source_kind=? AND name=?').run(now, sourceKind, name);
    },

    clearBatches(): void {
      db.prepare('DELETE FROM import_batch').run();
    },
  };
}

/**
 * 导入用例：文件 → 识别来源 → 列映射 → 校验 → 幂等入库 → 导入报告。
 *
 * 幂等有三层：
 *  1. 文件级：SHA-256（同文件二次导入直接拦截）
 *  2. 行级：source_ref 唯一键（同一笔交易重复出现在不同导出区间时不会重复入库）
 *  3. 兜底：文件没有单号时，用「来源+行号+文件哈希」合成稳定键
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Bill } from '../domain/types.ts';
import { validateBill, type BillInput } from '../domain/bill.ts';
import { toMinor, isValidCurrency } from '../domain/money.ts';
import { parseBillTimestamp } from '../domain/analysis/period.ts';
import { UNLINKED_REFUND } from '../domain/analysis/refund.ts';
import { categoryName } from '../domain/category.ts';
import type { BillRepo } from '../infra/db/billRepo.ts';
import type { CategoryRepo } from '../infra/db/categoryRepo.ts';
import type { ColumnMapping, ImportRepo } from '../infra/db/importRepo.ts';
import { decodeBuffer, parseCsv, tableFromCsv, type CsvTable } from '../infra/importer/csv.ts';
import {
  defaultMappingFor,
  detectSourceKind,
  guessHeaderRow,
  mapRows,
  SOURCE_LABELS,
  type SourceKind,
} from '../infra/importer/mapping.ts';
import type { AnalysisConfig } from '../domain/types.ts';

export interface ImportDeps {
  bills: BillRepo;
  categories: CategoryRepo;
  imports: ImportRepo;
}

export interface ImportArgs {
  fileName: string;
  content: Uint8Array;
  /** 用户指定的来源；不填则自动识别 */
  sourceKind?: SourceKind;
  /** 用户确认/调整过的列映射 */
  mapping?: ColumnMapping;
  /** 已保存的映射模板名 */
  mappingName?: string;
  /** 用户手动指定表头行（0 起）；不填则自动探测 */
  headerRow?: number;
  /** 用户的基础币种，用于文件里没有币种列时兜底 */
  baseCurrency: string;
  timeZone: string;
  analysis: Pick<AnalysisConfig, 'futureDateToleranceDays'>;
  now?: Date;
  /** 疑似重复（同金额同商户同日）是否仍然入库；默认入库并在报告里列出 */
  insertSuspectedDuplicates?: boolean;
}

export type RowStatus = 'inserted' | 'duplicate' | 'skipped' | 'failed' | 'suspected';

export interface RowOutcome {
  rowNumber: number;
  status: RowStatus;
  reason?: string;
  billId?: string;
  merchant?: string | null;
  amountText?: string;
}

export interface ImportReport {
  fileSha256: string;
  fileName: string;
  sourceKind: SourceKind;
  sourceLabel: string;
  encoding: string;
  headerRow: number;
  preamble: string[];
  /** 识别用的列映射（用户可拿去改） */
  mapping: ColumnMapping;
  okCount: number;
  dupCount: number;
  skippedCount: number;
  failedCount: number;
  suspectedCount: number;
  rows: RowOutcome[];
  alreadyImported: boolean;
  batchId: string;
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function failureReasons(issues: Array<{ message: string }>): string {
  return issues.map((i) => i.message).join('；');
}

export function importBillFile(deps: ImportDeps, args: ImportArgs): ImportReport {
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();
  const hash = sha256(args.content);
  const decoded = decodeBuffer(args.content, args.mapping?.encoding);

  // 表头行：用户指定 > 模板记录 > 自动探测。
  // ⚠️ 必须用 parseCsv 的结果来探测：CSV 解析**会丢弃空行**，若拿"按行硬切"的下标去猜表头，
  // 遇到前导带空行的文件（支付宝的回单就是）就会整体错位，后果是整份文件被判为"金额无法识别"而全部跳过。
  const headerRow =
    args.headerRow ??
    args.mapping?.headerRow ??
    guessHeaderRow(parseCsv(decoded.text), args.sourceKind ?? 'auto');
  const table: CsvTable = tableFromCsv(decoded.text, headerRow);

  const sourceKind = args.sourceKind ?? detectSourceKind(table.headers, decoded.text);
  const saved = args.mappingName ? deps.imports.getMapping(sourceKind, args.mappingName) : null;
  const mapping: ColumnMapping = args.mapping ?? saved ?? defaultMappingFor(sourceKind, table.headers);

  const batchId = randomUUID();
  if (deps.imports.batchExists(hash, sourceKind)) {
    return {
      fileSha256: hash,
      fileName: args.fileName,
      sourceKind,
      sourceLabel: SOURCE_LABELS[sourceKind],
      encoding: decoded.encoding,
      headerRow: table.headerRow,
      preamble: table.preamble,
      mapping,
      okCount: 0,
      dupCount: 0,
      skippedCount: 0,
      failedCount: 0,
      suspectedCount: 0,
      rows: [],
      alreadyImported: true,
      batchId,
    };
  }

  const categories = deps.categories.list();
  const categoryByName = new Map<string, string>();
  for (const c of categories) {
    categoryByName.set(c.name, c.categoryId);
    categoryByName.set(c.categoryId, c.categoryId);
  }
  const knownCategoryIds = categories.map((c) => c.categoryId);

  const mapped = mapRows(table, mapping);
  const rows: RowOutcome[] = [];
  let okCount = 0;
  let dupCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let suspectedCount = 0;

  for (const row of mapped) {
    if (row.skipped) {
      skippedCount += 1;
      rows.push({ rowNumber: row.rowNumber, status: 'skipped', reason: row.reason });
      continue;
    }
    if (!row.ok || !row.fields) {
      failedCount += 1;
      rows.push({ rowNumber: row.rowNumber, status: 'failed', reason: row.reason });
      continue;
    }
    const f = row.fields;
    const occurredAt = parseBillTimestamp(f.occurredAt ?? '', args.timeZone);
    if (!occurredAt) {
      failedCount += 1;
      rows.push({
        rowNumber: row.rowNumber,
        status: 'failed',
        reason: `交易时间无法解析：${f.occurredAt ?? '(空)'}`,
        amountText: f.amountText,
      });
      continue;
    }

    const currency =
      f.currency && isValidCurrency(f.currency.toUpperCase()) ? f.currency.toUpperCase() : args.baseCurrency;
    const amountMinor = toMinor(f.amountMinorRaw ?? 0, currency);

    // 退款：文件里没有指向原消费的字段，用哨兵值表达"未关联原单的退款"
    const isRefund = f.isRefund === true && f.direction === 'income';
    const direction: Bill['direction'] = f.direction ?? 'expense';

    const categoryId = f.categoryHint ? categoryByName.get(f.categoryHint) ?? null : null;

    const input: BillInput = {
      billId: randomUUID(),
      amountMinor,
      currency,
      direction,
      categoryId,
      occurredAt,
      merchant: f.merchant ?? null,
      paymentMethod: f.paymentMethod ?? null,
      note: f.note ?? null,
      source: 'import',
      sourceRef: f.sourceRef && f.sourceRef !== '' ? f.sourceRef : `${sourceKind}:${hash.slice(0, 8)}:${row.rowNumber}`,
      refundOf: isRefund ? UNLINKED_REFUND : null,
      status: 'normal',
      tags: [],
    };

    const validation = validateBill(input, {
      analysis: args.analysis,
      now: nowIso,
      knownCategoryIds,
    });
    if (!validation.ok || !validation.bill) {
      failedCount += 1;
      rows.push({
        rowNumber: row.rowNumber,
        status: 'failed',
        reason: failureReasons(validation.hardIssues),
        merchant: f.merchant,
        amountText: f.amountText,
      });
      continue;
    }

    const bill = validation.bill;
    const occurredMs = Date.parse(bill.occurredAt);
    const similar = deps.bills.findSimilar({
      amountMinor,
      currency,
      occurredAtMs: occurredMs,
      timeZone: args.timeZone,
      windowDays: 1,
      merchant: bill.merchant,
    });
    const isSuspected = similar.length > 0;

    if (isSuspected) {
      suspectedCount += 1;
      if (args.insertSuspectedDuplicates === false) {
        rows.push({
          rowNumber: row.rowNumber,
          status: 'suspected',
          reason: '与已有账单疑似重复（同金额同商户同日），已按设置跳过',
          merchant: bill.merchant,
          amountText: f.amountText,
        });
        continue;
      }
    }

    const result = deps.bills.insertIfNew(bill);
    if (result === 'duplicate') {
      dupCount += 1;
      rows.push({
        rowNumber: row.rowNumber,
        status: 'duplicate',
        reason: `交易单号已存在（${bill.sourceRef ?? ''}）`,
        merchant: bill.merchant,
        amountText: f.amountText,
      });
      continue;
    }

    okCount += 1;
    rows.push({
      rowNumber: row.rowNumber,
      status: isSuspected ? 'suspected' : 'inserted',
      reason: isSuspected ? '疑似重复，已入库待确认' : undefined,
      billId: bill.billId,
      merchant: bill.merchant,
      amountText: f.amountText,
    });
  }

  const report: ImportReport = {
    fileSha256: hash,
    fileName: args.fileName,
    sourceKind,
    sourceLabel: SOURCE_LABELS[sourceKind],
    encoding: decoded.encoding,
    headerRow: table.headerRow,
    preamble: table.preamble,
    mapping,
    okCount,
    dupCount,
    skippedCount,
    failedCount,
    suspectedCount,
    rows,
    alreadyImported: false,
    batchId,
  };

  deps.imports.saveBatch(
    {
      batchId,
      fileName: args.fileName,
      fileSha256: hash,
      sourceKind,
      mappingJson: JSON.stringify(mapping),
      okCount,
      dupCount,
      failCount: failedCount,
      reportJson: JSON.stringify({ ...report, rows: rows.slice(0, 50) }),
    },
    nowIso,
  );

  if (args.mappingName) deps.imports.touchMapping(sourceKind, args.mappingName, nowIso);
  void categoryName;

  return report;
}

/** 只做"预演"：不写库，用于界面上让用户先确认列映射 */
export function previewImport(args: {
  content: Uint8Array;
  baseCurrency: string;
  sourceKind?: SourceKind;
  mapping?: ColumnMapping;
  headerRow?: number;
}): { sourceKind: SourceKind; headers: string[]; mapping: ColumnMapping; sampleRows: Array<Record<string, string>>; preamble: string[]; encoding: string; headerRow: number } {
  const decoded = decodeBuffer(args.content, args.mapping?.encoding);
  const headerRow = args.headerRow ?? guessHeaderRow(parseCsv(decoded.text), args.sourceKind ?? 'auto');
  const table = tableFromCsv(decoded.text, headerRow);
  const sourceKind = args.sourceKind ?? detectSourceKind(table.headers, decoded.text);
  const mapping = args.mapping ?? defaultMappingFor(sourceKind, table.headers);
  const mapped = mapRows(table, mapping);
  return {
    sourceKind,
    headers: table.headers,
    mapping,
    sampleRows: mapped.slice(0, 5).map((r) => r.raw),
    preamble: table.preamble,
    encoding: decoded.encoding,
    headerRow: table.headerRow,
  };
}

/**
 * 列映射：把平台导出的列名映射到账单字段。
 *
 * 平台格式会变，所以这里的原则是「能自动认就自动认，认不出就让用户配一次并保存模板」，
 * 而不是把某一版列名写死。
 */
import type { ColumnMapping } from '../db/importRepo.ts';
import type { CsvTable } from './csv.ts';
import { rowsToObjects } from './csv.ts';

export type SourceKind = 'alipay' | 'wechat' | 'bank' | 'generic';

export const SOURCE_LABELS: Record<SourceKind, string> = {
  alipay: '支付宝',
  wechat: '微信支付',
  bank: '银行卡',
  generic: '通用 CSV',
};

/** 账单字段（映射模板的目标） */
export const CANONICAL_TARGETS = [
  'occurredAt',
  'amount',
  'direction',
  'merchant',
  'paymentMethod',
  'note',
  'sourceRef',
  'currency',
  'category',
  'transactionType',
] as const;

export type CanonicalTarget = (typeof CANONICAL_TARGETS)[number];

/** 各来源的列名候选（按优先级），用于自动识别与生成默认模板 */
const HEADER_HINTS: Record<SourceKind, Partial<Record<CanonicalTarget, string[]>>> = {
  alipay: {
    occurredAt: ['交易时间', '交易创建时间'],
    amount: ['金额', '金额（元）', '金额(元)'],
    direction: ['收/支', '收支'],
    merchant: ['交易对方', '对方'],
    paymentMethod: ['收/付款方式', '付款方式'],
    note: ['商品说明', '商品名称', '备注'],
    sourceRef: ['交易订单号', '订单号'],
    category: ['交易分类'],
    transactionType: ['交易分类', '交易类型'],
  },
  wechat: {
    occurredAt: ['交易时间', '交易创建时间'],
    amount: ['金额(元)', '金额（元）', '金额'],
    direction: ['收/支', '收支'],
    merchant: ['交易对方', '对方'],
    paymentMethod: ['支付方式', '付款方式'],
    note: ['商品', '商品说明'],
    sourceRef: ['交易单号', '交易订单号', '订单号'],
    category: ['交易类型'],
    transactionType: ['交易类型'],
  },
  bank: {
    occurredAt: ['交易日期', '交易时间', '记账日期', '日期'],
    amount: ['交易金额', '金额', '发生额'],
    direction: ['收/支', '借贷标志', '收支'],
    merchant: ['交易对方', '对方户名', '摘要', '交易摘要'],
    paymentMethod: ['交易渠道', '渠道'],
    note: ['摘要', '备注', '交易说明'],
    sourceRef: ['交易流水号', '流水号', '凭证号'],
    currency: ['币种', '货币'],
  },
  generic: {},
};

/** 在表头里找第一个存在的候选列 */
function pick(headers: readonly string[], candidates: readonly string[] | undefined): string | null {
  if (!candidates) return null;
  for (const candidate of candidates) {
    const hit = headers.find((h) => h === candidate);
    if (hit) return hit;
  }
  for (const candidate of candidates) {
    const hit = headers.find((h) => h.includes(candidate));
    if (hit) return hit;
  }
  return null;
}

export function defaultMappingFor(kind: SourceKind, headers: readonly string[]): ColumnMapping {
  const columns: Record<string, string> = {};
  const hints = HEADER_HINTS[kind];
  for (const target of CANONICAL_TARGETS) {
    const header = pick(headers, hints[target]);
    if (header) columns[header] = target;
  }
  return {
    columns,
    amountUnit: 'major',
    encoding: undefined,
    headerRow: 0,
    // 只对「收/支」「交易类型」两列做跳过匹配，绝不对整行做——
    // 否则日期里的 "/" 之类字符会造成大面积误跳过。
    // 「交易关闭」是取消掉的订单——算进支出会让总额虚高（实测某 3 个月账单里虚高 ¥333.79）
  skipPatterns: ['不计收支', '亲密付', '交易关闭', '已关闭'],
  };
}

/** 表头识别：前 8 行里"命中已知列名最多"的那一行 */
export function guessHeaderRow(rows: readonly string[][], kind: SourceKind | 'auto' = 'auto'): number {
  const kinds: SourceKind[] = kind === 'auto' ? ['alipay', 'wechat', 'bank'] : [kind];
  let best = { row: 0, score: 0 };
  let weak = { row: 0, score: 0 };
  // 前导说明可能很长：支付宝的"电子客户回单"有 20+ 行（导出信息 + 特别提示）才到真正的表头，
  // 只扫前 8 行必然看不到它——那正是"整份文件全被跳过"的根因。
  for (let i = 0; i < Math.min(rows.length, 80); i += 1) {
    const headers = (rows[i] ?? []).map((h) => h.trim());
    if (headers.length < 3) continue; // 少于 3 列的不可能是账单表头
    let score = 0;
    for (const k of kinds) {
      for (const candidates of Object.values(HEADER_HINTS[k])) {
        if (pick(headers, candidates)) score += 1;
      }
    }
    if (score > weak.score) weak = { row: i, score };
    if (score > best.score) best = { row: i, score };
  }
  // 认出 3 列以上才算"像表头"（避免把某一行数据当表头）；否则退回宽松判断，最后才用第 0 行
  if (best.score >= 3) return best.row;
  return weak.score > 0 ? weak.row : 0;
}

export function detectSourceKind(headers: readonly string[], rawText = ''): SourceKind {
  const score: Record<SourceKind, number> = { alipay: 0, wechat: 0, bank: 0, generic: 0 };
  for (const kind of ['alipay', 'wechat', 'bank'] as const) {
    for (const candidates of Object.values(HEADER_HINTS[kind])) {
      if (pick(headers, candidates)) score[kind] += 1;
    }
  }
  // 特征列最能区分：微信有「当前状态」，支付宝有「交易订单号 / 收/付款方式」
  const has = (h: string): boolean => headers.some((x) => x.includes(h));
  if (has('当前状态') || has('微信')) score.wechat += 3;
  if (has('收/付款方式') || has('支付宝') || has('交易订单号')) score.alipay += 3;
  if (has('借贷标志') || has('对方户名') || has('交易流水号')) score.bank += 2;
  if (/支付宝/.test(rawText.slice(0, 2000))) score.alipay += 2;
  if (/微信/.test(rawText.slice(0, 2000))) score.wechat += 2;

  let bestKind: SourceKind = 'generic';
  let bestScore = 0;
  for (const kind of ['alipay', 'wechat', 'bank'] as const) {
    if (score[kind] > bestScore) {
      bestKind = kind;
      bestScore = score[kind];
    }
  }
  return bestScore >= 2 ? bestKind : 'generic';
}

/** "¥1,234.56" / "1234.56" / "-1,234" → 数值；非法返回 null */
export function parseAmountText(text: string): number | null {
  if (text === null || text === undefined) return null;
  const cleaned = text.replace(/[¥￥$,\s]/g, '').replace(/元$/, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '/' || cleaned === '--') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export type DirectionHint = 'expense' | 'income' | 'skip';

export function parseDirectionText(text: string): DirectionHint {
  const value = text.trim();
  if (value === '' || value === '/' || value === '不计收支') return 'skip';
  // 银行对账单常用「借/贷」标志，且往往只有「借」一个字
  if (value === '借' || value === '借记' || value === 'D') return 'expense';
  if (value === '贷' || value === '贷记' || value === 'C') return 'income';
  if (value.includes('支出') || value === '支' || value.toLowerCase() === 'debit') return 'expense';
  if (value.includes('收入') || value === '收' || value.toLowerCase() === 'credit') return 'income';
  return 'skip';
}

export interface MappedRow {
  /** 源文件行号（用于导入报告定位） */
  rowNumber: number;
  ok: boolean;
  skipped: boolean;
  reason?: string;
  raw: Record<string, string>;
  fields?: {
    occurredAt?: string;
    amountText?: string;
    amountMinorRaw?: number;
    direction?: 'expense' | 'income' | 'transfer';
    merchant?: string | null;
    paymentMethod?: string | null;
    note?: string | null;
    sourceRef?: string | null;
    currency?: string;
    categoryHint?: string | null;
    isRefund?: boolean;
  };
}

/**
 * 应用列映射。只做"这一行能不能变成账单"的判断，
 * 真正的入库校验交给 domain 的 validateBill（单一真相）。
 */
export function mapRows(table: CsvTable, mapping: ColumnMapping): MappedRow[] {
  const objects = rowsToObjects(table);
  const targetByHeader = mapping.columns;
  const skipPatterns = mapping.skipPatterns ?? [];
  const hasDirectionColumn = Object.values(targetByHeader).includes('direction');
  const out: MappedRow[] = [];

  objects.forEach((raw, index) => {
    const rowNumber = table.rowNumbers[index] ?? index + 2;
    const pickValue = (target: CanonicalTarget): string => {
      for (const [header, mapped] of Object.entries(targetByHeader)) {
        if (mapped === target) {
          const value = raw[header];
          if (value !== undefined) return value;
        }
      }
      return '';
    };

    const joined = `${pickValue('direction')} ${pickValue('transactionType')}`;
    const matchedSkip = skipPatterns.find((p) => p.trim() !== '' && joined.includes(p));
    if (matchedSkip) {
      out.push({ rowNumber, ok: false, skipped: true, reason: `命中跳过规则「${matchedSkip}」`, raw });
      return;
    }

    const amountText = pickValue('amount');
    const amount = parseAmountText(amountText);
    if (amount === null) {
      out.push({ rowNumber, ok: false, skipped: true, reason: `金额无法识别：${amountText || '(空)'}`, raw });
      return;
    }

    const directionText = pickValue('direction');
    // 文件里根本没有「收/支」列时（很多银行导出就是这样），默认按支出处理，
    // 否则会把整个文件当成"不计收支"全部跳过。
    const hint: DirectionHint = hasDirectionColumn ? parseDirectionText(directionText) : 'expense';
    if (hint === 'skip') {
      out.push({
        rowNumber,
        ok: false,
        skipped: true,
        reason: `收/支为「${directionText || '(空)'}」，不计入支出统计`,
        raw,
      });
      return;
    }

    const occurredAt = pickValue('occurredAt');
    if (occurredAt === '') {
      out.push({ rowNumber, ok: false, skipped: false, reason: '缺少交易时间', raw });
      return;
    }

    const typeText = pickValue('transactionType');
    const isRefund = /退款|退回|撤销/.test(`${typeText} ${pickValue('note')}`);

    out.push({
      rowNumber,
      ok: true,
      skipped: false,
      raw,
      fields: {
        occurredAt,
        amountText,
        amountMinorRaw: amount,
        direction: hint === 'income' ? 'income' : 'expense',
        merchant: pickValue('merchant') || null,
        paymentMethod: pickValue('paymentMethod') || null,
        note: pickValue('note') || null,
        sourceRef: pickValue('sourceRef') || null,
        currency: pickValue('currency') || undefined,
        categoryHint: pickValue('category') || null,
        isRefund,
      },
    });
  });

  return out;
}

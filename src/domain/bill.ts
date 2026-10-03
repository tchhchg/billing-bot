/**
 * 账单校验：硬校验（拒绝入库）与软校验（收下并标记待补充）分离。
 */
import { isValidCurrency, isSafeMinor } from './money.ts';
import type { AnalysisConfig, Bill, Direction, Issue, ValidationOutcome } from './types.ts';

const DIRECTIONS: readonly Direction[] = ['expense', 'income', 'transfer'];
const SOURCES: readonly string[] = ['manual', 'import', 'api'];
const STATUSES: readonly string[] = ['normal', 'pending_review', 'void'];
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export type BillInput = Partial<Omit<Bill, 'billId' | 'createdAt' | 'updatedAt'>> & {
  billId?: string;
  createdAt?: string;
  updatedAt?: string;
};

export interface ValidateOptions {
  analysis: Pick<AnalysisConfig, 'futureDateToleranceDays'>;
  /** 注入“现在”，便于测试 */
  now?: string;
  /** 分类表；未提供时视为分类有效（不产生未分类软问题） */
  knownCategoryIds?: readonly string[];
}

function issue(field: string, code: string, message: string, severity: 'hard' | 'soft'): Issue {
  return { field, code, message, severity };
}

export function validateBill(input: BillInput, options: ValidateOptions): ValidationOutcome {
  const hard: Issue[] = [];
  const soft: Issue[] = [];
  const now = options.now ? new Date(options.now).getTime() : Date.now();

  // ---- 硬校验 ----
  const amount = input.amountMinor;
  if (amount === undefined || amount === null) {
    hard.push(issue('amountMinor', 'required', '金额必填', 'hard'));
  } else if (!Number.isInteger(amount) || !isSafeMinor(amount) || amount <= 0) {
    hard.push(issue('amountMinor', 'invalid', '金额必须为大于 0 的最小货币单位整数', 'hard'));
  }

  const currency = input.currency;
  if (!currency) {
    hard.push(issue('currency', 'required', '币种必填', 'hard'));
  } else if (!isValidCurrency(currency)) {
    hard.push(issue('currency', 'invalid', `币种必须是 ISO-4217 三字母大写代码：${currency}`, 'hard'));
  }

  const direction = input.direction ?? 'expense';
  if (!DIRECTIONS.includes(direction)) {
    hard.push(issue('direction', 'invalid', `收支方向非法：${String(direction)}`, 'hard'));
  }

  const occurredAt = input.occurredAt;
  let occurredMs: number | null = null;
  if (!occurredAt) {
    hard.push(issue('occurredAt', 'required', '日期必填', 'hard'));
  } else if (!ISO_RE.test(occurredAt)) {
    hard.push(issue('occurredAt', 'invalid', `日期格式非法（需 ISO8601 且带时区）：${occurredAt}`, 'hard'));
  } else {
    occurredMs = new Date(occurredAt).getTime();
    if (Number.isNaN(occurredMs)) {
      hard.push(issue('occurredAt', 'invalid', `无法解析日期：${occurredAt}`, 'hard'));
    }
  }

  const source = input.source ?? 'manual';
  if (!SOURCES.includes(source)) {
    hard.push(issue('source', 'invalid', `来源非法：${String(source)}`, 'hard'));
  }

  const status = input.status ?? 'normal';
  if (!STATUSES.includes(status)) {
    hard.push(issue('status', 'invalid', `状态非法：${String(status)}`, 'hard'));
  }

  // 未来日期：容差内放行，超出容差硬拒绝
  let futureDate = false;
  if (occurredMs !== null) {
    const toleranceMs = Math.max(0, options.analysis.futureDateToleranceDays) * 24 * 60 * 60 * 1000;
    if (occurredMs > now + toleranceMs) {
      futureDate = true;
      hard.push(
        issue(
          'occurredAt',
          'future_date',
          `日期晚于今天超过 ${options.analysis.futureDateToleranceDays} 天，请确认`,
          'hard',
        ),
      );
    }
  }

  // ---- 软校验 ----
  if (!input.categoryId) {
    soft.push(issue('categoryId', 'missing', '未分类，已进入待补充队列', 'soft'));
  } else if (options.knownCategoryIds && !options.knownCategoryIds.includes(input.categoryId)) {
    soft.push(issue('categoryId', 'unknown', `分类不存在：${input.categoryId}`, 'soft'));
  }
  if (!input.merchant && direction === 'expense') {
    soft.push(issue('merchant', 'missing', '缺少商户信息（不影响统计）', 'soft'));
  }
  if (input.refundOf && direction === 'transfer') {
    soft.push(issue('refundOf', 'conflict', '转账不应同时是退款', 'soft'));
  }

  if (hard.length > 0) {
    return { ok: false, bill: null, hardIssues: hard, softIssues: soft, needsReview: false };
  }

  const needsReview = soft.some((i) => i.code === 'missing' && i.field === 'categoryId') || futureDate;
  const bill: Bill = {
    billId: input.billId ?? '',
    amountMinor: amount as number,
    currency: currency as string,
    direction,
    categoryId: input.categoryId ?? null,
    occurredAt: occurredAt as string,
    merchant: input.merchant ?? null,
    accountId: input.accountId ?? null,
    paymentMethod: input.paymentMethod ?? null,
    tags: input.tags ?? [],
    note: input.note ?? null,
    source: source as Bill['source'],
    sourceRef: input.sourceRef ?? null,
    refundOf: input.refundOf ?? null,
    status: needsReview && status === 'normal' ? 'pending_review' : status,
    recurringId: input.recurringId ?? null,
    version: input.version ?? 1,
    createdAt: input.createdAt ?? new Date(now).toISOString(),
    updatedAt: input.updatedAt ?? new Date(now).toISOString(),
    deletedAt: input.deletedAt ?? null,
  };

  return { ok: true, bill, hardIssues: [], softIssues: soft, needsReview };
}

/** 导出给导入层复用的格式常量 */
export const BILL_ISO_RE = ISO_RE;

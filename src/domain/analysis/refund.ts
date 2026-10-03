/**
 * 归一化：把账单转换成“归属到某一天、带正负号”的金额，口径在这里落地。
 *
 * 退款口径：
 *   A 冲减原单日  —— 退款归属到原单发生日（找不到原单则退回自身日期）
 *   B 冲减退款当日 —— 退款归属到退款自身发生日（**本方案默认**，历史日报永不被改写）
 *   C 不计入      —— 退款整体丢弃
 *
 * 计入范围：direction=expense 与退款；transfer / income 不计入支出净额。
 * status=void 或已软删的账单不参与任何统计。
 * status=pending_review 仍计入总额（钱确实花了），但标记 needsReview，
 * 只影响“分类占比结论”与数据质量提示，避免日报少算支出。
 */
import type { AttributedAmount, Bill, Config } from '../types.ts';
import { localDateOf } from './period.ts';

/**
 * 导入的退款常常找不到原单（账单文件里没有指向原始消费的字段）。
 * 用这个哨兵值表示"确认是退款，但未关联原单"：
 *  - 口径 B：落到退款发生日
 *  - 口径 A：找不到原单时退回退款自身日期
 *  - 口径 C：整体丢弃
 * 因此导入的退款与手工关联的退款在统计上完全一致。
 */
export const UNLINKED_REFUND = 'unlinked';

export function isWhitelistedFixedExpense(bill: Bill, whitelist: readonly string[]): boolean {
  if (whitelist.length === 0) return false;
  const hay = `${bill.merchant ?? ''} ${bill.categoryId ?? ''}`.toLowerCase();
  return whitelist.some((w) => {
    const needle = w.trim().toLowerCase();
    return needle !== '' && hay.includes(needle);
  });
}

function isCounted(bill: Bill): boolean {
  return bill.deletedAt === null && bill.status !== 'void';
}

export function normalizeBills(bills: readonly Bill[], cfg: Config, timeZone: string = cfg.push.timezone): AttributedAmount[] {
  const byId = new Map(bills.map((b) => [b.billId, b]));
  const out: AttributedAmount[] = [];
  const policy = cfg.analysis.refundPolicy;

  for (const bill of bills) {
    if (!isCounted(bill)) continue;

    const ownDate = localDateOf(bill.occurredAt, timeZone);
    const needsReview = bill.status === 'pending_review' || !bill.categoryId;
    const fixed = isWhitelistedFixedExpense(bill, cfg.analysis.fixedExpenseWhitelist);

    // 退款：refundOf 非空即视为退款，符号为负
    if (bill.refundOf !== null) {
      if (policy === 'C') continue;
      let attributedDate = ownDate;
      if (policy === 'A') {
        const original = byId.get(bill.refundOf);
        if (original) attributedDate = localDateOf(original.occurredAt, timeZone);
      }
      out.push({
        billId: bill.billId,
        amountMinor: bill.amountMinor,
        sign: -1,
        currency: bill.currency,
        localDate: attributedDate,
        categoryId: bill.categoryId,
        merchant: bill.merchant,
        kind: 'refund',
        isFixedExpense: fixed,
        needsReview,
      });
      continue;
    }

    if (bill.direction === 'transfer') {
      out.push({
        billId: bill.billId,
        amountMinor: bill.amountMinor,
        sign: 1,
        currency: bill.currency,
        localDate: ownDate,
        categoryId: bill.categoryId,
        merchant: bill.merchant,
        kind: 'transfer',
        isFixedExpense: fixed,
        needsReview,
      });
      continue;
    }

    if (bill.direction === 'income') {
      out.push({
        billId: bill.billId,
        amountMinor: bill.amountMinor,
        sign: 1,
        currency: bill.currency,
        localDate: ownDate,
        categoryId: bill.categoryId,
        merchant: bill.merchant,
        kind: 'income',
        isFixedExpense: fixed,
        needsReview,
      });
      continue;
    }

    out.push({
      billId: bill.billId,
      amountMinor: bill.amountMinor,
      sign: 1,
      currency: bill.currency,
      localDate: ownDate,
      categoryId: bill.categoryId,
      merchant: bill.merchant,
      kind: 'expense',
      isFixedExpense: fixed,
      needsReview,
    });
  }

  return out;
}

/** 只有支出与退款参与“支出净额”口径 */
export function isExpenseLike(amount: AttributedAmount): boolean {
  return amount.kind === 'expense' || amount.kind === 'refund';
}

export function forLocalDate(amounts: readonly AttributedAmount[], localDate: string): AttributedAmount[] {
  return amounts.filter((a) => a.localDate === localDate && isExpenseLike(a));
}

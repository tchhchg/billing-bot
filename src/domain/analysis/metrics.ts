/**
 * 当日指标计算。
 *
 * 关键约束：
 *  - 所有派生统计量都建立在“同一币种”之上；一旦存在缺汇率的条目，
 *    netConvertedTotalMinor / anomalyEligibleTotalMinor 返回 **null**，
 *    依赖单一总额的规则自动跳过（绝不给出误导性的跨币种合计）。
 *  - 固定支出白名单里的条目**计入总额**，但从异常检测口径中剔除。
 */
import type {
  AttributedAmount,
  CategorySlice,
  DayMetrics,
  ExpenseValue,
  MoneyConfig,
} from '../types.ts';
import { sumMinor } from '../money.ts';
import { applyFx, type FxLookup } from './fx.ts';
import { isExpenseLike } from './refund.ts';
import { maxMinor, meanMinor, medianMinor } from './stats.ts';

export interface ComputeMetricsArgs {
  localDate: string;
  /** 已归一化（口径已落地）的全部归属金额 */
  attributed: readonly AttributedAmount[];
  money: MoneyConfig;
  lookup?: FxLookup;
}

export function computeMetrics(args: ComputeMetricsArgs): DayMetrics {
  const { localDate, attributed, money, lookup } = args;
  const entries = attributed.filter((a) => a.localDate === localDate && isExpenseLike(a));
  const fx = applyFx(entries, money, lookup);

  const fullyConverted = fx.amounts.every((a) => a.convertedMinor !== null);
  const statsCurrency = money.baseCurrency;

  const signedValues: number[] = [];
  const expenses: ExpenseValue[] = [];
  const categoryTotals: Record<string, number> = {};
  let uncategorizedMinor = 0;
  let fixedExpenseMinor = 0;
  let fixedExpenseCount = 0;
  let expenseCount = 0;
  let refundCount = 0;
  let pendingReviewCount = 0;

  for (const a of fx.amounts) {
    const value = a.convertedMinor === null ? null : a.sign * a.convertedMinor;
    if (value !== null) signedValues.push(value);
    if (a.needsReview) pendingReviewCount += 1;
    if (a.isFixedExpense) {
      fixedExpenseCount += 1;
      if (value !== null) fixedExpenseMinor += value;
    }
    if (a.kind === 'refund') refundCount += 1;
    if (a.kind === 'expense') {
      expenseCount += 1;
      expenses.push({
        billId: a.billId,
        valueMinor: a.convertedMinor,
        originalMinor: a.amountMinor,
        currency: a.currency,
        merchant: a.merchant,
        categoryId: a.categoryId,
        isFixedExpense: a.isFixedExpense,
        needsReview: a.needsReview,
      });
      if (value !== null) {
        if (a.categoryId !== null && !a.needsReview) {
          categoryTotals[a.categoryId] = (categoryTotals[a.categoryId] ?? 0) + value;
        } else {
          uncategorizedMinor += value;
        }
      }
    } else if (a.kind === 'refund' && value !== null && a.categoryId !== null && !a.needsReview) {
      categoryTotals[a.categoryId] = (categoryTotals[a.categoryId] ?? 0) + value;
    }
  }

  const statsNet = signedValues.length > 0 ? sumMinor(signedValues) : 0;
  const positiveCategoryTotal = Object.values(categoryTotals)
    .filter((v) => v > 0)
    .reduce((s, v) => s + v, 0);

  const topCategories: CategorySlice[] = Object.entries(categoryTotals)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([categoryId, amountMinor]) => ({
      categoryId,
      amountMinor,
      ratio: positiveCategoryTotal > 0 ? amountMinor / positiveCategoryTotal : 0,
    }));

  const convertibleExpenseValues = expenses
    .filter((e) => e.valueMinor !== null && !e.isFixedExpense)
    .map((e) => e.valueMinor as number);

  const allExpenseValues = expenses
    .filter((e) => e.valueMinor !== null)
    .map((e) => e.valueMinor as number);

  const convertedTotal = fx.convertedTotalMinor;

  return {
    localDate,
    baseCurrency: money.baseCurrency,
    netTotalByCurrency: fx.netTotalByCurrency,
    netConvertedTotalMinor: convertedTotal,
    fxMissingCount: fx.fxMissingCount,
    fxMissingByCurrency: fx.fxMissingByCurrency,
    expenseCount,
    refundCount,
    pendingReviewCount,
    uncategorizedMinor,
    avgExpenseMinor: allExpenseValues.length > 0 ? meanMinor(allExpenseValues) : null,
    medianExpenseMinor: medianMinor(allExpenseValues),
    maxExpenseMinor: maxMinor(allExpenseValues),
    statsCurrency,
    statsConverted: fullyConverted,
    categoryBreakdownCurrency: statsCurrency,
    categoryBreakdownConverted: fullyConverted,
    topCategories,
    categoryTotals,
    fixedExpenseMinor,
    fixedExpenseCount,
    anomalyEligibleTotalMinor: convertedTotal === null ? null : convertedTotal - fixedExpenseMinor,
    maxNonFixedExpenseMinor: maxMinor(convertibleExpenseValues),
    expenses,
    negativeNet: convertedTotal === null ? statsNet < 0 : convertedTotal < 0,
  };
}

/**
 * 构造“异常检测口径”的按日净支出序列，用于基线计算。
 * 与当日比较所用口径必须一致（都剔除固定支出），否则基线会被固定支出拉高。
 * 缺汇率导致无法折算的日子从序列中剔除，不参与均值。
 */
export function anomalyEligibleByDate(args: {
  dates: readonly string[];
  attributed: readonly AttributedAmount[];
  money: MoneyConfig;
  lookup?: FxLookup;
}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const date of args.dates) {
    const m = computeMetrics({
      localDate: date,
      attributed: args.attributed,
      money: args.money,
      lookup: args.lookup,
    });
    const eligible = m.anomalyEligibleTotalMinor;
    const hasExpense = m.expenses.length > 0 || m.refundCount > 0;
    if (eligible !== null && hasExpense) out[date] = eligible;
  }
  return out;
}

/** 当日完整净额序列（含固定支出），用于展示型基线 */
export function netByDate(args: {
  dates: readonly string[];
  attributed: readonly AttributedAmount[];
  money: MoneyConfig;
  lookup?: FxLookup;
}): Record<string, number> {
  const out: Record<string, number> = {};
  for (const date of args.dates) {
    const m = computeMetrics({
      localDate: date,
      attributed: args.attributed,
      money: args.money,
      lookup: args.lookup,
    });
    if (m.netConvertedTotalMinor !== null && (m.expenses.length > 0 || m.refundCount > 0)) {
      out[date] = m.netConvertedTotalMinor;
    }
  }
  return out;
}

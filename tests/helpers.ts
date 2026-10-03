import type { AttributedAmount, Baseline, Bill, Config, DayMetrics } from '../src/domain/types.ts';

export function makeAttributed(over: Partial<AttributedAmount> & { amountMinor: number; localDate: string }): AttributedAmount {
  return {
    billId: over.billId ?? `a-${over.localDate}-${over.amountMinor}`,
    amountMinor: over.amountMinor,
    sign: over.sign ?? 1,
    currency: over.currency ?? 'CNY',
    localDate: over.localDate,
    categoryId: over.categoryId === undefined ? 'food' : over.categoryId,
    merchant: over.merchant ?? null,
    kind: over.kind ?? 'expense',
    isFixedExpense: over.isFixedExpense ?? false,
    needsReview: over.needsReview ?? false,
  };
}

export function makeBaseline(over: Partial<Baseline> = {}): Baseline {
  return { p7: null, p28: null, sameWeekday: null, sampleDays: 0, coldStart: true, ...over };
}

export function stubMetrics(over: Partial<DayMetrics> = {}): DayMetrics {
  return {
    localDate: '2026-10-03',
    baseCurrency: 'CNY',
    netTotalByCurrency: {},
    netConvertedTotalMinor: null,
    fxMissingCount: 0,
    fxMissingByCurrency: {},
    expenseCount: 0,
    refundCount: 0,
    pendingReviewCount: 0,
    uncategorizedMinor: 0,
    avgExpenseMinor: null,
    medianExpenseMinor: null,
    maxExpenseMinor: null,
    statsCurrency: 'CNY',
    statsConverted: true,
    categoryBreakdownCurrency: 'CNY',
    categoryBreakdownConverted: true,
    topCategories: [],
    categoryTotals: {},
    fixedExpenseMinor: 0,
    fixedExpenseCount: 0,
    anomalyEligibleTotalMinor: null,
    maxNonFixedExpenseMinor: null,
    expenses: [],
    negativeNet: false,
    ...over,
  };
}


export const TZ = 'Asia/Shanghai';

export function makeBill(over: Partial<Bill> & { amountMinor: number; occurredAt: string }): Bill {
  const billId = over.billId ?? 'b1';
  return {
    billId,
    amountMinor: over.amountMinor,
    currency: over.currency ?? 'CNY',
    direction: over.direction ?? 'expense',
    categoryId: over.categoryId === undefined ? 'food' : over.categoryId,
    occurredAt: over.occurredAt,
    merchant: over.merchant ?? null,
    accountId: over.accountId ?? null,
    paymentMethod: over.paymentMethod ?? null,
    tags: over.tags ?? [],
    note: over.note ?? null,
    source: over.source ?? 'manual',
    sourceRef: over.sourceRef ?? null,
    refundOf: over.refundOf ?? null,
    status: over.status ?? 'normal',
    recurringId: over.recurringId ?? null,
    version: over.version ?? 1,
    createdAt: over.createdAt ?? '2026-10-01T00:00:00+08:00',
    updatedAt: over.updatedAt ?? '2026-10-01T00:00:00+08:00',
    deletedAt: over.deletedAt ?? null,
  };
}

export interface ConfigOverrides {
  money?: Partial<Config['money']>;
  budget?: Partial<Config['budget']>;
  analysis?: Partial<Config['analysis']>;
  push?: Partial<Config['push']>;
}

export function makeConfig(over: ConfigOverrides = {}): Config {
  return {
    money: { baseCurrency: 'CNY', multiCurrency: false, fxPolicy: 'on_date', ...over.money },
    budget: { enabled: false, period: 'month', items: [], ...over.budget },
    analysis: {
      refundPolicy: 'B',
      baselineWindow: ['same_weekday', 'p7', 'p28'],
      coldStartMinDays: 3,
      recurringAmortize: false,
      fixedExpenseWhitelist: [],
      futureDateToleranceDays: 1,
      ...over.analysis,
    },
    push: {
      channels: ['local_daily_center'],
      time: '21:00',
      timezone: TZ,
      maxDailyAdvice: 3,
      ...over.push,
    },
  };
}

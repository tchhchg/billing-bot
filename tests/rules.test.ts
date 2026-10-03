import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules, noDataAdvice, type EvaluateArgs } from '../src/domain/rules/engine.ts';
import type { Advice, BudgetProgress, ExpenseValue } from '../src/domain/types.ts';
import { makeAttributed, makeBaseline, makeConfig, stubMetrics } from './helpers.ts';

const DAY = '2026-10-03';

function args(over: Partial<EvaluateArgs> = {}): EvaluateArgs {
  return {
    metrics: stubMetrics(),
    baseline: makeBaseline(),
    budgetProgress: null,
    cfg: makeConfig(),
    ...over,
  };
}

function ids(advices: Advice[]): string[] {
  return advices.map((a) => a.ruleId);
}

function findByRule(advices: Advice[], ruleId: string): Advice | undefined {
  return advices.find((a) => a.ruleId === ruleId);
}

const expense = (over: Partial<ExpenseValue> & { valueMinor: number }): ExpenseValue => ({
  billId: over.billId ?? `e${over.valueMinor}`,
  valueMinor: over.valueMinor,
  originalMinor: over.originalMinor ?? over.valueMinor,
  currency: over.currency ?? 'CNY',
  merchant: over.merchant ?? null,
  categoryId: over.categoryId === undefined ? 'food' : over.categoryId,
  isFixedExpense: over.isFixedExpense ?? false,
  needsReview: over.needsReview ?? false,
});

// ---------------------------------------------------------------- 冷启动
test('数据不足时一条建议都不出（不猜）', () => {
  const out = evaluateRules(
    args({
      metrics: stubMetrics({ anomalyEligibleTotalMinor: 500_000, expenseCount: 5 }),
      baseline: makeBaseline({ coldStart: true, sampleDays: 1 }),
      cfg: makeConfig({ analysis: { baselineWindow: ['p7'] } }),
    }),
  );
  assert.deepEqual(ids(out), []);
});

// ---------------------------------------------------------------- R1
test('R1 单日超基线：超出阈值才提醒，且证据可追溯', () => {
  const a = args({
    metrics: stubMetrics({
      anomalyEligibleTotalMinor: 30_000,
      expenseCount: 3,
      topCategories: [{ categoryId: 'food', amountMinor: 30_000, ratio: 1 }],
    }),
    baseline: makeBaseline({ p7: 10_000, sampleDays: 7, coldStart: false }),
    cfg: makeConfig({ analysis: { baselineWindow: ['p7'] } }),
  });
  const advice = findByRule(evaluateRules(a), 'R1');
  assert.ok(advice);
  assert.equal(advice?.severity, 'warn');
  assert.equal(advice?.evidence['deltaRatio'], 2);
  assert.equal(advice?.evidence['baselineKind'], 'p7');
  assert.equal(advice?.disclaimerRequired, true);
  assert.equal(advice?.adviceId, `adv_${DAY}_R1`);
});

test('R1 未超阈值不提醒；阈值可配置', () => {
  const mk = (alpha?: number) =>
    evaluateRules(
      args({
        metrics: stubMetrics({ anomalyEligibleTotalMinor: 14_000, expenseCount: 2 }),
        baseline: makeBaseline({ p7: 10_000, sampleDays: 7, coldStart: false }),
        cfg: makeConfig({ analysis: { baselineWindow: ['p7'] } }),
        thresholds: alpha === undefined ? undefined : { r1Alpha: alpha },
      }),
    );
  assert.deepEqual(ids(mk()), []);
  assert.deepEqual(ids(mk(0.1)), ['R1']);
});

test('R1 在无法折算（缺汇率）时自动跳过', () => {
  const out = evaluateRules(
    args({
      metrics: stubMetrics({ anomalyEligibleTotalMinor: null, fxMissingCount: 1 }),
      baseline: makeBaseline({ p7: 10_000, sampleDays: 7, coldStart: false }),
      cfg: makeConfig({ analysis: { baselineWindow: ['p7'] } }),
    }),
  );
  assert.deepEqual(ids(out), []);
});

// ---------------------------------------------------------------- R2
test('R2 分类占比连续上升', () => {
  const rising = evaluateRules(
    args({ metrics: stubMetrics({ localDate: DAY }), categoryRatioHistory: { food: [0.1, 0.2, 0.35] } }),
  );
  const advice = findByRule(rising, 'R2');
  assert.ok(advice);
  assert.equal(advice?.evidence['lastRatio'], 0.35);

  const notRising = evaluateRules(
    args({ metrics: stubMetrics({ localDate: DAY }), categoryRatioHistory: { food: [0.3, 0.2, 0.35] } }),
  );
  assert.deepEqual(ids(notRising), []);

  const tooSmall = evaluateRules(
    args({ metrics: stubMetrics({ localDate: DAY }), categoryRatioHistory: { food: [0.1, 0.15, 0.2] } }),
  );
  assert.deepEqual(ids(tooSmall), []);
});

// ---------------------------------------------------------------- R3
test('R3 预算进度', () => {
  const progress: BudgetProgress = {
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    spentMinor: 480_000,
    limitMinor: 600_000,
    ratio: 0.8,
    remainingMinor: 120_000,
    daysLeft: 15,
    dailyAllowanceMinor: 8_000,
  };
  const hit = findByRule(evaluateRules(args({ budgetProgress: progress })), 'R3');
  assert.ok(hit);
  assert.equal(hit?.severity, 'warn');
  assert.equal(hit?.evidence['remainingMinor'], 120_000);

  const miss = evaluateRules(args({ budgetProgress: { ...progress, ratio: 0.5 } }));
  assert.deepEqual(ids(miss), []);

  assert.deepEqual(ids(evaluateRules(args({ budgetProgress: null }))), []);
});

// ---------------------------------------------------------------- R4
test('R4 订阅识别：约一个月周期重复的近似金额', () => {
  const history = [
    makeAttributed({ amountMinor: 5_000, localDate: '2026-07-05', merchant: '某订阅', kind: 'expense' }),
    makeAttributed({ amountMinor: 5_000, localDate: '2026-08-04', merchant: '某订阅', kind: 'expense' }),
    makeAttributed({ amountMinor: 5_100, localDate: '2026-09-03', merchant: '某订阅', kind: 'expense' }),
  ];
  const advice = findByRule(evaluateRules(args({ metrics: stubMetrics({ localDate: DAY }), history })), 'R4');
  assert.ok(advice);
  assert.equal(advice?.evidence['occurrences'], 3);
  assert.equal(advice?.evidence['avgGapDays'], 30);
  assert.equal(advice?.evidence['merchant'], '某订阅');
  // 建议文案本身不得内嵌商户名（隐私：卡片要经过 IM 服务端）
  assert.equal(advice?.suggestions.some((s) => s.includes('某订阅')), false);
});

test('R4 间隔不是月度周期则不提醒；单次也不提醒', () => {
  const denseCharges = [
    makeAttributed({ amountMinor: 5_000, localDate: '2026-09-25', merchant: '某店', kind: 'expense' }),
    makeAttributed({ amountMinor: 5_000, localDate: '2026-09-27', merchant: '某店', kind: 'expense' }),
    makeAttributed({ amountMinor: 5_000, localDate: '2026-09-29', merchant: '某店', kind: 'expense' }),
  ];
  assert.deepEqual(ids(evaluateRules(args({ metrics: stubMetrics({ localDate: DAY }), history: denseCharges }))), []);

  const once = [makeAttributed({ amountMinor: 5_000, localDate: '2026-09-03', merchant: '某店', kind: 'expense' })];
  assert.deepEqual(ids(evaluateRules(args({ metrics: stubMetrics({ localDate: DAY }), history: once }))), []);
});

// ---------------------------------------------------------------- R5
test('R5 疑似重复记账：同日同商户同金额', () => {
  const metrics = stubMetrics({
    localDate: DAY,
    expenses: [
      expense({ valueMinor: 5_000, merchant: '某店', billId: 'a' }),
      expense({ valueMinor: 5_000, merchant: '某店', billId: 'b' }),
    ],
  });
  const advice = findByRule(evaluateRules(args({ metrics })), 'R5');
  assert.ok(advice);
  assert.equal(advice?.evidence['occurrences'], 2);
});

// ---------------------------------------------------------------- R6
test('R6 大额单笔：相对基线与绝对阈值两条路径', () => {
  const byMultiplier = findByRule(
    evaluateRules(
      args({
        metrics: stubMetrics({ maxNonFixedExpenseMinor: 250_000, expenses: [expense({ valueMinor: 250_000 })] }),
        baseline: makeBaseline({ p7: 10_000, sampleDays: 7, coldStart: false }),
        cfg: makeConfig({ analysis: { baselineWindow: ['p7'] } }),
      }),
    ),
    'R6',
  );
  assert.equal(byMultiplier?.evidence['matchedBy'], 'baseline_multiplier');

  const byAbsolute = findByRule(
    evaluateRules(
      args({
        metrics: stubMetrics({ maxNonFixedExpenseMinor: 150_000, expenses: [expense({ valueMinor: 150_000 })] }),
        baseline: makeBaseline(),
      }),
    ),
    'R6',
  );
  assert.equal(byAbsolute?.evidence['matchedBy'], 'absolute');

  const normal = evaluateRules(
    args({ metrics: stubMetrics({ maxNonFixedExpenseMinor: 5_000, expenses: [expense({ valueMinor: 5_000 })] }) }),
  );
  assert.deepEqual(ids(normal), []);
});

// ---------------------------------------------------------------- R7
test('R7 数据质量：待补充条数达到阈值才提醒', () => {
  const hit = findByRule(evaluateRules(args({ metrics: stubMetrics({ pendingReviewCount: 3 }) })), 'R7');
  assert.ok(hit);
  assert.deepEqual(ids(evaluateRules(args({ metrics: stubMetrics({ pendingReviewCount: 2 }) }))), []);
});

// ---------------------------------------------------------------- R9
test('R9 长尾高频：笔数与占比需同时达标', () => {
  const expenses = [
    ...Array.from({ length: 5 }, (_, i) => expense({ valueMinor: 1_000, billId: `s${i}` })),
    expense({ valueMinor: 50_000, billId: 'big' }),
  ];
  const hit = findByRule(evaluateRules(args({ metrics: stubMetrics({ expenses }) })), 'R9');
  assert.ok(hit);
  assert.equal(hit?.evidence['smallCount'], 5);

  const diluted = [
    ...Array.from({ length: 5 }, (_, i) => expense({ valueMinor: 1_000, billId: `s${i}` })),
    ...Array.from({ length: 5 }, (_, i) => expense({ valueMinor: 50_000, billId: `b${i}` })),
  ];
  assert.deepEqual(ids(evaluateRules(args({ metrics: stubMetrics({ expenses: diluted }) }))), []);
});

// ---------------------------------------------------------------- R8
test('R8 无数据日由用例层触发，不参与规则评估', () => {
  assert.deepEqual(ids(evaluateRules(args())), []);
  const advice = noDataAdvice(DAY);
  assert.equal(advice.ruleId, 'R8');
  assert.equal(advice.evidence['billCount'], 0);
  assert.equal(advice.actions[0]?.type, 'record_added');
});

// ---------------------------------------------------------------- 多规则同时命中
test('多条规则同时命中时全部返回，由节流层决定最终条数', () => {
  const out = evaluateRules(
    args({
      metrics: stubMetrics({
        anomalyEligibleTotalMinor: 30_000,
        expenseCount: 7,
        pendingReviewCount: 4,
        expenses: [
          expense({ valueMinor: 25_000, merchant: 'X', billId: 'a' }),
          expense({ valueMinor: 25_000, merchant: 'X', billId: 'b' }),
          ...Array.from({ length: 5 }, (_, i) => expense({ valueMinor: 1_000, billId: `s${i}` })),
        ],
      }),
      baseline: makeBaseline({ p7: 10_000, sampleDays: 7, coldStart: false }),
      cfg: makeConfig({ analysis: { baselineWindow: ['p7'] } }),
    }),
  );
  assert.ok(ids(out).includes('R1'));
  assert.ok(ids(out).includes('R5'));
  assert.ok(ids(out).includes('R7'));
  assert.ok(ids(out).includes('R9'));
});

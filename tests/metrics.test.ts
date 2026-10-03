import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anomalyEligibleByDate, computeMetrics } from '../src/domain/analysis/metrics.ts';
import { normalizeBills } from '../src/domain/analysis/refund.ts';
import type { FxLookup } from '../src/domain/analysis/fx.ts';
import { makeAttributed, makeBill, makeConfig, TZ } from './helpers.ts';

const DAY = '2026-10-03';

function metricsFor(bills: Parameters<typeof normalizeBills>[0], cfgOver: Parameters<typeof makeConfig>[0] = {}, lookup?: FxLookup) {
  const cfg = makeConfig(cfgOver);
  const attributed = normalizeBills(bills, cfg, TZ);
  return { cfg, m: computeMetrics({ localDate: DAY, attributed, money: cfg.money, lookup }) };
}

const food = makeBill({ billId: 'f', amountMinor: 10_000, merchant: 'A', categoryId: 'food', occurredAt: `${DAY}T12:00:00+08:00` });
const transport = makeBill({ billId: 't', amountMinor: 5_000, merchant: 'B', categoryId: 'transport', occurredAt: `${DAY}T13:00:00+08:00` });
const unknown = makeBill({ billId: 'u', amountMinor: 3_000, merchant: 'C', categoryId: null, status: 'pending_review', occurredAt: `${DAY}T14:00:00+08:00` });

test('当日净额、笔数、统计量', () => {
  const { m } = metricsFor([food, transport, unknown]);
  assert.equal(m.netConvertedTotalMinor, 18_000);
  assert.equal(m.expenseCount, 3);
  assert.equal(m.refundCount, 0);
  assert.equal(m.avgExpenseMinor, 6_000);
  assert.equal(m.medianExpenseMinor, 5_000);
  assert.equal(m.maxExpenseMinor, 10_000);
  assert.equal(m.negativeNet, false);
  assert.equal(m.statsConverted, true);
});

test('未分类条目计入总额但不进入分类占比结论', () => {
  const { m } = metricsFor([food, transport, unknown]);
  assert.equal(m.uncategorizedMinor, 3_000);
  assert.equal(m.pendingReviewCount, 1);
  assert.equal(m.categoryTotals['food'], 10_000);
  assert.equal(m.categoryTotals['transport'], 5_000);
  assert.equal(m.categoryTotals['__uncategorized__'], undefined);
  assert.deepEqual(
    m.topCategories.map((c) => c.categoryId),
    ['food', 'transport'],
  );
  // 占比以“已分类”为分母：10000 / 15000
  assert.ok(Math.abs((m.topCategories[0]?.ratio ?? 0) - 10_000 / 15_000) < 1e-9);
});

test('同日退款按口径 B 冲减当日', () => {
  const refund = makeBill({
    billId: 'r',
    amountMinor: 2_000,
    direction: 'income',
    refundOf: 'f',
    categoryId: 'food',
    merchant: 'A',
    occurredAt: `${DAY}T15:00:00+08:00`,
  });
  const { m } = metricsFor([food, refund]);
  assert.equal(m.netConvertedTotalMinor, 8_000);
  assert.equal(m.refundCount, 1);
  assert.equal(m.categoryTotals['food'], 8_000);
});

test('退款大于消费 → 净额为负，不显示为 0', () => {
  const small = makeBill({ billId: 's', amountMinor: 5_000, categoryId: 'food', occurredAt: `${DAY}T10:00:00+08:00` });
  const bigRefund = makeBill({
    billId: 'r2',
    amountMinor: 8_000,
    direction: 'income',
    refundOf: 's',
    categoryId: 'food',
    occurredAt: `${DAY}T11:00:00+08:00`,
  });
  const { m } = metricsFor([small, bigRefund]);
  assert.equal(m.netConvertedTotalMinor, -3_000);
  assert.equal(m.negativeNet, true);
});

test('固定支出计入总额，但被异常检测口径剔除', () => {
  const rent = makeBill({
    billId: 'rent',
    amountMinor: 300_000,
    merchant: '房东王先生',
    categoryId: 'housing.rent',
    occurredAt: `${DAY}T09:00:00+08:00`,
  });
  const { m } = metricsFor([food, rent], { analysis: { fixedExpenseWhitelist: ['房东'] } });
  assert.equal(m.netConvertedTotalMinor, 310_000);
  assert.equal(m.fixedExpenseMinor, 300_000);
  assert.equal(m.fixedExpenseCount, 1);
  assert.equal(m.anomalyEligibleTotalMinor, 10_000);
  assert.equal(m.maxNonFixedExpenseMinor, 10_000);
});

test('多币种缺汇率：不给跨币种合计，统计量降级为仅基础币种', () => {
  const usd = makeBill({ billId: 'usd', amountMinor: 1_000, currency: 'USD', categoryId: 'shopping', occurredAt: `${DAY}T16:00:00+08:00` });
  const { m } = metricsFor([food, usd], { money: { multiCurrency: true } });
  assert.equal(m.netConvertedTotalMinor, null);
  assert.equal(m.anomalyEligibleTotalMinor, null);
  assert.equal(m.statsConverted, false);
  assert.equal(m.fxMissingCount, 1);
  assert.deepEqual(m.netTotalByCurrency, { CNY: 10_000, USD: 1_000 });
  assert.equal(m.avgExpenseMinor, 10_000); // 仅基础币种参与
});

test('多币种有汇率：折算后给出单一合计', () => {
  const lookup: FxLookup = {
    onDate: (d, base, quote) => (base === 'CNY' && quote === 'USD' && d === DAY ? 7.1 : null),
    latest: () => null,
  };
  const usd = makeBill({ billId: 'usd', amountMinor: 1_000, currency: 'USD', categoryId: 'shopping', occurredAt: `${DAY}T16:00:00+08:00` });
  const { m } = metricsFor([food, usd], { money: { multiCurrency: true } }, lookup);
  assert.equal(m.netConvertedTotalMinor, 17_100);
  assert.equal(m.fxMissingCount, 0);
  assert.equal(m.statsConverted, true);
});

test('基线序列与当日口径一致（都剔除固定支出），缺汇率日不进序列', () => {
  const dates = ['2026-10-01', '2026-10-02', DAY];
  const bills = [
    makeBill({ billId: 'd1', amountMinor: 10_000, categoryId: 'food', occurredAt: '2026-10-01T12:00:00+08:00' }),
    makeBill({
      billId: 'd1r',
      amountMinor: 100_000,
      merchant: '房东',
      categoryId: 'housing.rent',
      occurredAt: '2026-10-01T09:00:00+08:00',
    }),
    makeBill({ billId: 'd2', amountMinor: 20_000, categoryId: 'food', occurredAt: '2026-10-02T12:00:00+08:00' }),
    makeBill({ billId: 'd3', amountMinor: 30_000, categoryId: 'food', occurredAt: `${DAY}T12:00:00+08:00` }),
  ];
  const cfg = makeConfig({ analysis: { fixedExpenseWhitelist: ['房东'] } });
  const series = anomalyEligibleByDate({
    dates,
    attributed: normalizeBills(bills, cfg, TZ),
    money: cfg.money,
  });
  assert.deepEqual(series, { '2026-10-01': 10_000, '2026-10-02': 20_000, '2026-10-03': 30_000 });
});

test('无支出条目时给出零值而非 null（由用例层判断“无数据日”）', () => {
  const { m } = metricsFor([]);
  assert.equal(m.netConvertedTotalMinor, 0);
  assert.equal(m.expenseCount, 0);
  assert.equal(m.avgExpenseMinor, null);
  assert.equal(m.medianExpenseMinor, null);
});

test('估算函数可直接用于构造单日指标（旁路账单对象）', () => {
  const attributed = [
    makeAttributed({ amountMinor: 1_000, localDate: DAY }),
    makeAttributed({ amountMinor: 500, localDate: '2026-10-04' }),
  ];
  const m = computeMetrics({ localDate: DAY, attributed, money: makeConfig().money });
  assert.equal(m.netConvertedTotalMinor, 1_000);
  assert.equal(m.expenseCount, 1);
});

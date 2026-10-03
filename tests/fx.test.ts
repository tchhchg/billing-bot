import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFx, type FxLookup } from '../src/domain/analysis/fx.ts';
import { makeAttributed } from './helpers.ts';

const lookup: FxLookup = {
  onDate(rateDate, base, quote) {
    if (base === 'CNY' && quote === 'USD' && rateDate === '2026-10-03') return 7.1;
    return null;
  },
  latest(base, quote) {
    if (base === 'CNY' && quote === 'USD') return { rate: 7.0, rateDate: '2026-09-30' };
    return null;
  },
};

const cny = makeAttributed({ amountMinor: 10_000, localDate: '2026-10-03' });
const usd = makeAttributed({ amountMinor: 1_000, currency: 'USD', localDate: '2026-10-03' });

test('基础币种无需汇率', () => {
  const r = applyFx([cny], { baseCurrency: 'CNY', multiCurrency: true, fxPolicy: 'on_date' }, lookup);
  assert.equal(r.amounts[0]?.convertedMinor, 10_000);
  assert.equal(r.amounts[0]?.fxMissing, false);
  assert.equal(r.convertedTotalMinor, 10_000);
  assert.equal(r.fxMissingCount, 0);
});

test('按发生日汇率折算成功', () => {
  const r = applyFx(
    [cny, usd],
    { baseCurrency: 'CNY', multiCurrency: true, fxPolicy: 'on_date' },
    lookup,
  );
  assert.equal(r.amounts[1]?.convertedMinor, 7_100);
  assert.equal(r.amounts[1]?.rateIsFallback, false);
  assert.equal(r.convertedTotalMinor, 17_100);
  assert.equal(r.netTotalByCurrency['USD'], 1_000);
});

test('当日缺汇率 → 回退最近可用汇率并标记', () => {
  const usdOtherDay = makeAttributed({ amountMinor: 1_000, currency: 'USD', localDate: '2026-10-04' });
  const r = applyFx(
    [usdOtherDay],
    { baseCurrency: 'CNY', multiCurrency: true, fxPolicy: 'on_date' },
    lookup,
  );
  assert.equal(r.amounts[0]?.convertedMinor, 7_000);
  assert.equal(r.amounts[0]?.rateIsFallback, true);
  assert.equal(r.amounts[0]?.rateDate, '2026-09-30');
  assert.equal(r.usedFallbackRate, true);
});

test('完全拿不到汇率时：不给出跨币种合计（null）', () => {
  const noLookup: FxLookup = { onDate: () => null, latest: () => null };
  const r = applyFx(
    [cny, usd],
    { baseCurrency: 'CNY', multiCurrency: true, fxPolicy: 'on_date' },
    noLookup,
  );
  assert.equal(r.convertedTotalMinor, null);
  assert.equal(r.fxMissingCount, 1);
  assert.deepEqual(r.fxMissingByCurrency, { USD: 1_000 });
  // 分币种净额仍然可用
  assert.deepEqual(r.netTotalByCurrency, { CNY: 10_000, USD: 1_000 });
});

test('未启用多币种时，外币条目视为缺汇率', () => {
  const r = applyFx([usd], { baseCurrency: 'CNY', multiCurrency: false, fxPolicy: 'on_date' }, lookup);
  assert.equal(r.fxMissingCount, 1);
  assert.equal(r.convertedTotalMinor, null);
});

test('无汇率适配器时不崩溃，退化为缺汇率', () => {
  const r = applyFx([usd], { baseCurrency: 'CNY', multiCurrency: true, fxPolicy: 'on_date' }, undefined);
  assert.equal(r.fxMissingCount, 1);
  assert.equal(r.convertedTotalMinor, null);
});

test('退款符号参与折算合计', () => {
  const refund = makeAttributed({
    amountMinor: 2_000,
    currency: 'USD',
    localDate: '2026-10-03',
    kind: 'refund',
    sign: -1,
  });
  const r = applyFx([usd, refund], { baseCurrency: 'CNY', multiCurrency: true, fxPolicy: 'on_date' }, lookup);
  assert.equal(r.convertedTotalMinor, -7_100); // (1000 - 2000) 美元 × 7.1
  assert.equal(r.netTotalByCurrency['USD'], -1_000);
});

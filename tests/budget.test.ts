import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetPeriodRange,
  categoryBudgetLimit,
  computeBudgetProgress,
  totalBudgetLimit,
} from '../src/domain/analysis/budget.ts';
import { makeConfig } from './helpers.ts';

test('预算周期：自然月与自然周（周一起）', () => {
  assert.deepEqual(budgetPeriodRange(makeConfig({ budget: { period: 'month' } }).budget, '2026-10-17'), {
    start: '2026-10-01',
    end: '2026-10-31',
  });
  assert.deepEqual(budgetPeriodRange(makeConfig({ budget: { period: 'week' } }).budget, '2026-10-03'), {
    start: '2026-09-28',
    end: '2026-10-04',
  });
});

test('总额额度只由 categoryId 为 null 的条目组成', () => {
  const cfg = makeConfig({
    budget: { items: [{ categoryId: null, limitMinor: 600_000 }, { categoryId: 'food', limitMinor: 200_000 }] },
  }).budget;
  assert.equal(totalBudgetLimit(cfg), 600_000);
  assert.equal(categoryBudgetLimit(cfg, 'food'), 200_000);
  assert.equal(categoryBudgetLimit(cfg, 'transport'), null);
  assert.equal(totalBudgetLimit(makeConfig().budget), null);
});

test('未启用预算 → 不产生进度（规则自动禁用）', () => {
  const cfg = makeConfig({ budget: { enabled: false, items: [{ categoryId: null, limitMinor: 100 }] } }).budget;
  assert.equal(computeBudgetProgress({ cfg, date: '2026-10-17', spentMinor: 10 }), null);

  const noLimit = makeConfig({ budget: { enabled: true, items: [] } }).budget;
  assert.equal(computeBudgetProgress({ cfg: noLimit, date: '2026-10-17', spentMinor: 10 }), null);
});

test('预算进度：比例、剩余、剩余天数与日均可用', () => {
  const cfg = makeConfig({
    budget: { enabled: true, items: [{ categoryId: null, limitMinor: 600_000 }] },
  }).budget;
  const p = computeBudgetProgress({ cfg, date: '2026-10-17', spentMinor: 480_000 });
  assert.ok(p);
  assert.equal(p?.periodStart, '2026-10-01');
  assert.equal(p?.periodEnd, '2026-10-31');
  assert.equal(p?.ratio, 0.8);
  assert.equal(p?.remainingMinor, 120_000);
  assert.equal(p?.daysLeft, 15);
  assert.equal(p?.dailyAllowanceMinor, 8_000);
});

test('超支：剩余与日均可用为 0，不出现负数可支配额度', () => {
  const cfg = makeConfig({ budget: { enabled: true, items: [{ categoryId: null, limitMinor: 100_000 }] } }).budget;
  const p = computeBudgetProgress({ cfg, date: '2026-10-31', spentMinor: 150_000 });
  assert.equal(p?.remainingMinor, -50_000);
  assert.equal(p?.ratio, 1.5);
  assert.equal(p?.daysLeft, 1);
  assert.equal(p?.dailyAllowanceMinor, 0);
});

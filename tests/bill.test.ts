import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBill, type ValidateOptions } from '../src/domain/bill.ts';

const NOW = '2026-10-03T12:00:00+08:00';
const options: ValidateOptions = { analysis: { futureDateToleranceDays: 1 }, now: NOW };

test('正常账单通过校验，不进入待补充', () => {
  const r = validateBill(
    {
      amountMinor: 3800,
      currency: 'CNY',
      occurredAt: '2026-10-03T12:30:00+08:00',
      categoryId: 'food',
      merchant: '某超市',
    },
    options,
  );
  assert.equal(r.ok, true);
  assert.equal(r.needsReview, false);
  assert.equal(r.bill?.status, 'normal');
  assert.equal(r.bill?.direction, 'expense');
  assert.equal(r.bill?.source, 'manual');
  assert.deepEqual(r.softIssues, []);
});

test('缺金额 / 金额非法 → 硬拒绝', () => {
  for (const amount of [undefined, 0, -100, 1.5]) {
    const r = validateBill(
      { amountMinor: amount, currency: 'CNY', occurredAt: '2026-10-03T12:30:00+08:00', categoryId: 'food' },
      options,
    );
    assert.equal(r.ok, false, `amount=${String(amount)} 应被拒绝`);
    assert.equal(r.bill, null);
    assert.ok(r.hardIssues.some((i) => i.field === 'amountMinor'));
  }
});

test('缺日期 / 日期格式非法 / 不可解析 → 硬拒绝', () => {
  const cases: Array<string | undefined> = [undefined, '2026-10-03', '2026/10/03 12:00', '2026-13-01T00:00:00+08:00'];
  for (const occurredAt of cases) {
    const r = validateBill({ amountMinor: 100, currency: 'CNY', occurredAt, categoryId: 'food' }, options);
    assert.equal(r.ok, false, `occurredAt=${String(occurredAt)} 应被拒绝`);
    assert.ok(r.hardIssues.some((i) => i.field === 'occurredAt'));
  }
});

test('币种非法 / 方向非法 / 来源非法 → 硬拒绝', () => {
  const base = { amountMinor: 100, occurredAt: '2026-10-03T12:30:00+08:00', categoryId: 'food' };
  assert.equal(validateBill({ ...base, currency: 'rmb' }, options).ok, false);
  assert.equal(validateBill({ ...base, currency: undefined }, options).ok, false);
  // @ts-expect-error 故意传入非法枚举
  assert.equal(validateBill({ ...base, currency: 'CNY', direction: 'nope' }, options).ok, false);
  // @ts-expect-error 故意传入非法枚举
  assert.equal(validateBill({ ...base, currency: 'CNY', source: 'hack' }, options).ok, false);
});

test('未来日期：容差内放行，超出容差硬拒绝', () => {
  const inTolerance = validateBill(
    { amountMinor: 100, currency: 'CNY', occurredAt: '2026-10-04T10:00:00+08:00', categoryId: 'food' },
    options,
  );
  assert.equal(inTolerance.ok, true);

  const beyond = validateBill(
    { amountMinor: 100, currency: 'CNY', occurredAt: '2026-10-06T10:00:00+08:00', categoryId: 'food' },
    options,
  );
  assert.equal(beyond.ok, false);
  assert.ok(beyond.hardIssues.some((i) => i.code === 'future_date'));
});

test('缺分类 → 软校验：收下、标记待补充、状态转为 pending_review', () => {
  const r = validateBill(
    { amountMinor: 100, currency: 'CNY', occurredAt: '2026-10-03T12:30:00+08:00', categoryId: null },
    options,
  );
  assert.equal(r.ok, true);
  assert.equal(r.needsReview, true);
  assert.equal(r.bill?.status, 'pending_review');
  assert.ok(r.softIssues.some((i) => i.field === 'categoryId' && i.code === 'missing'));
});

test('未知分类 ID → 软提示，但不改变状态', () => {
  const r = validateBill(
    { amountMinor: 100, currency: 'CNY', occurredAt: '2026-10-03T12:30:00+08:00', categoryId: 'ghost' },
    { ...options, knownCategoryIds: ['food', 'transport'] },
  );
  assert.equal(r.ok, true);
  assert.equal(r.needsReview, false);
  assert.equal(r.bill?.status, 'normal');
  assert.ok(r.softIssues.some((i) => i.code === 'unknown'));
});

test('缺商户仅是软提示，不影响入库', () => {
  const r = validateBill(
    { amountMinor: 100, currency: 'CNY', occurredAt: '2026-10-03T12:30:00+08:00', categoryId: 'food' },
    options,
  );
  assert.equal(r.ok, true);
  assert.ok(r.softIssues.some((i) => i.field === 'merchant'));
});

test('转账不应同时是退款 → 软提示', () => {
  const r = validateBill(
    {
      amountMinor: 100,
      currency: 'CNY',
      direction: 'transfer',
      refundOf: 'b-orig',
      occurredAt: '2026-10-03T12:30:00+08:00',
      categoryId: 'food',
    },
    options,
  );
  assert.equal(r.ok, true);
  assert.ok(r.softIssues.some((i) => i.field === 'refundOf'));
});

test('缺省值：状态 normal、标签空数组、可空字段 null', () => {
  const r = validateBill(
    { amountMinor: 100, currency: 'CNY', occurredAt: '2026-10-03T12:30:00+08:00', categoryId: 'food' },
    options,
  );
  assert.deepEqual(r.bill?.tags, []);
  assert.equal(r.bill?.merchant, null);
  assert.equal(r.bill?.refundOf, null);
  assert.equal(r.bill?.deletedAt, null);
  assert.equal(r.bill?.version, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBills, forLocalDate, isExpenseLike } from '../src/domain/analysis/refund.ts';
import { makeBill, makeConfig, TZ } from './helpers.ts';

const original = makeBill({
  billId: 'orig',
  amountMinor: 10_000,
  occurredAt: '2026-10-01T12:00:00+08:00',
  merchant: '某电商',
  categoryId: 'shopping',
});
const refund = makeBill({
  billId: 're',
  amountMinor: 3_000,
  direction: 'income',
  refundOf: 'orig',
  occurredAt: '2026-10-05T12:00:00+08:00',
  merchant: '某电商',
  categoryId: 'shopping',
});

test('口径 B（默认）：退款归属退款当日，原消费日数字不被改写', () => {
  const out = normalizeBills([original, refund], makeConfig(), TZ);
  const expense = out.find((a) => a.billId === 'orig');
  const refunded = out.find((a) => a.billId === 're');

  assert.equal(expense?.localDate, '2026-10-01');
  assert.equal(expense?.sign, 1);
  assert.equal(refunded?.localDate, '2026-10-05');
  assert.equal(refunded?.sign, -1);
  assert.equal(refunded?.kind, 'refund');

  // 原单日仍是 100.00，退款日出现 -30.00（口径 B 的核心行为）
  assert.equal(forLocalDate(out, '2026-10-01').reduce((s, a) => s + a.sign * a.amountMinor, 0), 10_000);
  assert.equal(forLocalDate(out, '2026-10-05').reduce((s, a) => s + a.sign * a.amountMinor, 0), -3_000);
});

test('口径 A：退款回填到原单发生日', () => {
  const out = normalizeBills([original, refund], makeConfig({ analysis: { refundPolicy: 'A' } }), TZ);
  const refunded = out.find((a) => a.billId === 're');
  assert.equal(refunded?.localDate, '2026-10-01');
  assert.equal(
    forLocalDate(out, '2026-10-01').reduce((s, a) => s + a.sign * a.amountMinor, 0),
    7_000,
  );
  assert.equal(forLocalDate(out, '2026-10-05').length, 0);
});

test('口径 A 找不到原单时退回退款自身日期', () => {
  const orphan = makeBill({
    billId: 're2',
    amountMinor: 500,
    direction: 'income',
    refundOf: 'does-not-exist',
    occurredAt: '2026-10-06T12:00:00+08:00',
  });
  const out = normalizeBills([orphan], makeConfig({ analysis: { refundPolicy: 'A' } }), TZ);
  assert.equal(out[0]?.localDate, '2026-10-06');
});

test('口径 C：退款整体不计入', () => {
  const out = normalizeBills([original, refund], makeConfig({ analysis: { refundPolicy: 'C' } }), TZ);
  assert.equal(out.find((a) => a.billId === 're'), undefined);
  assert.equal(out.length, 1);
});

test('void 与已软删的账单不参与统计', () => {
  const voided = makeBill({ billId: 'v', amountMinor: 999, occurredAt: '2026-10-03T10:00:00+08:00', status: 'void' });
  const deleted = makeBill({
    billId: 'd',
    amountMinor: 888,
    occurredAt: '2026-10-03T10:00:00+08:00',
    deletedAt: '2026-10-04T00:00:00+08:00',
  });
  const out = normalizeBills([voided, deleted], makeConfig(), TZ);
  assert.deepEqual(out, []);
});

test('收入与转账不计入支出净额', () => {
  const income = makeBill({ billId: 'i', amountMinor: 5000, direction: 'income', occurredAt: '2026-10-03T10:00:00+08:00' });
  const transfer = makeBill({ billId: 't', amountMinor: 5000, direction: 'transfer', occurredAt: '2026-10-03T10:00:00+08:00' });
  const out = normalizeBills([income, transfer], makeConfig(), TZ);
  assert.equal(out.every((a) => !isExpenseLike(a)), true);
  assert.equal(forLocalDate(out, '2026-10-03').length, 0);
});

test('固定支出白名单命中 merchant 或分类', () => {
  const rent = makeBill({
    billId: 'r',
    amountMinor: 300_000,
    merchant: '房东王先生',
    categoryId: 'housing.rent',
    occurredAt: '2026-10-03T10:00:00+08:00',
  });
  const cfg = makeConfig({ analysis: { fixedExpenseWhitelist: ['房东', 'housing.rent'] } });
  const out = normalizeBills([rent], cfg, TZ);
  assert.equal(out[0]?.isFixedExpense, true);

  const cfg2 = makeConfig({ analysis: { fixedExpenseWhitelist: ['房贷'] } });
  assert.equal(normalizeBills([rent], cfg2, TZ)[0]?.isFixedExpense, false);
});

test('未分类 / pending_review 仍计入总额，但标记 needsReview', () => {
  const uncategorized = makeBill({
    billId: 'u',
    amountMinor: 3000,
    categoryId: null,
    status: 'pending_review',
    occurredAt: '2026-10-03T10:00:00+08:00',
  });
  const out = normalizeBills([uncategorized], makeConfig(), TZ);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.needsReview, true);
  assert.equal(isExpenseLike(out[0]!), true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { throttleAdvices } from '../src/domain/advice/throttle.ts';
import { DISCLAIMER_TEXT, cardDisplayText, renderDailyCard } from '../src/domain/advice/render.ts';
import {
  FORBIDDEN_LLM_KEYS,
  assertNoForbiddenContent,
  bucketAmountMinor,
  buildLlmPayload,
} from '../src/domain/advice/redact.ts';
import type { Advice, ExpenseValue } from '../src/domain/types.ts';
import { PRESET_CATEGORIES } from '../src/domain/category.ts';
import { makeConfig, stubMetrics } from './helpers.ts';

const DAY = '2026-10-03';

function advice(over: Partial<Advice> & { ruleId: string }): Advice {
  return {
    adviceId: over.adviceId ?? `adv_${DAY}_${over.ruleId}`,
    ruleId: over.ruleId,
    severity: over.severity ?? 'info',
    title: over.title ?? `规则 ${over.ruleId}`,
    evidence: over.evidence ?? {},
    suggestions: over.suggestions ?? [],
    confidence: over.confidence ?? 0.5,
    actions: over.actions ?? [],
    disclaimerRequired: over.disclaimerRequired ?? false,
  };
}

// ---------------------------------------------------------------- 节流
test('节流：用户关闭的规则不再出现', () => {
  const out = throttleAdvices(
    [advice({ ruleId: 'R1' }), advice({ ruleId: 'R7' })],
    { mutedRuleIds: ['R1'], cooldownUntil: {}, inaccurateCounts: {} },
    { localDate: DAY, maxDailyAdvice: 5 },
  );
  assert.deepEqual(
    out.map((a) => a.ruleId),
    ['R7'],
  );
});

test('节流：冷却期内跳过，冷却结束后恢复', () => {
  const feedback = { mutedRuleIds: [], cooldownUntil: { R1: '2026-10-06' }, inaccurateCounts: {} };
  const during = throttleAdvices([advice({ ruleId: 'R1' })], feedback, { localDate: DAY, maxDailyAdvice: 5 });
  assert.deepEqual(during, []);

  const after = throttleAdvices([advice({ ruleId: 'R1' })], feedback, {
    localDate: '2026-10-07',
    maxDailyAdvice: 5,
  });
  assert.equal(after.length, 1);
});

test('节流：被标记“不准”达到 3 次的规则临时停用', () => {
  const out = throttleAdvices(
    [advice({ ruleId: 'R1' })],
    { mutedRuleIds: [], cooldownUntil: {}, inaccurateCounts: { R1: 3 } },
    { localDate: DAY, maxDailyAdvice: 5 },
  );
  assert.deepEqual(out, []);
});

test('节流：同规则去重、按严重度排序、按上限截断', () => {
  const out = throttleAdvices(
    [
      advice({ ruleId: 'R7', severity: 'info' }),
      advice({ ruleId: 'R1', severity: 'warn' }),
      advice({ ruleId: 'R5', severity: 'notice' }),
      advice({ ruleId: 'R9', severity: 'info' }),
      advice({ ruleId: 'R1', severity: 'warn' }),
    ],
    undefined,
    { localDate: DAY, maxDailyAdvice: 3 },
  );
  assert.deepEqual(
    out.map((a) => a.ruleId),
    ['R1', 'R5', 'R7'],
  );
});

test('节流：上限为 0 时至少保留 1 条（不出现空卡片）', () => {
  const out = throttleAdvices([advice({ ruleId: 'R1', severity: 'warn' })], undefined, {
    localDate: DAY,
    maxDailyAdvice: 0,
  });
  assert.equal(out.length, 1);
});

// ---------------------------------------------------------------- 渲染
test('渲染：单币种合计、笔数、分类拆分', () => {
  const card = renderDailyCard({
    metrics: stubMetrics({
      netConvertedTotalMinor: 18_000,
      expenseCount: 3,
      topCategories: [{ categoryId: 'food', amountMinor: 10_000, ratio: 2 / 3 }],
    }),
    advices: [],
    options: { categories: PRESET_CATEGORIES },
  });
  assert.equal(card.title, `今日支出 · ${DAY}`);
  assert.ok(card.summaryLines[0]?.includes('180.00'));
  assert.ok(card.summaryLines[1]?.includes('3 笔'));
  assert.ok(card.categoryLines[0]?.includes('餐饮'));
  assert.equal(card.disclaimers.length, 0);
});

test('渲染：净额为负时显示“退款冲减”，不显示 0', () => {
  const card = renderDailyCard({
    metrics: stubMetrics({ netConvertedTotalMinor: -3_000, negativeNet: true }),
    advices: [],
  });
  assert.ok(card.summaryLines[0]?.includes('净支出为负（退款冲减）'));
  assert.ok(card.summaryLines[0]?.includes('30.00'));
  assert.equal(card.summaryLines[0]?.includes('¥0.00'), false);
});

test('渲染：缺汇率时按币种分组并提示未计入笔数', () => {
  const card = renderDailyCard({
    metrics: stubMetrics({
      netConvertedTotalMinor: null,
      netTotalByCurrency: { CNY: 10_000, USD: 1_000 },
      fxMissingCount: 1,
      fxMissingByCurrency: { USD: 1_000 },
      expenseCount: 2,
    }),
    advices: [],
  });
  const text = card.summaryLines.join('\n');
  assert.ok(text.includes('CNY'));
  assert.ok(text.includes('USD'));
  assert.ok(text.includes('1 笔缺少汇率未计入合计'));
});

test('渲染：待补分类与免責声明只在该出现时出现', () => {
  const withPending = renderDailyCard({
    metrics: stubMetrics({ pendingReviewCount: 3 }),
    advices: [advice({ ruleId: 'R1', severity: 'warn', disclaimerRequired: true })],
  });
  assert.ok(withPending.summaryLines.some((l) => l.includes('3 笔待补充分类')));
  assert.deepEqual(withPending.disclaimers, [DISCLAIMER_TEXT]);

  const plain = renderDailyCard({
    metrics: stubMetrics(),
    advices: [advice({ ruleId: 'R7', severity: 'info' })],
  });
  assert.equal(plain.disclaimers.length, 0);
});

// ---------------------------------------------------------------- 隐私：卡片默认不带商户名
test('隐私：includeMerchant 默认关闭时，卡片不出现商户名', () => {
  const merchant = '某某咖啡店';
  const a = advice({
    ruleId: 'R4',
    severity: 'info',
    title: '发现疑似订阅扣费',
    evidence: { merchant, occurrences: 3, amountMinor: 5_000 },
    suggestions: ['发现 3 次近似金额扣费，可核对是否为自动续费（商户见明细）'],
  });

  const off = renderDailyCard({ metrics: stubMetrics(), advices: [a] });
  assert.equal(cardDisplayText(off).includes(merchant), false);

  const on = renderDailyCard({ metrics: stubMetrics(), advices: [a], options: { includeMerchant: true } });
  assert.equal(cardDisplayText(on).includes(merchant), true);
});

// ---------------------------------------------------------------- 脱敏载荷
const expense: ExpenseValue = {
  billId: 'b1',
  valueMinor: 12_000,
  originalMinor: 12_000,
  currency: 'CNY',
  merchant: '某某咖啡店',
  categoryId: 'food',
  isFixedExpense: false,
  needsReview: false,
};

test('脱敏载荷：只含分类名与金额档位，不含商户/备注/精确金额', () => {
  const metrics = stubMetrics({
    netConvertedTotalMinor: 12_000,
    topCategories: [{ categoryId: 'food', amountMinor: 12_000, ratio: 1 }],
    expenses: [expense],
  });
  const payload = buildLlmPayload({
    advices: [advice({ ruleId: 'R1', evidence: { merchant: '某某咖啡店', categoryLabel: '餐饮' } })],
    metrics,
  });
  const text = JSON.stringify(payload);

  assert.equal(text.includes('某某咖啡店'), false);
  assert.equal(text.includes('12000'), false); // 不含精确金额
  assert.ok(payload.categories.includes('餐饮'));
  assert.ok(payload.amountBuckets.includes('100-500'));
  assert.equal(payload.templateIds.includes('R1'), true);
  assert.doesNotThrow(() => assertNoForbiddenContent(payload, ['某某咖啡店']));
});

test('脱敏校验闸门：出现禁用字段或敏感值即抛错', () => {
  for (const key of FORBIDDEN_LLM_KEYS) {
    assert.throws(
      () => assertNoForbiddenContent({ nested: { [key]: 'x' } }),
      /脱敏校验失败/,
      `字段 ${key} 应被拦截`,
    );
  }
  assert.throws(() => assertNoForbiddenContent({ note: '含商户某某咖啡店' }, ['某某咖啡店']), /脱敏校验失败/);
  assert.doesNotThrow(() => assertNoForbiddenContent({ categories: ['餐饮'], buckets: ['<50'] }, ['某某咖啡店']));
});

test('金额档位化：不泄露精确金额', () => {
  assert.equal(bucketAmountMinor(1_000, 'CNY'), '<50');
  assert.equal(bucketAmountMinor(12_000, 'CNY'), '100-500');
  assert.equal(bucketAmountMinor(60_000, 'CNY'), '500-1000');
  assert.equal(bucketAmountMinor(9_999_999, 'CNY'), '>=5000');
  assert.equal(bucketAmountMinor(-12_000, 'CNY'), '100-500');
});

test('配置：默认不把任何个人设置写死为不可变项', () => {
  const cfg = makeConfig();
  assert.equal(typeof cfg.push.time, 'string');
  assert.equal(Array.isArray(cfg.push.channels), true);
  assert.equal(cfg.money.multiCurrency, false); // 默认值可被引导向导覆盖
  assert.equal(cfg.analysis.refundPolicy, 'B');
});

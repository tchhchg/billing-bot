import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBaseline, referenceBaseline, referenceBaselineDetail } from '../src/domain/analysis/baseline.ts';
import { addDays } from '../src/domain/analysis/period.ts';
import { makeBaseline, makeConfig } from './helpers.ts';

const cfg = makeConfig().analysis;

test('样本不足 → 冷启动，基线为 null（宁可不出结论）', () => {
  const b = computeBaseline({ '2026-10-01': 10_000, '2026-10-02': 20_000 }, '2026-10-03', cfg);
  assert.equal(b.sampleDays, 2);
  assert.equal(b.coldStart, true);
  assert.equal(b.p7, null);
  assert.equal(b.p28, null);
  assert.equal(b.sameWeekday, null);
});

test('近 7 日基线只按“有账单的天”平均，不把空白日当 0', () => {
  const b = computeBaseline({ '2026-10-01': 10_000, '2026-10-02': 20_000, '2026-10-03': 30_000 }, '2026-10-04', cfg);
  assert.equal(b.sampleDays, 3);
  assert.equal(b.coldStart, false);
  assert.equal(b.p7, 20_000); // 而不是 60000/7
  assert.equal(b.p28, null); // 近 28 日需要 14 天样本
});

test('近 28 日基线在样本达标后可算', () => {
  const daily: Record<string, number> = {};
  for (let i = 14; i >= 1; i -= 1) {
    daily[addDays('2026-10-02', 1 - i)] = 1_000; // 2026-09-19 ~ 2026-10-02，共 14 天
  }
  const b = computeBaseline(daily, '2026-10-03', cfg);
  assert.equal(b.sampleDays, 14);
  assert.equal(b.p28, 1_000);
  assert.equal(b.p7, 1_000);
});

test('同星期几基线需要至少 3 次样本', () => {
  const daily = { '2026-09-12': 5_000, '2026-09-19': 6_000, '2026-09-26': 7_000 };
  const b = computeBaseline(daily, '2026-10-03', cfg); // 10-03 是周六
  assert.equal(b.sameWeekday, 6_000);
  assert.equal(b.p7, null); // 近 7 日无样本
  assert.equal(b.coldStart, false);

  const b2 = computeBaseline({ '2026-09-19': 6_000, '2026-09-26': 7_000 }, '2026-10-03', cfg);
  assert.equal(b2.sameWeekday, null);
});

test('参照基线优先同星期几 > 近 7 日 > 近 28 日，并遵守配置窗口', () => {
  const b = makeBaseline({ sameWeekday: 300, p7: 200, p28: 100, sampleDays: 30, coldStart: false });
  assert.deepEqual(referenceBaselineDetail(b, ['same_weekday', 'p7', 'p28']), {
    kind: 'same_weekday',
    value: 300,
  });
  assert.deepEqual(referenceBaselineDetail(b, ['p7', 'p28']), { kind: 'p7', value: 200 });
  assert.deepEqual(referenceBaselineDetail(b, ['p28']), { kind: 'p28', value: 100 });
  assert.equal(referenceBaseline(b, ['p7', 'p28']), 200);

  // 配置窗口里的基线都不可用时返回 null，而不是悄悄降级到别的口径
  const noP7 = makeBaseline({ sameWeekday: null, p7: null, p28: 100, sampleDays: 30, coldStart: false });
  assert.equal(referenceBaselineDetail(noP7, ['same_weekday', 'p7']), null);
});

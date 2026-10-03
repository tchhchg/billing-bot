import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  dayWindow,
  daysBetween,
  eachDate,
  endOfMonth,
  isWithinDay,
  localDateOf,
  parseDate,
  previousDays,
  startOfMonth,
  startOfWeek,
  todayLocal,
  weekdayOf,
  zonedStartOfDay,
} from '../src/domain/analysis/period.ts';

test('同一瞬时在不同时区属于不同自然日', () => {
  const instant = '2026-10-03T00:30:00+08:00'; // = 2026-10-02T16:30Z
  assert.equal(localDateOf(instant, 'Asia/Shanghai'), '2026-10-03');
  assert.equal(localDateOf(instant, 'UTC'), '2026-10-02');
  assert.equal(localDateOf(instant, 'America/New_York'), '2026-10-02');
});

test('自然日窗口以用户时区切分（跨零点归属）', () => {
  const w = dayWindow('2026-10-03', 'Asia/Shanghai');
  assert.equal(w.startMs, Date.parse('2026-10-02T16:00:00Z'));
  assert.equal(w.endMs, Date.parse('2026-10-03T16:00:00Z'));

  // 本地 23:59 属于当天，次日 00:00 属于次日
  assert.equal(isWithinDay('2026-10-03T15:59:00Z', '2026-10-03', 'Asia/Shanghai'), true);
  assert.equal(isWithinDay('2026-10-03T16:00:00Z', '2026-10-03', 'Asia/Shanghai'), false);
  assert.equal(isWithinDay('2026-10-03T16:00:00Z', '2026-10-04', 'Asia/Shanghai'), true);
});

test('DST 春季前移：本地自然日只有 23 小时', () => {
  const w = dayWindow('2026-03-08', 'America/New_York');
  assert.equal(w.startMs, Date.parse('2026-03-08T05:00:00Z')); // 00:00 EST
  assert.equal(w.endMs, Date.parse('2026-03-09T04:00:00Z')); // 次日 00:00 EDT
  assert.equal((w.endMs - w.startMs) / 3_600_000, 23);

  assert.equal(isWithinDay('2026-03-08T04:30:00Z', '2026-03-08', 'America/New_York'), false);
  assert.equal(isWithinDay('2026-03-08T05:30:00Z', '2026-03-08', 'America/New_York'), true);
  assert.equal(isWithinDay('2026-03-09T03:30:00Z', '2026-03-08', 'America/New_York'), true);
  assert.equal(isWithinDay('2026-03-09T04:30:00Z', '2026-03-08', 'America/New_York'), false);
});

test('DST 秋季回拨：本地自然日有 25 小时', () => {
  const w = dayWindow('2026-11-01', 'America/New_York');
  assert.equal((w.endMs - w.startMs) / 3_600_000, 25);
});

test('zonedStartOfDay 在无 DST 时区稳定', () => {
  assert.equal(zonedStartOfDay('2026-10-03', 'Asia/Shanghai'), Date.parse('2026-10-02T16:00:00Z'));
  assert.equal(zonedStartOfDay('2026-01-01', 'Asia/Shanghai'), Date.parse('2025-12-31T16:00:00Z'));
});

test('日历加减：跨月、跨年、闰日', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29'); // 闰年
  assert.equal(addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
  assert.equal(addDays('2026-10-03', -33), '2026-08-31');
});

test('星期与区间计算', () => {
  assert.equal(weekdayOf('2026-10-03'), 6); // 周六
  assert.equal(weekdayOf('2026-09-28'), 1); // 周一
  assert.equal(daysBetween('2026-10-01', '2026-10-03'), 2);
  assert.equal(daysBetween('2026-10-03', '2026-10-01'), -2);
  assert.deepEqual(previousDays('2026-10-03', 3), ['2026-09-30', '2026-10-01', '2026-10-02']);
  assert.deepEqual(eachDate('2026-10-30', '2026-11-02'), [
    '2026-10-30',
    '2026-10-31',
    '2026-11-01',
    '2026-11-02',
  ]);
});

test('周期边界：月首月末、周起点（周一）', () => {
  assert.equal(startOfMonth('2026-10-17'), '2026-10-01');
  assert.equal(endOfMonth('2026-10-17'), '2026-10-31');
  assert.equal(endOfMonth('2026-02-10'), '2026-02-28');
  assert.equal(endOfMonth('2028-02-10'), '2028-02-29');
  assert.equal(startOfWeek('2026-10-03'), '2026-09-28'); // 周六 → 本周一
  assert.equal(startOfWeek('2026-09-28'), '2026-09-28'); // 周一 → 自身
  assert.equal(startOfWeek('2026-10-04'), '2026-09-28'); // 周日 → 本周一
});

test('todayLocal 用用户时区判断“今天”', () => {
  const nowMs = Date.parse('2026-10-03T16:30:00Z');
  assert.equal(todayLocal('Asia/Shanghai', nowMs), '2026-10-04');
  assert.equal(todayLocal('UTC', nowMs), '2026-10-03');
});

test('parseDate 拒绝非法输入', () => {
  assert.deepEqual(parseDate('2026-10-03'), { year: 2026, month: 10, day: 3 });
  assert.throws(() => parseDate('2026/10/03'), RangeError);
  assert.throws(() => parseDate('2026-1-3'), RangeError);
});

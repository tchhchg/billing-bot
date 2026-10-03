import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler, dueInstantForDate, isInQuietHours } from '../src/infra/scheduler/scheduler.ts';

const TZ = 'Asia/Shanghai';

test('免打扰判断：普通区间与跨零点区间', () => {
  assert.equal(isInQuietHours('23:00', ['22:30', '07:30']), true);
  assert.equal(isInQuietHours('02:00', ['22:30', '07:30']), true);
  assert.equal(isInQuietHours('07:29', ['22:30', '07:30']), true);
  assert.equal(isInQuietHours('07:30', ['22:30', '07:30']), false);
  assert.equal(isInQuietHours('21:00', ['22:30', '07:30']), false);
  // 不跨零点
  assert.equal(isInQuietHours('13:00', ['12:00', '14:00']), true);
  assert.equal(isInQuietHours('15:00', ['12:00', '14:00']), false);
  // 起止相同视为不启用
  assert.equal(isInQuietHours('13:00', ['12:00', '12:00']), false);
});

test('执行时刻：不在免打扰内 → 就是配置时间', () => {
  const due = dueInstantForDate('2026-10-03', { time: '21:00', timeZone: TZ, quietHours: ['22:30', '07:30'] });
  assert.equal(due, Date.parse('2026-10-03T21:00:00+08:00'));
});

test('执行时刻：配置时间在晚间免打扰内 → 顺延到次日免打扰结束', () => {
  const due = dueInstantForDate('2026-10-03', { time: '23:00', timeZone: TZ, quietHours: ['22:30', '07:30'] });
  assert.equal(due, Date.parse('2026-10-04T07:30:00+08:00'));
});

test('执行时刻：配置时间在凌晨免打扰内 → 顺延到当日免打扰结束', () => {
  const due = dueInstantForDate('2026-10-03', { time: '06:00', timeZone: TZ, quietHours: ['22:30', '07:30'] });
  assert.equal(due, Date.parse('2026-10-03T07:30:00+08:00'));
});

test('执行时刻：非法时间抛错', () => {
  assert.throws(() => dueInstantForDate('2026-10-03', { time: '25:00', timeZone: TZ, quietHours: ['22:30', '07:30'] }), RangeError);
});

function schedulerWith(clock: { now: number }): { scheduler: ReturnType<typeof createScheduler>; runs: string[]; catchUps: number[] } {
  const runs: string[] = [];
  const catchUps: number[] = [];
  const scheduler = createScheduler({
    timeZone: TZ,
    time: '21:00',
    quietHours: ['22:30', '07:30'],
    now: () => new Date(clock.now),
    onRun: async (date: string) => {
      runs.push(date);
    },
    onCatchUp: async ({ maxDays }) => {
      catchUps.push(maxDays);
    },
    log: () => {},
  });
  return { scheduler, runs, catchUps };
}

test('调度：到点前不执行，到点后执行一次，同一天不重复', async () => {
  const clock = { now: Date.parse('2026-10-03T20:59:00+08:00') };
  const { scheduler, runs } = schedulerWith(clock);

  const before = await scheduler.tick();
  assert.equal(before.ran, true, '首次 tick 会做一次漏跑补跑');
  assert.match(before.note, /补跑完成/);
  assert.deepEqual(runs, [], '补跑不应生成今天的日报');

  clock.now = Date.parse('2026-10-03T21:00:00+08:00');
  const atTime = await scheduler.tick();
  assert.equal(atTime.ran, true);
  assert.deepEqual(runs, ['2026-10-03']);

  clock.now = Date.parse('2026-10-03T23:30:00+08:00');
  const again = await scheduler.tick();
  assert.equal(again.ran, false);
  assert.equal(again.note, '今天已经跑过');
  assert.equal(runs.length, 1);
});

test('调度：跨到第二天会重新执行', async () => {
  const clock = { now: Date.parse('2026-10-03T21:00:00+08:00') };
  const { scheduler, runs } = schedulerWith(clock);
  await scheduler.tick();

  clock.now = Date.parse('2026-10-04T21:00:00+08:00');
  await scheduler.tick();
  assert.deepEqual(runs, ['2026-10-03', '2026-10-04']);
});

test('调度：漏跑补跑只在首次与跨天时触发，不与正常执行互相阻塞', async () => {
  const clock = { now: Date.parse('2026-10-03T20:00:00+08:00') };
  const { scheduler, runs, catchUps } = schedulerWith(clock);

  await scheduler.tick();
  assert.deepEqual(catchUps, [1], '首次 tick 应补跑一次');
  assert.deepEqual(runs, [], '但今天还没到点，不该生成当天日报');

  await scheduler.tick();
  assert.deepEqual(catchUps, [1], '同一天不应反复补跑');

  clock.now = Date.parse('2026-10-03T21:05:00+08:00');
  await scheduler.tick();
  assert.deepEqual(runs, ['2026-10-03'], '补跑不能吃掉当天的正常执行');

  clock.now = Date.parse('2026-10-04T20:00:00+08:00');
  await scheduler.tick();
  assert.deepEqual(catchUps, [1, 1], '跨天后应再补一次');
});

test('调度：并发 tick 会被挡住，避免重复执行', async () => {
  const clock = { now: Date.parse('2026-10-03T22:00:00+08:00') };
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runs: string[] = [];
  const scheduler = createScheduler({
    timeZone: TZ,
    time: '21:00',
    quietHours: ['22:30', '07:30'],
    now: () => new Date(clock.now),
    onRun: async (date: string) => {
      await gate;
      runs.push(date);
    },
    log: () => {},
  });

  const first = scheduler.tick();
  const second = await scheduler.tick();
  assert.equal(second.ran, false);
  assert.match(second.note, /尚未结束/);
  release();
  await first;
  assert.deepEqual(runs, ['2026-10-03']);
});

test('调度状态：报告下次执行时间', async () => {
  const clock = { now: Date.parse('2026-10-03T21:30:00+08:00') };
  const { scheduler } = schedulerWith(clock);
  const state = scheduler.state();
  assert.equal(state.nextDueAt, Date.parse('2026-10-04T21:00:00+08:00'));
  assert.equal(state.lastRunDate, null);
});

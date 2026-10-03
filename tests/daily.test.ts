import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/infra/db/database.ts';
import { createBillRepo } from '../src/infra/db/billRepo.ts';
import { createCategoryRepo } from '../src/infra/db/categoryRepo.ts';
import { createRunRepo } from '../src/infra/db/runRepo.ts';
import { createFxRepo } from '../src/infra/db/fxRepo.ts';
import { createFeedbackRepo } from '../src/infra/db/feedbackRepo.ts';
import { catchUp, runDailyAnalysis, type DailyDeps } from '../src/app/runDailyAnalysis.ts';
import { toAppSettings, runKeyOf } from '../src/app/settings.ts';
import { defaultConfigDraft, setByPath } from '../src/infra/config/schema.ts';
import { PRESET_CATEGORIES } from '../src/domain/category.ts';
import { cardDisplayText } from '../src/domain/advice/render.ts';
import { addDays } from '../src/domain/analysis/period.ts';
import type { ChannelAdapter, ChannelPayload, SendResult } from '../src/channels/adapter.ts';
import { createLocalDailyCenterAdapter } from '../src/channels/localCenter.ts';
import { makeBill } from './helpers.ts';

const NOW_MS = Date.parse('2026-10-03T13:00:00.000Z');
const TZ = 'Asia/Shanghai';
const TODAY = '2026-10-03';

interface FakeChannel extends ChannelAdapter {
  sent: ChannelPayload[];
}

function fakeChannel(id: string, ok = true): FakeChannel {
  const sent: ChannelPayload[] = [];
  return {
    id,
    sent,
    capabilities: () => ({ interactive: true, maxBlocks: 100, supportsCallbacks: false }),
    async send(payload: ChannelPayload): Promise<SendResult> {
      sent.push(payload);
      return { channel: id, ok, detail: ok ? 'ok' : '模拟失败' };
    },
  };
}

function depsWith(channels: ChannelAdapter[], nowMs = NOW_MS) {
  const db = openDatabase(':memory:');
  const deps: DailyDeps = {
    bills: createBillRepo(db),
    categories: createCategoryRepo(db),
    runs: createRunRepo(db),
    feedback: createFeedbackRepo(db),
    fx: createFxRepo(db),
    channels,
    now: () => new Date(nowMs),
    log: () => {},
  };
  deps.categories.seedPreset(PRESET_CATEGORIES, new Date(nowMs).toISOString());
  return { db, deps };
}

function settingsWith(over: (draft: Record<string, unknown>) => void = () => {}) {
  const draft = defaultConfigDraft();
  setByPath(draft, 'push.timezone', TZ);
  over(draft);
  return toAppSettings(draft);
}

/** 造 14 天历史（每天 100.00 餐饮），用于产生可用基线 */
function seedHistory(deps: DailyDeps, days = 14, amountMinor = 10_000): void {
  for (let i = days; i >= 1; i -= 1) {
    deps.bills.insert(
      makeBill({
        billId: `h${i}`,
        amountMinor,
        categoryId: 'food',
        merchant: '食堂',
        occurredAt: `${addDays(TODAY, -i)}T12:00:00+08:00`,
      }),
    );
  }
}

// ---------------------------------------------------------------- 无数据日
test('某日无账单：发"是否补记"而不是 0 元结论，且记录已完成', async () => {
  const local = createLocalDailyCenterAdapter();
  const { db, deps } = depsWith([local]);
  const settings = settingsWith();
  const outcome = await runDailyAnalysis(deps, settings);

  assert.equal(outcome.status, 'pushed');
  assert.equal(outcome.note, '无数据日提示');
  assert.equal(outcome.advices?.[0]?.ruleId, 'R8');
  assert.equal(outcome.metrics?.netConvertedTotalMinor, 0);
  assert.equal(deps.runs.get(runKeyOf(TODAY, settings))?.pushStatus, 'pushed');
  db.close();
});

test('配置为静默时：无数据日不推送，但记录状态避免补跑反复尝试', async () => {
  const im = fakeChannel('im_card');
  const { db, deps } = depsWith([im]);
  const settings = settingsWith((d) => {
    setByPath(d, 'push.noDataNotice', false);
    setByPath(d, 'push.channels', ['im_card', 'local_daily_center']);
  });
  const outcome = await runDailyAnalysis(deps, settings);

  assert.equal(outcome.status, 'skipped_no_data');
  assert.equal(im.sent.length, 0);
  const record = deps.runs.get(runKeyOf(TODAY, settings));
  assert.equal(record?.advicesJson, '[]');
  assert.equal(record?.pushedAt, null);
  db.close();
});

// ---------------------------------------------------------------- 正常日
test('有账单：产出建议、推送并落盘快照', async () => {
  const im = fakeChannel('im_card');
  const { db, deps } = depsWith([im, createLocalDailyCenterAdapter()]);
  const settings = settingsWith((d) => setByPath(d, 'push.channels', ['im_card', 'local_daily_center']));
  seedHistory(deps);
  deps.bills.insert(
    makeBill({ billId: 'today', amountMinor: 50_000, categoryId: 'food', merchant: '某咖啡店', occurredAt: `${TODAY}T12:00:00+08:00` }),
  );

  const outcome = await runDailyAnalysis(deps, settings);
  assert.equal(outcome.status, 'pushed');
  assert.equal(outcome.metrics?.netConvertedTotalMinor, 50_000);
  assert.ok(outcome.advices?.some((a) => a.ruleId === 'R1'), '应触发单日超基线');
  assert.equal(im.sent.length, 1);
  assert.equal(im.sent[0]?.revision, 1);

  const record = deps.runs.get(runKeyOf(TODAY, settings));
  assert.ok(record?.pushedAt);
  assert.ok((record?.metricsJson ?? '').includes('50000'));
  db.close();
});

test('隐私：真实管线产出的卡片文本默认不含商户名', async () => {
  const { db, deps } = depsWith([createLocalDailyCenterAdapter()]);
  const settings = settingsWith();
  seedHistory(deps);
  deps.bills.insert(
    makeBill({ billId: 'today', amountMinor: 50_000, categoryId: 'food', merchant: '某咖啡店', occurredAt: `${TODAY}T12:00:00+08:00` }),
  );
  const outcome = await runDailyAnalysis(deps, settings);
  assert.ok(outcome.card);
  assert.equal(cardDisplayText(outcome.card).includes('某咖啡店'), false);
  db.close();
});

// ---------------------------------------------------------------- 幂等
test('同一天重复运行：数据没变则直接跳过，不重复推送', async () => {
  const im = fakeChannel('im_card');
  const { db, deps } = depsWith([im]);
  const settings = settingsWith((d) => setByPath(d, 'push.channels', ['im_card', 'local_daily_center']));
  deps.bills.insert(makeBill({ billId: 'a', amountMinor: 5_000, occurredAt: `${TODAY}T12:00:00+08:00` }));

  const first = await runDailyAnalysis(deps, settings);
  assert.equal(first.status, 'pushed');
  const second = await runDailyAnalysis(deps, settings);
  assert.equal(second.status, 'skipped_already_run');
  assert.equal(im.sent.length, 1);
  db.close();
});

test('推送后账单被修改：发"修正版"而不是重复发一条', async () => {
  const im = fakeChannel('im_card');
  const { db, deps } = depsWith([im]);
  const settings = settingsWith((d) => setByPath(d, 'push.channels', ['im_card', 'local_daily_center']));
  const bill = makeBill({ billId: 'a', amountMinor: 5_000, occurredAt: `${TODAY}T12:00:00+08:00` });
  deps.bills.insert(bill);

  await runDailyAnalysis(deps, settings);

  // 晚上 22:00 补记/改了一笔 → updatedAt 晚于推送时间
  deps.bills.update({ ...bill, amountMinor: 8_000, updatedAt: `${TODAY}T22:00:00+08:00` }, 1);

  const second = await runDailyAnalysis(deps, settings);
  assert.equal(second.status, 'revised');
  assert.equal(second.card?.advices.length !== undefined, true);
  assert.equal(im.sent.length, 2);
  assert.equal(im.sent[1]?.revision, 2);
  db.close();
});

test('改了配置：幂等键变化，允许当日重算一次', async () => {
  const im = fakeChannel('im_card');
  const { db, deps } = depsWith([im]);
  const before = settingsWith((d) => setByPath(d, 'push.channels', ['im_card', 'local_daily_center']));
  deps.bills.insert(makeBill({ billId: 'a', amountMinor: 5_000, occurredAt: `${TODAY}T12:00:00+08:00` }));

  const first = await runDailyAnalysis(deps, before);
  assert.equal(first.status, 'pushed');

  const after = settingsWith((d) => {
    setByPath(d, 'push.channels', ['im_card', 'local_daily_center']);
    setByPath(d, 'push.maxDailyAdvice', 1);
  });
  assert.notEqual(runKeyOf(TODAY, before), runKeyOf(TODAY, after));

  const second = await runDailyAnalysis(deps, after);
  assert.equal(second.status, 'pushed');
  assert.equal(im.sent.length, 2);
  db.close();
});

test('force 与 dryRun：强制重算会推送；dry-run 不推送也不写记录', async () => {
  const im = fakeChannel('im_card');
  const { db, deps } = depsWith([im]);
  const settings = settingsWith((d) => setByPath(d, 'push.channels', ['im_card', 'local_daily_center']));
  deps.bills.insert(makeBill({ billId: 'a', amountMinor: 5_000, occurredAt: `${TODAY}T12:00:00+08:00` }));

  await runDailyAnalysis(deps, settings);
  assert.equal(im.sent.length, 1);

  const forced = await runDailyAnalysis(deps, settings, { force: true });
  assert.equal(forced.status, 'revised');
  assert.equal(im.sent.length, 2);
  db.close();

  const fresh = depsWith([im]);
  const dry = await runDailyAnalysis(fresh.deps, settings, { dryRun: true });
  assert.equal(dry.status, 'pushed');
  assert.equal(im.sent.length, 2, 'dry-run 不应真的发送');
  assert.equal(fresh.deps.runs.get(runKeyOf(TODAY, settings)), null, 'dry-run 不应写运行记录');
  fresh.db.close();
});

// ---------------------------------------------------------------- 降级
test('IM 通道失败时降级到本地日报中心，内容不丢', async () => {
  const broken = fakeChannel('im_card', false);
  const local = createLocalDailyCenterAdapter();
  const { db, deps } = depsWith([broken, local]);
  const settings = settingsWith((d) => setByPath(d, 'push.channels', ['im_card', 'local_daily_center']));
  deps.bills.insert(makeBill({ billId: 'a', amountMinor: 5_000, occurredAt: `${TODAY}T12:00:00+08:00` }));

  const outcome = await runDailyAnalysis(deps, settings);
  assert.equal(outcome.status, 'pushed');
  assert.equal(outcome.results?.[0]?.ok, false);
  assert.equal(outcome.results?.[1]?.ok, true);
  const record = deps.runs.get(runKeyOf(TODAY, settings));
  assert.equal(record?.channel, 'local_daily_center');
  assert.ok(record?.metricsJson.includes('5000'));
  db.close();
});

// ---------------------------------------------------------------- 补跑
test('休眠补跑：只回补最近 N 天，且不会重复推送已完成的日期', async () => {
  const im = fakeChannel('im_card');
  const { db, deps } = depsWith([im]);
  const settings = settingsWith((d) => setByPath(d, 'push.channels', ['im_card', 'local_daily_center']));
  for (let i = 3; i >= 1; i -= 1) {
    deps.bills.insert(
      makeBill({ billId: `d${i}`, amountMinor: 5_000, occurredAt: `${addDays(TODAY, -i)}T12:00:00+08:00` }),
    );
  }

  const outcomes = await catchUp(deps, settings, { maxDays: 2 });
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0]?.localDate, addDays(TODAY, -2));
  assert.equal(outcomes[1]?.localDate, addDays(TODAY, -1));
  assert.equal(im.sent.length, 2);

  const again = await catchUp(deps, settings, { maxDays: 2 });
  assert.deepEqual(
    again.map((o) => o.status),
    ['skipped_already_run', 'skipped_already_run'],
  );
  assert.equal(im.sent.length, 2);
  db.close();
});

// ---------------------------------------------------------------- 多币种真实管线
test('多币种缺汇率：日报给出分币种结果并提示未计入笔数', async () => {
  const { db, deps } = depsWith([createLocalDailyCenterAdapter()]);
  const settings = settingsWith((d) => setByPath(d, 'money.multiCurrency', true));
  deps.bills.insert(makeBill({ billId: 'cny', amountMinor: 10_000, occurredAt: `${TODAY}T12:00:00+08:00` }));
  deps.bills.insert(
    makeBill({ billId: 'usd', amountMinor: 1_000, currency: 'USD', occurredAt: `${TODAY}T13:00:00+08:00` }),
  );

  const outcome = await runDailyAnalysis(deps, settings);
  assert.equal(outcome.metrics?.netConvertedTotalMinor, null);
  assert.equal(outcome.metrics?.fxMissingCount, 1);
  assert.deepEqual(outcome.metrics?.netTotalByCurrency, { CNY: 10_000, USD: 1_000 });
  assert.ok(outcome.card?.summaryLines.some((l) => l.includes('缺少汇率')));
  db.close();
});

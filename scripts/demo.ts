/**
 * 演示脚本：造一批示例账单一键跑通「导入 → 分析 → 日报」，用于人工查看界面。
 * 只用临时数据目录，不碰正式数据。
 *
 *   node scripts/demo.ts
 */
import { createApp } from '../src/main.ts';
import { randomUUID } from 'node:crypto';
import { addDays, todayLocal } from '../src/domain/analysis/period.ts';
import type { Bill } from '../src/domain/types.ts';

const TZ = 'Asia/Shanghai';
const token = 'demo-token';
const port = Number(process.env.DEMO_PORT ?? '8792');

const app = await createApp({
  dataDir: process.env.BILLING_BOT_HOME,
  token,
  port,
  withScheduler: false,
  log: (m) => console.log(m),
});

const baseCurrency = app.settings().money.baseCurrency;
const today = todayLocal(TZ);
const nowIso = new Date().toISOString();

if (app.repos.bills.count() === 0) {
  const seed = (over: Partial<Bill> & { amountMinor: number; occurredAt: string }): Bill => ({
    billId: randomUUID(),
    amountMinor: over.amountMinor,
    currency: over.currency ?? baseCurrency,
    direction: over.direction ?? 'expense',
    categoryId: over.categoryId ?? 'food',
    occurredAt: over.occurredAt,
    merchant: over.merchant ?? null,
    accountId: null,
    paymentMethod: null,
    tags: [],
    note: over.note ?? null,
    source: over.source ?? 'manual',
    sourceRef: null,
    refundOf: over.refundOf ?? null,
    status: over.status ?? 'normal',
    recurringId: null,
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    deletedAt: null,
  });

  // 20 天历史：每天餐饮 100 元左右
  for (let i = 20; i >= 1; i -= 1) {
    const day = addDays(today, -i);
    app.repos.bills.insert(seed({ amountMinor: 9_000 + i * 100, occurredAt: `${day}T12:30:00+08:00`, merchant: '公司食堂' }));
    if (i % 3 === 0) {
      app.repos.bills.insert(
        seed({ amountMinor: 3_000, categoryId: 'transport', occurredAt: `${day}T18:10:00+08:00`, merchant: '地铁' }),
      );
    }
  }
  // 今天：一笔大额 + 一笔小额 + 一笔退款 + 一笔固定支出
  app.repos.bills.insert(seed({ amountMinor: 68_000, categoryId: 'shopping', occurredAt: `${today}T21:05:00+08:00`, merchant: '某数码店', note: '耳机' }));
  app.repos.bills.insert(seed({ amountMinor: 3_800, categoryId: 'food', occurredAt: `${today}T12:30:00+08:00`, merchant: '某餐厅' }));
  app.repos.bills.insert(seed({ amountMinor: 30_000, categoryId: 'housing.rent', occurredAt: `${today}T09:00:00+08:00`, merchant: '房东' }));
  app.repos.bills.insert(
    seed({
      amountMinor: 12_000,
      direction: 'income',
      refundOf: 'unlinked',
      categoryId: 'shopping',
      occurredAt: `${today}T22:00:00+08:00`,
      merchant: '某网店',
    }),
  );
  // 一笔未分类，触发数据质量提醒
  app.repos.bills.insert(seed({ amountMinor: 5_600, categoryId: null, status: 'pending_review', occurredAt: `${today}T19:00:00+08:00`, merchant: '某便利店' }));

  app.store.save(
    (await import('../src/infra/config/schema.ts')).defaultConfigDraft(),
  );
  const draft = app.store.load()!.draft;
  const { setByPath } = await import('../src/infra/config/schema.ts');
  setByPath(draft, 'push.timezone', TZ);
  setByPath(draft, 'push.time', '21:00');
  setByPath(draft, 'push.channels', ['local_daily_center']);
  setByPath(draft, 'push.noDataNotice', true);
  setByPath(draft, 'analysis.fixedExpenseWhitelist', ['房东']);
  setByPath(draft, 'budget.enabled', true);
  setByPath(draft, 'budget.items', [{ categoryId: null, limitMinor: 600_000 }]);
  app.store.save(draft);
  console.log('[demo] 已写入示例账单并完成配置');
}

const outcome = await app.runDaily({ force: true });
console.log(`[demo] 日报状态：${outcome.status}，建议 ${outcome.advices?.length ?? 0} 条`);
for (const advice of outcome.advices ?? []) {
  console.log(`       [${advice.ruleId}] ${advice.title}`);
}
console.log(`[demo] 界面地址：http://127.0.0.1:${port}/?token=${token}`);

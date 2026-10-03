/**
 * 用示例数据推一张"完整形态"的日报到飞书（不碰真实数据库）。
 *
 *   BB_DEMO_HOME=<目录> node scripts/demo-push.ts
 *
 * 前提：该目录里已有 config.json 与 secrets.json（从真实数据目录复制过来即可）。
 * 这里刻意**不覆盖配置**，所以飞书凭证与接收人都是现成的。
 */
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/main.ts';
import { addDays, todayLocal } from '../src/domain/analysis/period.ts';
import type { Bill } from '../src/domain/types.ts';

const app = await createApp({
  dataDir: process.env.BB_DEMO_HOME,
  withServer: false,
  withScheduler: false,
  log: (m) => console.log(m),
});

const settings = app.settings();
const tz = settings.push.timezone;
const currency = settings.money.baseCurrency;
const today = todayLocal(tz);
const nowIso = new Date().toISOString();

const seed = (over: Partial<Bill> & { amountMinor: number; occurredAt: string }): Bill => ({
  billId: randomUUID(),
  amountMinor: over.amountMinor,
  currency: over.currency ?? currency,
  direction: over.direction ?? 'expense',
  categoryId: over.categoryId === undefined ? 'food' : over.categoryId,
  occurredAt: over.occurredAt,
  merchant: over.merchant ?? null,
  accountId: null,
  paymentMethod: null,
  tags: [],
  note: over.note ?? null,
  source: over.source ?? 'import',
  sourceRef: over.sourceRef ?? null,
  refundOf: over.refundOf ?? null,
  status: over.status ?? 'normal',
  recurringId: null,
  version: 1,
  createdAt: nowIso,
  updatedAt: nowIso,
  deletedAt: null,
});

if (app.repos.bills.count() === 0) {
  // 20 天历史，建立可用基线
  for (let i = 20; i >= 1; i -= 1) {
    const day = addDays(today, -i);
    app.repos.bills.insert(seed({ amountMinor: 8_500 + i * 120, categoryId: 'food', occurredAt: `${day}T12:20:00+08:00`, merchant: '公司食堂' }));
    if (i % 4 === 0) {
      app.repos.bills.insert(seed({ amountMinor: 2_600, categoryId: 'transport', occurredAt: `${day}T18:40:00+08:00`, merchant: '地铁' }));
    }
  }
  // 今天：一笔大额 + 日常 + 5 笔小额（触发 R1 / R6 / R9）+ 3 笔未分类（触发 R7）
  app.repos.bills.insert(seed({ amountMinor: 68_000, categoryId: 'shopping', occurredAt: `${today}T21:05:00+08:00`, merchant: '某数码店', note: '耳机' }));
  app.repos.bills.insert(seed({ amountMinor: 3_800, categoryId: 'food', occurredAt: `${today}T12:30:00+08:00`, merchant: '某餐厅', note: '午餐' }));
  for (let i = 0; i < 5; i += 1) {
    app.repos.bills.insert(seed({ amountMinor: 900 + i * 100, categoryId: 'food.drinks', occurredAt: `${today}T${String(9 + i).padStart(2, '0')}:15:00+08:00`, merchant: '某咖啡' }));
  }
  for (let i = 0; i < 3; i += 1) {
    app.repos.bills.insert(
      seed({ amountMinor: 1_500 + i * 300, categoryId: null, status: 'pending_review', occurredAt: `${today}T${String(15 + i).padStart(2, '0')}:00:00+08:00`, merchant: '某便利店' }),
    );
  }
  console.log(`[demo] 已写入示例账单：${app.repos.bills.count()} 条`);
} else {
  console.log(`[demo] 目录里已有 ${app.repos.bills.count()} 条账单，直接推送`);
}

console.log(`[demo] 推送渠道：${app.channels().map((c) => c.id).join('、')}｜接收人：${settings.host.receiveId || '(未设置)'}`);
const outcome = await app.runDaily({ force: true });
console.log(`[demo] 状态 ${outcome.status}｜${outcome.localDate}｜建议 ${outcome.advices?.length ?? 0} 条`);
for (const advice of outcome.advices ?? []) {
  console.log(`       [${advice.ruleId}] ${advice.title}`);
}
for (const result of outcome.results ?? []) {
  console.log(`  ${result.ok ? '✅' : '❌'} ${result.channel}：${result.detail ?? ''}`);
}
await app.close();

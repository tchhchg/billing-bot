import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, SECRET_FEISHU_APP_SECRET, type AppHandle } from '../src/main.ts';

const TOKEN = 'test-token-123';

async function withApp(fn: (app: AppHandle, base: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'billing-app-'));
  const app = await createApp({
    dataDir: dir,
    withScheduler: false,
    withServer: true,
    token: TOKEN,
    port: 0,
    log: () => {},
  });
  const base = `http://127.0.0.1:${app.server?.port}`;
  try {
    await fn(app, base);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const authed = (path: string): string => `${path}${path.includes('?') ? '&' : '?'}token=${TOKEN}`;

async function post(base: string, path: string, form: Record<string, string | string[]>): Promise<Response> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    if (Array.isArray(v)) for (const item of v) params.append(k, item);
    else params.set(k, v);
  }
  return fetch(`${base}${authed(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    redirect: 'manual',
  });
}

test('健康检查不需要令牌，其它路径需要', async () => {
  await withApp(async (_app, base) => {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const body = (await health.json()) as { ok: boolean };
    assert.equal(body.ok, true);

    const denied = await fetch(`${base}/`);
    assert.equal(denied.status, 403);

    const allowed = await fetch(`${base}${authed('/')}`);
    assert.equal(allowed.status, 200);
    assert.match(await allowed.text(), /概览/);
  });
});

test('首次引导：页面列出所有配置项，提交后落盘并影响首页', async () => {
  await withApp(async (app, base) => {
    const page = await (await fetch(`${base}${authed('/onboarding')}`)).text();
    assert.match(page, /首次使用引导/);
    for (const label of ['IM 通道', '每日推送时间', '退款计算口径', '出网脱敏级别', '固定支出白名单']) {
      assert.ok(page.includes(label), `引导页应包含「${label}」`);
    }
    assert.equal(app.store.exists(), false);

    const response = await post(base, '/onboarding', {
      'host.im': 'none',
      'push.channels': ['local_daily_center'],
      'push.time': '08:15',
      'push.timezone': 'Asia/Shanghai',
      'push.quietHours_from': '23:00',
      'push.quietHours_to': '06:30',
      'push.noDataNotice': 'true',
      'push.maxDailyAdvice': '2',
      'money.baseCurrency': 'CNY',
      'money.multiCurrency': 'false',
      'money.fxSource': 'manual',
      'money.fxPolicy': 'on_date',
      'budget.enabled': 'false',
      'budget.period': 'month',
      'budget.items': '* 6000\nfood 1200',
      'analysis.refundPolicy': 'B',
      'analysis.fixedExpenseWhitelist': '房租\n房贷',
      'analysis.baselineWindow': ['p7', 'p28'],
      'analysis.coldStartMinDays': '3',
      'analysis.recurringAmortize': 'false',
      'analysis.futureDateToleranceDays': '1',
      'llm.enabled': 'false',
      'llm.provider': 'none',
      'llm.redaction': 'category_only',
      'categories.preset': 'personal_default',
      'data.retentionMonths': '0',
    });
    assert.equal(response.status, 303);
    assert.equal(app.store.exists(), true);

    const settings = app.settings();
    assert.equal(settings.push.time, '08:15');
    assert.deepEqual(settings.push.quietHours, ['23:00', '06:30']);
    assert.deepEqual(settings.budget.items, [
      { categoryId: null, limitMinor: 600_000 },
      { categoryId: 'food', limitMinor: 120_000 },
    ]);
    assert.deepEqual(settings.domain.analysis.fixedExpenseWhitelist, ['房租', '房贷']);
    assert.equal(settings.domain.analysis.refundPolicy, 'B');

    const home = await (await fetch(`${base}${authed('/')}`)).text();
    assert.match(home, /08:15/);
    assert.match(home, /Asia\/Shanghai/);
  });
});

test('配置校验失败时不落盘，并把错误回显在页面上', async () => {
  await withApp(async (app, base) => {
    const response = await post(base, '/onboarding', {
      'push.timezone': 'Mars/Olympus',
      'push.time': '25:99',
      'push.channels': 'local_daily_center',
    });
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.match(body, /时区/);
    assert.equal(app.store.exists(), false, '非法配置不得写盘');
  });
});

test('账单：表单新增、列表展示、软删除', async () => {
  await withApp(async (app, base) => {
    await post(base, '/onboarding', { 'push.channels': 'local_daily_center', 'push.timezone': 'Asia/Shanghai' });

    const created = await post(base, '/bills', {
      amount: '38.50',
      currency: 'CNY',
      occurredAt: '2026-10-03T12:30',
      direction: 'expense',
      categoryId: 'food',
      merchant: '某某餐厅',
      note: '午餐',
    });
    assert.equal(created.status, 303);
    assert.equal(app.repos.bills.count(), 1);

    const bill = app.repos.bills.query({ timeZone: 'Asia/Shanghai', limit: 10 })[0];
    assert.equal(bill?.amountMinor, 3850);
    assert.equal(bill?.occurredAt.slice(0, 16), '2026-10-03T12:30');
    assert.equal(app.repos.audit.count(), 1);

    const list = await (await fetch(`${base}${authed('/bills')}`)).text();
    assert.match(list, /某某餐厅/);
    assert.match(list, /38\.50/);

    await post(base, '/bills/delete', { billId: bill?.billId ?? '' });
    assert.equal(app.repos.bills.count(), 0);
    assert.equal(app.repos.bills.count(true), 1, '应为软删除，可恢复');
  });
});

test('账单：缺少金额时拒绝入库', async () => {
  await withApp(async (app, base) => {
    await post(base, '/bills', { amount: '', occurredAt: '2026-10-03T12:30' });
    assert.equal(app.repos.bills.count(), 0);
  });
});

test('日报中心：先展示空态，手动触发生成后可看到快照', async () => {
  await withApp(async (app, base) => {
    await post(base, '/onboarding', { 'push.channels': 'local_daily_center', 'push.timezone': 'Asia/Shanghai' });

    const empty = await (await fetch(`${base}${authed('/daily')}`)).text();
    assert.match(empty, /还没有日报/);

    const run = await post(base, '/daily/run', {});
    assert.equal(run.status, 200);
    assert.match(await run.text(), /skipped_no_data|pushed/);

    const after = await (await fetch(`${base}${authed('/daily')}`)).text();
    assert.match(after, /日报中心/);
    assert.match(after, /rev 1/);
  });
});

test('导入：通过界面接口上传 CSV 并返回导入报告', async () => {
  await withApp(async (app, base) => {
    await post(base, '/onboarding', { 'push.channels': 'local_daily_center', 'push.timezone': 'Asia/Shanghai' });
    const csv = `交易时间,交易对方,收/支,金额,交易订单号
2026-10-01 12:00:00,某店,支出,¥10.00,SN1
2026-10-02 13:00:00,某店,支出,¥20.00,SN2
`;
    const response = await fetch(`${base}${authed('/import?name=a.csv')}`, { method: 'POST', body: csv });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /导入结果/);
    assert.match(body, /成功 <b>2<\/b>/);
    assert.equal(app.repos.bills.count(), 2);
  });
});

test('设置：可随时修改；密钥单独保存，不写进配置文件', async () => {
  await withApp(async (app, base) => {
    await post(base, '/onboarding', { 'push.channels': 'local_daily_center', 'push.timezone': 'Asia/Shanghai' });

    const changed = await post(base, '/settings', {
      'push.time': '07:00',
      'host.feishuAppId': 'cli_demo',
      'host.feishuAppSecret': 'super-secret',
      'push.imRecipient': 'ou_demo',
      'push.channels': 'local_daily_center',
    });
    assert.equal(changed.status, 303);
    assert.equal(app.settings().push.time, '07:00');
    assert.equal(app.settings().host.appId, 'cli_demo');
    assert.equal(app.settings().host.receiveId, 'ou_demo');

    const configText = readFileSync(app.store.configPath, 'utf8');
    assert.equal(configText.includes('super-secret'), false, 'App Secret 不得进配置文件');
    assert.equal(app.store.getSecret(SECRET_FEISHU_APP_SECRET), 'super-secret');
  });
});

test('配置非法时不覆盖原有配置', async () => {
  await withApp(async (app, base) => {
    await post(base, '/onboarding', { 'push.channels': 'local_daily_center', 'push.time': '09:00' });
    const before = app.settings().push.time;

    const bad = await post(base, '/settings', { 'push.time': '30:00', 'push.channels': 'local_daily_center' });
    assert.equal(bad.status, 400);
    assert.equal(app.settings().push.time, before, '校验失败时旧配置必须保持原样');
  });
});

test('账单：编辑（带乐观锁）与恢复软删', async () => {
  await withApp(async (app, base) => {
    await post(base, '/onboarding', { 'push.channels': 'local_daily_center', 'push.timezone': 'Asia/Shanghai' });
    await post(base, '/bills', {
      amount: '10.00',
      currency: 'CNY',
      occurredAt: '2026-10-03T10:00',
      direction: 'expense',
      categoryId: 'food',
    });
    const bill = app.repos.bills.query({ timeZone: 'Asia/Shanghai', limit: 1 })[0];
    assert.ok(bill);

    const page = await (await fetch(`${base}${authed(`/bills/edit?id=${bill.billId}`)}`)).text();
    assert.match(page, /编辑账单/);
    assert.match(page, /value="10\.00"/);

    // 正常保存：金额与分类都改掉
    const saved = await post(base, '/bills/edit', {
      billId: bill.billId,
      version: String(bill.version),
      amount: '25.50',
      currency: 'CNY',
      occurredAt: '2026-10-03T11:00',
      direction: 'expense',
      categoryId: 'transport',
      merchant: '某出租车',
    });
    assert.equal(saved.status, 303);
    const updated = app.repos.bills.getById(bill.billId);
    assert.equal(updated?.amountMinor, 2550);
    assert.equal(updated?.categoryId, 'transport');
    assert.equal(updated?.version, 2);
    assert.ok(app.repos.audit.count() >= 2, '编辑应留痕');

    // 用过期的版本号保存 → 拒绝并提示
    const stale = await post(base, '/bills/edit', {
      billId: bill.billId,
      version: '1',
      amount: '99.00',
      currency: 'CNY',
      occurredAt: '2026-10-03T11:00',
      direction: 'expense',
    });
    assert.equal(stale.status, 303);
    assert.match(stale.headers.get('location') ?? '', /error=/);
    assert.equal(app.repos.bills.getById(bill.billId)?.amountMinor, 2550, '过期版本不得写入');

    // 软删 → 恢复
    await post(base, '/bills/delete', { billId: bill.billId });
    assert.equal(app.repos.bills.count(), 0);
    await post(base, '/bills/restore', { billId: bill.billId });
    assert.equal(app.repos.bills.count(), 1);
  });
});

test('账单：批量归类未分类条目', async () => {
  await withApp(async (app, base) => {
    await post(base, '/onboarding', { 'push.channels': 'local_daily_center', 'push.timezone': 'Asia/Shanghai' });
    for (const minute of ['10:00', '11:00', '12:00']) {
      await post(base, '/bills', { amount: '5.00', currency: 'CNY', occurredAt: `2026-10-03T${minute}`, direction: 'expense' });
    }
    const uncategorized = app.repos.bills.query({ timeZone: 'Asia/Shanghai', categoryId: null, limit: 10 });
    assert.equal(uncategorized.length, 3);

    // 界面支持"只看未分类"
    const filtered = await (await fetch(`${base}${authed('/bills?categoryId=__none__')}`)).text();
    assert.match(filtered, /只看未分类/);

    const result = await post(base, '/bills/bulk-category', {
      ids: uncategorized.map((b) => b.billId),
      categoryId: 'food',
    });
    assert.equal(result.status, 303);
    assert.equal(app.repos.bills.query({ timeZone: 'Asia/Shanghai', categoryId: null, limit: 10 }).length, 0);
    assert.equal(app.repos.bills.query({ timeZone: 'Asia/Shanghai', categoryId: 'food', limit: 10 }).length, 3);
  });
});

test('投递箱：粘贴通知正文直接入账，重复粘贴不重复记账', async () => {
  await withApp(async (app, base) => {
    await post(base, '/onboarding', { 'push.channels': 'local_daily_center', 'push.timezone': 'Asia/Shanghai' });
    const form = {
      subject: '信用卡消费提醒',
      text: '您尾号1234的信用卡于10月03日21:05消费人民币68.00元，商户：某数码店。',
    };

    const first = await post(base, '/inbox/paste', form);
    assert.equal(first.status, 200);
    const body = await first.text();
    assert.match(body, /已入账/);
    assert.match(body, /68\.00/);
    assert.match(body, /某数码店/);
    assert.equal(app.repos.bills.count(), 1);

    const again = await post(base, '/inbox/paste', form);
    assert.match(await again.text(), /之前已经记过账/);
    assert.equal(app.repos.bills.count(), 1, '重复粘贴不得变成两笔');
  });
});

test('投递箱：粘贴营销文案会被拒绝并说明原因', async () => {
  await withApp(async (app, base) => {
    await post(base, '/onboarding', { 'push.channels': 'local_daily_center', 'push.timezone': 'Asia/Shanghai' });
    const r = await post(base, '/inbox/paste', { text: '消费满 300 元立减 50 元' });
    const body = await r.text();
    assert.match(body, /未识别/);
    assert.match(body, /营销/);
    assert.equal(app.repos.bills.count(), 0);
  });
});

test('规则页列出全部规则，未知路径返回 404', async () => {
  await withApp(async (_app, base) => {
    const rules = await (await fetch(`${base}${authed('/rules')}`)).text();
    for (const id of ['R1', 'R4', 'R7', 'R9']) assert.ok(rules.includes(id), `规则页应列出 ${id}`);
    const missing = await fetch(`${base}${authed('/nope')}`);
    assert.equal(missing.status, 404);
  });
});

test('归类即确认：批量归类后「待补分类」必须清零（这个数字曾经永远不降）', async () => {
  await withApp(async (app, base) => {
    await post(base, '/onboarding', { 'push.channels': 'local_daily_center', 'push.timezone': 'Asia/Shanghai' });
    await post(base, '/inbox/paste', {
      text: '【工商银行】您尾号1234的储蓄卡10月03日21:05支出(消费)46.50元，余额1234.56元。',
    });
    assert.equal(app.repos.bills.count(), 1);

    const before = await (await fetch(`${base}${authed('/')}`)).text();
    assert.match(before, /待补分类<\/div><div class="v">1</, '未归类支出应计入待办');

    const billsPage = await (await fetch(`${base}${authed('/bills')}`)).text();
    const billId = /name="ids" value="([^"]+)"/.exec(billsPage)?.[1];
    assert.ok(billId, '账单页应给出可勾选的账单 id');

    const res = await post(base, '/bills/bulk-category', { ids: billId, categoryId: 'food' });
    assert.equal(res.status, 303, '归类成功后应重定向回账单页');

    const after = await (await fetch(`${base}${authed('/')}`)).text();
    assert.match(after, /待补分类<\/div><div class="v">0</, '归类后待办必须清零');
    const bill = app.repos.bills.getById(billId);
    assert.equal(bill?.categoryId, 'food');
    assert.equal(bill?.status, 'normal', '归类即确认，不该再挂着待审');
  });
});

test('「待补分类」只算未归类的支出：收入类未归类不会把它顶住不降', async () => {
  await withApp(async (app, base) => {
    await post(base, '/onboarding', { 'push.channels': 'local_daily_center', 'push.timezone': 'Asia/Shanghai' });
    // 一笔未归类的收入 + 一笔未归类支出
    await post(base, '/bills', {
      amount: '200',
      currency: 'CNY',
      occurredAt: '2026-10-01T10:00',
      direction: 'income',
      merchant: '张三',
    });
    await post(base, '/bills', {
      amount: '38.5',
      currency: 'CNY',
      occurredAt: '2026-10-01T12:30',
      direction: 'expense',
      merchant: '永辉超市',
    });
    const dash = await (await fetch(`${base}${authed('/')}`)).text();
    assert.match(dash, /待补分类<\/div><div class="v">1</, '只应数那笔未归类的支出');
  });
});

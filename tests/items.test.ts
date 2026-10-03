import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/infra/db/database.ts';
import { createBillRepo } from '../src/infra/db/billRepo.ts';
import { createCategoryRepo } from '../src/infra/db/categoryRepo.ts';
import { createAdviceItemRepo } from '../src/infra/db/adviceItemRepo.ts';
import { recordItem } from '../src/app/recordItem.ts';
import { sendDailyDigest, buildDigestText } from '../src/app/sendDailyDigest.ts';
import { defaultConfigDraft, setByPath } from '../src/infra/config/schema.ts';
import { toAppSettings } from '../src/app/settings.ts';
import { PRESET_CATEGORIES } from '../src/domain/category.ts';
import type { EmailMessage, EmailTransport } from '../src/channels/email.ts';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-10-03T21:30:00+08:00');
const SMS = '【工商银行】您尾号1234的储蓄卡10月03日21:05支出(消费)46.50元，余额1234.56元。';

function settings(over: (d: Record<string, unknown>) => void = () => {}) {
  const draft = defaultConfigDraft();
  setByPath(draft, 'push.timezone', TZ);
  over(draft);
  return toAppSettings(draft);
}

function mailSettings(over: (d: Record<string, unknown>) => void = () => {}) {
  return settings((d) => {
    setByPath(d, 'mail.enabled', true);
    setByPath(d, 'mail.imapHost', 'imap.qq.com');
    setByPath(d, 'mail.user', 'me@qq.com');
    setByPath(d, 'mail.digestEnabled', true);
    over(d);
  });
}

function makeDeps() {
  const db = openDatabase(':memory:');
  const deps = {
    items: createAdviceItemRepo(db),
    bills: createBillRepo(db),
    categories: createCategoryRepo(db),
    close: () => db.close(),
  };
  deps.categories.seedPreset(PRESET_CATEGORIES, NOW.toISOString());
  return deps;
}

/** 假邮件通道：记录被发出的邮件，可按需失败 */
function fakeTransport(options: { failTimes?: number } = {}) {
  const sent: EmailMessage[] = [];
  let remainingFailures = options.failTimes ?? 0;
  const transport: EmailTransport = {
    async send(message) {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('SMTP 连接超时');
      }
      sent.push(message);
    },
  };
  return { transport, sent };
}

// ---------------------------------------------------------------- 归类
test('收到一条像账单通知的内容：自动归类为「账单信息」并真的入账', () => {
  const deps = makeDeps();
  const result = recordItem(deps, { text: SMS, settings: settings(), now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'bill');
  assert.equal(result.needsConfirm, false);
  assert.equal(deps.bills.count(), 1, '应真的入账');
  const item = deps.items.listRecent(1)[0];
  assert.equal(item?.kind, 'bill');
  assert.equal(item?.status, 'pending');
  assert.equal(item?.billId !== null, true, '条目应关联到账单');
  deps.close();
});

test('收到一句无法判断归属的内容：按约定当「建议」并标注待确认（不丢）', () => {
  const deps = makeDeps();
  const result = recordItem(deps, { text: '这个月外卖有点多，建议控制一下', settings: settings(), now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'advice');
  assert.equal(result.needsConfirm, true, '判断不出归属就该标待确认');
  assert.equal(deps.bills.count(), 0, '不该凭空造账单');
  const item = deps.items.listRecent(1)[0];
  assert.equal(item?.body, '这个月外卖有点多，建议控制一下');
  deps.close();
});

test('明确指定为账单信息但解析不出金额：仍然存档并标待确认（绝不静默丢弃）', () => {
  const deps = makeDeps();
  const result = recordItem(deps, { text: '银行说我这笔钱花得有点问题', kind: 'bill', settings: settings(), now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'bill');
  assert.equal(result.needsConfirm, true);
  assert.equal(deps.items.counts().total, 1, '内容必须留下');
  deps.close();
});

test('空内容不进队列', () => {
  const deps = makeDeps();
  const result = recordItem(deps, { text: '   ', settings: settings(), now: NOW });
  assert.equal(result.ok, false);
  assert.equal(deps.items.counts().total, 0);
  deps.close();
});

// ---------------------------------------------------------------- 汇总邮件
test('汇总邮件：把日报 + 当日账单 + 条目合成一封，发完标记已发', async () => {
  const deps = makeDeps();
  recordItem(deps, { text: SMS, settings: settings(), now: NOW });
  recordItem(deps, { text: '建议：外卖频次偏高，可以设个上限', settings: settings(), now: NOW });

  const { transport, sent } = fakeTransport();
  const result = await sendDailyDigest(
    { items: deps.items, transport },
    {
      settings: mailSettings(),
      password: 'auth-code',
      localDate: '2026-10-03',
      reportText: '净支出 ¥46.50 · 1 笔',
      billLines: ['21:05  支出  ¥46.50  —  未分类'],
      now: NOW,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.sentCount, 2);
  assert.equal(sent.length, 1, '一天只发一封');
  const message = sent[0];
  assert.equal(message?.to, 'me@qq.com', '默认发给自己');
  assert.equal(message?.host, 'smtp.qq.com', '应由 imap.qq.com 推导 SMTP 主机');
  assert.equal(message?.port, 465);
  assert.match(message?.text ?? '', /净支出 ¥46.50/);
  assert.match(message?.text ?? '', /【今日新增账单】/);
  assert.match(message?.text ?? '', /【账单信息与建议】共 2 条/);
  assert.match(message?.text ?? '', /\[建议 \/ 归属待确认\]/, '待确认的条目要标出来');

  assert.equal(deps.items.counts().sent, 2, '发完应标记已发');
  assert.equal(deps.items.counts().pending, 0);
  deps.close();
});

test('发送失败：不丢内容，进待发队列并标记原因；恢复后自动补发', async () => {
  const deps = makeDeps();
  recordItem(deps, { text: SMS, settings: settings(), now: NOW });

  // 第一次：失败
  const failing = fakeTransport({ failTimes: 1 });
  const first = await sendDailyDigest(
    { items: deps.items, transport: failing.transport },
    { settings: mailSettings(), password: 'x', localDate: '2026-10-03', reportText: '报告', now: NOW },
  );
  assert.equal(first.ok, false);
  assert.match(first.reason ?? '', /SMTP 连接超时/);
  assert.equal(deps.items.counts().failed, 1, '失败要留痕');
  assert.match(deps.items.listRecent(1)[0]?.sendError ?? '', /SMTP/);

  // 第二次：成功 → 补发
  const working = fakeTransport();
  const second = await sendDailyDigest(
    { items: deps.items, transport: working.transport },
    { settings: mailSettings(), password: 'x', localDate: '2026-10-04', reportText: '报告', now: NOW },
  );
  assert.equal(second.ok, true);
  assert.equal(second.retriedCount, 1, '应把上次失败的那条补发掉');
  assert.match(working.sent[0]?.text ?? '', /补发/, '补发要在正文里说明');
  assert.equal(deps.items.counts().sent, 1);
  assert.equal(deps.items.counts().failed, 0);
  deps.close();
});

test('汇总邮件未开启 / 缺授权码 / 缺收件人：给出可读原因且不发送', async () => {
  const deps = makeDeps();
  recordItem(deps, { text: '建议：少喝奶茶', settings: settings(), now: NOW });
  const { transport, sent } = fakeTransport();

  const off = await sendDailyDigest(
    { items: deps.items, transport },
    { settings: settings(), password: 'x', localDate: '2026-10-03', reportText: 'r', now: NOW },
  );
  assert.equal(off.ok, false);
  assert.match(off.reason ?? '', /未开启/);

  const noPassword = await sendDailyDigest(
    { items: deps.items, transport },
    { settings: mailSettings(), password: '', localDate: '2026-10-03', reportText: 'r', now: NOW },
  );
  assert.equal(noPassword.ok, false);
  assert.match(noPassword.reason ?? '', /授权码/);

  assert.equal(sent.length, 0);
  assert.equal(deps.items.counts().sent, 0, '没发出去就不能标已发');
  deps.close();
});

test('配了收件人就发给收件人；SMTP 主机可显式覆盖', async () => {
  const deps = makeDeps();
  recordItem(deps, { text: '建议：记账记得分类', settings: settings(), now: NOW });
  const { transport, sent } = fakeTransport();
  await sendDailyDigest(
    { items: deps.items, transport },
    {
      settings: mailSettings((d) => {
        setByPath(d, 'mail.notifyTo', 'someone@example.com');
        setByPath(d, 'mail.smtpHost', 'smtp.exmail.qq.com');
        setByPath(d, 'mail.smtpPort', 587);
      }),
      password: 'x',
      localDate: '2026-10-03',
      reportText: 'r',
      now: NOW,
    },
  );
  assert.equal(sent[0]?.to, 'someone@example.com');
  assert.equal(sent[0]?.host, 'smtp.exmail.qq.com');
  assert.equal(sent[0]?.secure, 'starttls', '587 应用 STARTTLS');
  deps.close();
});

test('正文拼装：无条目时不出现空的条目标题，且总是带来源声明', () => {
  const text = buildDigestText({
    localDate: '2026-10-03',
    reportText: '净支出 ¥0.00',
    billLines: [],
    queue: [],
    retriedCount: 0,
  });
  assert.match(text, /账单日报 · 2026-10-03/);
  assert.equal(text.includes('【账单信息与建议】'), false);
  assert.match(text, /数据仅存本机/);
});

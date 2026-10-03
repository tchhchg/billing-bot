import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/infra/db/database.ts';
import { createBillRepo } from '../src/infra/db/billRepo.ts';
import { createCategoryRepo } from '../src/infra/db/categoryRepo.ts';
import { fetchAndImportMail, type MailDeps } from '../src/app/fetchMail.ts';
import { MailClientUnavailableError, type MailClient, type MailFetchRequest } from '../src/infra/mail/imapClient.ts';
import { defaultConfigDraft, setByPath, CONFIG_FIELDS } from '../src/infra/config/schema.ts';
import { toAppSettings } from '../src/app/settings.ts';
import { buildWizardSteps } from '../src/app/onboarding.ts';
import { PRESET_CATEGORIES } from '../src/domain/category.ts';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-10-03T21:30:00+08:00');

function settings(over: (d: Record<string, unknown>) => void = () => {}) {
  const draft = defaultConfigDraft();
  setByPath(draft, 'push.timezone', TZ);
  over(draft);
  return toAppSettings(draft);
}

function mailOn(over: (d: Record<string, unknown>) => void = () => {}) {
  return settings((d) => {
    setByPath(d, 'mail.enabled', true);
    setByPath(d, 'mail.imapHost', 'imap.example.com');
    setByPath(d, 'mail.user', 'me@example.com');
    setByPath(d, 'mail.mailbox', 'INBOX');
    setByPath(d, 'mail.lookbackDays', 7);
    over(d);
  });
}

function makeDeps(): { deps: MailDeps; close: () => void } {
  const db = openDatabase(':memory:');
  const deps: MailDeps = { bills: createBillRepo(db), categories: createCategoryRepo(db) };
  deps.categories.seedPreset(PRESET_CATEGORIES, NOW.toISOString());
  return { deps, close: () => db.close() };
}

function eml(subject: string, body: string, messageId: string): Uint8Array {
  const raw = [
    'From: bank@example.com',
    `Subject: ${subject}`,
    'Date: Sat, 03 Oct 2026 21:10:00 +0800',
    `Message-ID: <${messageId}>`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ].join('\r\n');
  return new Uint8Array(Buffer.from(raw, 'utf8'));
}

const NOTICE = '您尾号1234的信用卡于10月03日21:05消费人民币68.00元，商户：某数码店。';
const PROMO = '消费满 300 元立减 50 元';

function fakeClient(messages: Array<{ uid: number; source: Uint8Array }>): { client: MailClient; requests: MailFetchRequest[] } {
  const requests: MailFetchRequest[] = [];
  return {
    requests,
    client: {
      async fetchSince(request) {
        requests.push(request);
        return messages;
      },
    },
  };
}

// ---------------------------------------------------------------- 前置条件
test('未启用邮件抓取时：直接返回原因，且不做任何网络请求', async () => {
  const { deps, close } = makeDeps();
  const { client, requests } = fakeClient([]);
  const summary = await fetchAndImportMail({ client, deps, settings: settings(), password: 'x', now: NOW });

  assert.equal(summary.ok, false);
  assert.match(summary.reason ?? '', /未启用/);
  assert.equal(requests.length, 0, '未启用时不该连邮箱');
  close();
});

test('已启用但缺账号或缺授权码：给出明确原因', async () => {
  const { deps, close } = makeDeps();
  const { client } = fakeClient([]);

  const noConfig = await fetchAndImportMail({
    client,
    deps,
    settings: settings((d) => setByPath(d, 'mail.enabled', true)),
    password: 'x',
    now: NOW,
  });
  assert.equal(noConfig.ok, false);
  assert.match(noConfig.reason ?? '', /缺少服务器或账号/);

  const noPassword = await fetchAndImportMail({ client, deps, settings: mailOn(), password: '', now: NOW });
  assert.equal(noPassword.ok, false);
  assert.match(noPassword.reason ?? '', /授权码/);
  close();
});

test('连接失败与依赖缺失都如实返回，不抛给调用方', async () => {
  const { deps, close } = makeDeps();

  const broken: MailClient = {
    async fetchSince() {
      throw new Error('auth failed');
    },
  };
  const r1 = await fetchAndImportMail({ client: broken, deps, settings: mailOn(), password: 'x', now: NOW });
  assert.equal(r1.ok, false);
  assert.match(r1.reason ?? '', /连接邮箱失败.*auth failed/);

  const unavailable: MailClient = {
    async fetchSince() {
      throw new MailClientUnavailableError('邮件抓取需要可选依赖 imapflow');
    },
  };
  const r2 = await fetchAndImportMail({ client: unavailable, deps, settings: mailOn(), password: 'x', now: NOW });
  assert.equal(r2.ok, false);
  assert.match(r2.reason ?? '', /imapflow/);
  close();
});

// ---------------------------------------------------------------- 正常路径
test('抓取并记账：通知入账、营销邮件跳过', async () => {
  const { deps, close } = makeDeps();
  const { client, requests } = fakeClient([
    { uid: 101, source: eml('信用卡消费提醒', NOTICE, 'm-101@example.com') },
    { uid: 102, source: eml('限时优惠', PROMO, 'm-102@example.com') },
  ]);

  const summary = await fetchAndImportMail({ client, deps, settings: mailOn(), password: 'secret', now: NOW });

  assert.equal(summary.ok, true);
  assert.equal(summary.fetched, 2);
  assert.equal(summary.imported, 1);
  assert.equal(summary.unmatched, 1);
  assert.equal(deps.bills.count(), 1);
  assert.equal(deps.bills.query({ timeZone: TZ, limit: 1 })[0]?.amountMinor, 6800);
  assert.match(summary.details[0]?.merchant ?? '', /某数码店/);

  // 时间窗口与目标文件夹按配置传下去
  assert.equal(requests[0]?.sinceDate, '2026-09-26');
  assert.equal(requests[0]?.mailbox, 'INBOX');
  assert.equal(requests[0]?.host, 'imap.example.com');
  assert.equal(requests[0]?.secure, true, '993 端口应使用 SSL');
  close();
});

test('重复抓取同一批邮件：不产生重复账单', async () => {
  const { deps, close } = makeDeps();
  const messages = [{ uid: 101, source: eml('信用卡消费提醒', NOTICE, 'm-101@example.com') }];

  const first = await fetchAndImportMail({ client: fakeClient(messages).client, deps, settings: mailOn(), password: 's', now: NOW });
  assert.equal(first.imported, 1);

  const second = await fetchAndImportMail({ client: fakeClient(messages).client, deps, settings: mailOn(), password: 's', now: NOW });
  assert.equal(second.imported, 0);
  assert.equal(second.duplicate, 1);
  assert.equal(deps.bills.count(), 1, '再次抓取不该重复记账');
  close();
});

test('预览模式：只统计不写库', async () => {
  const { deps, close } = makeDeps();
  const { client } = fakeClient([{ uid: 101, source: eml('消费提醒', NOTICE, 'm-101@example.com') }]);

  const summary = await fetchAndImportMail({ client, deps, settings: mailOn(), password: 's', now: NOW, dryRun: true });
  assert.equal(summary.imported, 1);
  assert.equal(summary.details[0]?.reason, '预览模式，未写入');
  assert.equal(deps.bills.count(), 0, '预览模式不得写库');
  close();
});

test('回溯天数可配置，且 143 端口不使用 SSL', async () => {
  const { deps, close } = makeDeps();
  const { client, requests } = fakeClient([]);

  await fetchAndImportMail({
    client,
    deps,
    settings: mailOn((d) => {
      setByPath(d, 'mail.lookbackDays', 30);
      setByPath(d, 'mail.imapPort', 143);
    }),
    password: 's',
    now: NOW,
  });

  assert.equal(requests[0]?.sinceDate, '2026-09-03');
  assert.equal(requests[0]?.secure, false);
  close();
});

test('发件人筛选会传给 IMAP（短信转发场景：只取转发邮件）', async () => {
  const { deps, close } = makeDeps();
  const { client, requests } = fakeClient([]);

  await fetchAndImportMail({
    client,
    deps,
    settings: mailOn((d) => setByPath(d, 'mail.senderFilter', 'me@example.com')),
    password: 's',
    now: NOW,
  });
  assert.equal(requests[0]?.senderFilter, 'me@example.com');

  await fetchAndImportMail({ client, deps, settings: mailOn(), password: 's', now: NOW });
  assert.equal(requests[1]?.senderFilter, '', '不填筛选时应传空，扫描窗口内全部邮件');
  close();
});

test('单封邮件解析失败不影响其它邮件', async () => {
  const { deps, close } = makeDeps();
  const { client } = fakeClient([
    { uid: 1, source: new Uint8Array(Buffer.from('这不是一封邮件', 'utf8')) },
    { uid: 2, source: eml('信用卡消费提醒', NOTICE, 'm-2@example.com') },
  ]);

  const summary = await fetchAndImportMail({ client, deps, settings: mailOn(), password: 's', now: NOW });
  assert.equal(summary.ok, true);
  assert.equal(summary.imported, 1, '好的那封仍要入账');
  close();
});

// ---------------------------------------------------------------- 配置
test('邮件配置项进入 Schema，并被引导向导覆盖（铁律守卫）', () => {
  const keys = CONFIG_FIELDS.map((f) => f.key);
  for (const key of ['mail.enabled', 'mail.imapHost', 'mail.imapPort', 'mail.user', 'mail.password', 'mail.mailbox', 'mail.lookbackDays']) {
    assert.ok(keys.includes(key), `缺少配置项 ${key}`);
  }
  const covered = new Set(buildWizardSteps().flatMap((s) => s.fields.map((f) => f.key)));
  assert.ok(covered.has('mail.imapHost'), '首次引导必须询问邮件配置');
  assert.ok(covered.has('mail.password'), '首次引导必须询问邮箱授权码');
});

test('设置视图暴露邮件配置，且不包含授权码本身', () => {
  const s = mailOn();
  assert.equal(s.mail.enabled, true);
  assert.equal(s.mail.host, 'imap.example.com');
  assert.equal(s.mail.port, 993);
  assert.equal(s.mail.lookbackDays, 7);
  assert.equal(s.mail.configured, true);
  assert.equal(Object.keys(s.mail).includes('password'), false, '授权码绝不能出现在设置视图里');
});

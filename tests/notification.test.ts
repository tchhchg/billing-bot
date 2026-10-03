import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNotification } from '../src/infra/importer/notification.ts';
import { decodeEncodedWords, parseEml } from '../src/infra/importer/eml.ts';
import { importNotificationEmail, importNotificationText, previewNotification } from '../src/app/importNotifications.ts';
import { scanInbox, type InboxDeps } from '../src/app/inbox.ts';
import { openDatabase } from '../src/infra/db/database.ts';
import { createBillRepo } from '../src/infra/db/billRepo.ts';
import { createCategoryRepo } from '../src/infra/db/categoryRepo.ts';
import { createImportRepo } from '../src/infra/db/importRepo.ts';
import { defaultConfigDraft, setByPath } from '../src/infra/config/schema.ts';
import { toAppSettings } from '../src/app/settings.ts';
import { PRESET_CATEGORIES } from '../src/domain/category.ts';

const TZ = 'Asia/Shanghai';
const EMAIL_DATE = 'Sat, 03 Oct 2026 21:10:00 +0800';
const EMAIL_MS = Date.parse(EMAIL_DATE);

function settings(over: (d: Record<string, unknown>) => void = () => {}) {
  const draft = defaultConfigDraft();
  setByPath(draft, 'push.timezone', TZ);
  over(draft);
  return toAppSettings(draft);
}

function parse(subject: string, body: string, over: { emailDate?: string } = {}) {
  return parseNotification({
    subject,
    body,
    emailDate: over.emailDate ?? new Date(EMAIL_MS).toISOString(),
    timeZone: TZ,
    currency: 'CNY',
  });
}

// ---------------------------------------------------------------- 引擎
test('典型信用卡消费通知：金额/时间/商户/卡尾号全都抽出来', () => {
  const r = parse('信用卡消费提醒', '您尾号1234的信用卡于10月03日21:05消费人民币68.00元，商户：某数码店。');
  assert.equal(r.matched, true);
  assert.equal(r.fields?.amountMinor, 6800);
  assert.equal(r.fields?.merchant, '某数码店');
  assert.equal(r.fields?.cardTail, '1234');
  assert.equal(r.fields?.direction, 'expense');
  assert.equal(r.fields?.occurredAt.slice(0, 16), '2026-10-03T21:05');
  assert.equal(r.fields?.occurredAtFromEmail, false);
  assert.ok(r.confidence > 0.7, `置信度应偏高，实际 ${r.confidence}`);
});

test('带千分位与货币符号的金额', () => {
  const r = parse('交易提醒', '您尾号8888的卡于2026-10-03 20:10发生一笔消费，交易金额￥1,299.00');
  assert.equal(r.matched, true);
  assert.equal(r.fields?.amountMinor, 129_900);
});

test('余额/额度那句必须被剔除，不能当成消费金额', () => {
  const r = parse('消费提醒', '您尾号1234的信用卡消费38.50元，商户：某便利店。当前可用额度 50000.00 元，余额 12345.67 元。');
  assert.equal(r.matched, true);
  assert.equal(r.fields?.amountMinor, 3850, '不能抽成额度或余额');
});

test('退款/入账识别为收入方向', () => {
  const r = parse('入账通知', '您尾号1234的信用卡发生退款入账 120.00 元，商户：某网店。');
  assert.equal(r.matched, true);
  assert.equal(r.fields?.direction, 'income');
  assert.ok(r.signals.some((s) => s.includes('退款')));
});

test('账单/营销类邮件不算交易通知', () => {
  const bill = parse('您的账单已生成', '本期应还金额 5000.00 元，最低还款 500.00 元，账单日 10月05日。');
  assert.equal(bill.matched, false, '账单应还金额不能被当成消费');
  assert.match(bill.reason ?? '', /关键词|金额/);

  const promo = parse('限时优惠', '消费满 300 元立减 50 元，速来领取优惠券。');
  assert.equal(promo.matched, false);

  // 这条是实测抓到的误报：没有"优惠券"字样的纯营销文案，不能被当成 300 元消费
  const promo2 = parse('限时优惠', '消费满 300 元立减 50 元');
  assert.equal(promo2.matched, false);
  assert.match(promo2.reason ?? '', /营销/);
});

test('营销词与真实交易标识同时出现时，仍然按交易处理', () => {
  const r = parse('消费提醒', '您尾号1234的信用卡消费 68.00 元，商户：某超市。点击 App 查看详情，参与活动得积分。');
  assert.equal(r.matched, true);
  assert.equal(r.fields?.amountMinor, 6800);
});

test('有交易关键词但没有可信金额 → 明确不识别，并给出原因', () => {
  const r = parse('消费提醒', '您尾号1234的信用卡发生一笔消费，详情请登录 App 查询。');
  assert.equal(r.matched, false);
  assert.equal(r.confidence, 0);
  assert.match(r.reason ?? '', /金额/);
});

test('通知里没有时间 → 用邮件时间兜底并标记', () => {
  const r = parse('消费提醒', '您尾号1234的信用卡消费 25.00 元。');
  assert.equal(r.matched, true);
  assert.equal(r.fields?.occurredAtFromEmail, true);
  assert.equal(r.fields?.occurredAt.slice(0, 16), '2026-10-03T21:10');
});

test('跨年：1 月收到"12月31日"的通知，年份要回退一年', () => {
  const newYearEmail = 'Fri, 02 Jan 2026 09:00:00 +0800';
  const r = parse('消费提醒', '您尾号1234的信用卡于12月31日 23:10 消费 88.00 元。', {
    emailDate: new Date(Date.parse(newYearEmail)).toISOString(),
  });
  assert.equal(r.matched, true);
  assert.equal(r.fields?.occurredAt.slice(0, 10), '2025-12-31');
});

test('自定义模板优先于通用模板（为特定银行定制）', () => {
  const custom = {
    id: 'my-bank',
    name: '我的银行',
    matchAll: ['某某银行'],
    patterns: { amount: '(?:消费|支出)\\s*([0-9]+(?:\\.[0-9]{1,2})?)\\s*元' },
    defaultDirection: 'expense' as const,
  };
  const r = parseNotification({
    subject: '某某银行消费提醒',
    body: '某某银行提醒：您尾号6666的卡消费 42.50 元。余额 999.00 元。',
    emailDate: new Date(EMAIL_MS).toISOString(),
    timeZone: TZ,
    currency: 'CNY',
    templates: [custom],
  });
  assert.equal(r.matched, true);
  assert.equal(r.templateId, 'my-bank');
  assert.equal(r.fields?.amountMinor, 4250, '应使用自定义模板的金额规则，而不是通用规则');
});

test('模板排除词命中时直接判定不是通知', () => {
  const r = parseNotification({
    subject: '消费提醒',
    body: '消费 10.00 元',
    emailDate: new Date(EMAIL_MS).toISOString(),
    timeZone: TZ,
    currency: 'CNY',
    templates: [{ id: 'x', name: 'x', exclude: ['消费'], patterns: { amount: '([0-9.]+)' } }],
  });
  assert.equal(r.matched, false);
  assert.match(r.reason ?? '', /模板/);
});

test('预览接口直接用正文文本判断能不能解析', () => {
  const r = previewNotification({
    subject: '消费提醒',
    body: '您尾号1234的信用卡消费 12.30 元，商户：某早餐店。',
    settings: settings(),
  });
  assert.equal(r.matched, true);
  assert.equal(r.fields?.amountMinor, 1230);
});

// ---------------------------------------------------------------- .eml 解析
const BODY_PLAIN = '您尾号1234的信用卡于10月03日21:05消费人民币68.00元，商户：某数码店。';

function eml(parts: {
  subject?: string;
  contentType?: string;
  transferEncoding?: string;
  body: string;
  extra?: string;
}): string {
  const subject = parts.subject ?? '=?UTF-8?B?5L+h55So5Y2h5raI6LS55o+Q6YaS?='; // 信用卡消费提醒
  return [
    'From: bank@example.com',
    'To: me@example.com',
    `Subject: ${subject}`,
    `Date: ${EMAIL_DATE}`,
    'Message-ID: <msg-001@example.com>',
    `Content-Type: ${parts.contentType ?? 'text/plain; charset="UTF-8"'}`,
    `Content-Transfer-Encoding: ${parts.transferEncoding ?? 'base64'}`,
    ...(parts.extra ? [parts.extra] : []),
    '',
    parts.body,
  ].join('\r\n');
}

test('.eml：base64 + RFC2047 主题解码', () => {
  const raw = eml({ body: Buffer.from(BODY_PLAIN, 'utf8').toString('base64') });
  const email = parseEml(raw);
  assert.equal(email.subject, '信用卡消费提醒');
  assert.equal(email.messageId, 'msg-001@example.com');
  assert.equal(email.textBody.trim(), BODY_PLAIN);
  assert.equal(email.usedHtml, false);
  assert.equal(email.date?.slice(0, 10), '2026-10-03');
});

test('.eml：multipart/alternative 优先取纯文本，quoted-printable 正确解码', () => {
  const raw = [
    'From: bank@example.com',
    `Subject: 消费提醒`,
    `Date: ${EMAIL_DATE}`,
    'Content-Type: multipart/alternative; boundary="BOUND"',
    '',
    '--BOUND',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '=E6=B6=88=E8=B4=B9 38.50 =E5=85=83', // "消费 38.50 元"
    '--BOUND',
    'Content-Type: text/html; charset="UTF-8"',
    '',
    '<html><body><p>消费 <b>38.50</b> 元</p></body></html>',
    '--BOUND--',
    '',
  ].join('\r\n');
  const email = parseEml(raw);
  assert.equal(email.usedHtml, false);
  assert.match(email.textBody, /消费 38\.50 元/);
});

test('.eml：只有 HTML 时降级为纯文本', () => {
  const raw = [
    'From: bank@example.com',
    'Subject: 消费提醒',
    `Date: ${EMAIL_DATE}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    '<html><body><div>您尾号1234的信用卡消费&nbsp;68.00&nbsp;元</div><script>evil()</script></body></html>',
  ].join('\r\n');
  const email = parseEml(raw);
  assert.equal(email.usedHtml, true);
  assert.match(email.textBody, /消费 68\.00 元/);
  assert.equal(email.textBody.includes('evil'), false, 'HTML 里的脚本不应出现');
});

test('.eml：混合邮件能带出附件', () => {
  const raw = [
    'From: bank@example.com',
    'Subject: 账单',
    `Date: ${EMAIL_DATE}`,
    'Content-Type: multipart/mixed; boundary="MIX"',
    '',
    '--MIX',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    '详见附件',
    '--MIX',
    'Content-Type: text/csv; name="bill.csv"',
    'Content-Disposition: attachment; filename="bill.csv"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('a,b\n1,2\n', 'utf8').toString('base64'),
    '--MIX--',
    '',
  ].join('\r\n');
  const email = parseEml(raw);
  assert.equal(email.attachments.length, 1);
  assert.equal(email.attachments[0]?.filename, 'bill.csv');
  assert.match(Buffer.from(email.attachments[0]?.content ?? []).toString('utf8'), /a,b/);
});

test('decodeEncodedWords：B 与 Q 两种编码', () => {
  assert.equal(decodeEncodedWords('=?UTF-8?B?5raI6LS5?='), '消费');
  assert.equal(decodeEncodedWords('=?UTF-8?Q?=E6=B6=88=E8=B4=B9?='), '消费');
  assert.equal(decodeEncodedWords('普通主题'), '普通主题');
});

// ---------------------------------------------------------------- 端到端
function makeDeps(): { deps: InboxDeps; close: () => void } {
  const db = openDatabase(':memory:');
  const deps: InboxDeps = {
    bills: createBillRepo(db),
    categories: createCategoryRepo(db),
    imports: createImportRepo(db),
    settings: () => settings(),
  };
  deps.categories.seedPreset(PRESET_CATEGORIES, new Date(EMAIL_MS).toISOString());
  return { deps, close: () => db.close() };
}

test('一封通知邮件 → 一条账单，且按 Message-ID 幂等', () => {
  const { deps, close } = makeDeps();
  const email = parseEml(eml({ body: Buffer.from(BODY_PLAIN, 'utf8').toString('base64') }));

  const first = importNotificationEmail(
    { bills: deps.bills, categories: deps.categories },
    { email, settings: settings(), now: new Date(EMAIL_MS) },
  );
  assert.equal(first.status, 'imported');
  assert.equal(deps.bills.count(), 1);

  const bill = deps.bills.query({ timeZone: TZ, limit: 1 })[0];
  assert.equal(bill?.amountMinor, 6800);
  assert.equal(bill?.source, 'api');
  assert.equal(bill?.sourceRef, 'msg-001@example.com');
  assert.equal(bill?.merchant, '某数码店');
  assert.match(bill?.note ?? '', /自动解析/);
  assert.deepEqual(bill?.tags, ['邮件通知']);

  const second = importNotificationEmail(
    { bills: deps.bills, categories: deps.categories },
    { email, settings: settings(), now: new Date(EMAIL_MS) },
  );
  assert.equal(second.status, 'duplicate');
  assert.equal(deps.bills.count(), 1, '同一封邮件不得重复记账');
  close();
});

test('没有 Message-ID 时用内容哈希保证幂等', () => {
  const { deps, close } = makeDeps();
  const raw = eml({ body: Buffer.from(BODY_PLAIN, 'utf8').toString('base64') }).replace(/Message-ID:.*\r\n/, '');
  const email = parseEml(raw);
  assert.equal(email.messageId, null);

  importNotificationEmail({ bills: deps.bills, categories: deps.categories }, { email, settings: settings() });
  const again = importNotificationEmail({ bills: deps.bills, categories: deps.categories }, { email, settings: settings() });
  assert.equal(again.status, 'duplicate');
  assert.equal(deps.bills.count(), 1);
  close();
});

test('粘贴通知正文入账，且同一段内容不会重复记账', () => {
  const { deps, close } = makeDeps();
  const text = '您尾号1234的信用卡于10月03日21:05消费人民币68.00元，商户：某数码店。';

  const first = importNotificationText(
    { bills: deps.bills, categories: deps.categories },
    { text, settings: settings(), now: new Date(EMAIL_MS) },
  );
  assert.equal(first.status, 'imported');
  assert.equal(deps.bills.count(), 1);

  const again = importNotificationText(
    { bills: deps.bills, categories: deps.categories },
    { text, settings: settings(), now: new Date(EMAIL_MS + 60_000) },
  );
  assert.equal(again.status, 'duplicate', '粘贴两次同样的内容不应变成两笔账单');
  assert.equal(deps.bills.count(), 1);
  close();
});

test('短信风格的短通知也能识别（不需要任何文件）', () => {
  const { deps, close } = makeDeps();
  const sms = '【某银行】您尾号5678的储蓄卡10月03日19:22支出(消费)46.50元，余额1234.00元。';
  const r = importNotificationText(
    { bills: deps.bills, categories: deps.categories },
    { text: sms, settings: settings(), now: new Date(EMAIL_MS) },
  );
  assert.equal(r.status, 'imported');
  assert.equal(r.parsed?.fields?.amountMinor, 4650, '不能把余额当成金额');
  assert.equal(r.parsed?.fields?.cardTail, '5678');
  close();
});

test('投递箱里的 .txt：通知正文与 CSV 自动分流', () => {
  const dir = mkdtempSync(join(tmpdir(), 'billing-txt-'));
  const inbox = join(dir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  // 通知正文存成 txt
  writeFileSync(join(inbox, 'notice.txt'), '您尾号1234的信用卡消费 66.00 元，商户：某面馆。', 'utf8');
  // CSV 存成 txt
  writeFileSync(
    join(inbox, 'table.txt'),
    '交易时间,交易对方,收/支,金额,交易订单号\n2026-10-03 10:00:00,某店,支出,¥10.00,SN-txt-1\n',
    'utf8',
  );

  const { deps, close } = makeDeps();
  const result = scanInbox(deps, { dir: inbox, now: () => new Date(EMAIL_MS) });

  assert.equal(result.imported, 2, '两种 txt 都应被正确处理');
  assert.equal(deps.bills.count(), 2);
  assert.match(result.results.find((r) => r.fileName === 'notice.txt')?.reason ?? '', /通知正文/);
  close();
  rmSync(dir, { recursive: true, force: true });
});

test('投递箱直接丢 .eml 就能记账（无人值守路径）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'billing-eml-'));
  const inbox = join(dir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, 'notice.eml'), eml({ body: Buffer.from(BODY_PLAIN, 'utf8').toString('base64') }), 'utf8');

  const { deps, close } = makeDeps();
  const result = scanInbox(deps, { dir: inbox, now: () => new Date(EMAIL_MS) });

  assert.equal(result.imported, 1);
  assert.equal(deps.bills.count(), 1);
  assert.match(result.results[0]?.reason ?? '', /识别为消费通知/);
  assert.equal(result.importedToday, true);

  close();
  rmSync(dir, { recursive: true, force: true });
});

test('解析不出的通知邮件留在原地，并说明原因（不吞掉）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'billing-eml2-'));
  const inbox = join(dir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const promo = eml({ subject: '限时优惠', body: Buffer.from('消费满 300 元立减 50 元', 'utf8').toString('base64') });
  writeFileSync(join(inbox, 'promo.eml'), promo, 'utf8');

  const { deps, close } = makeDeps();
  const result = scanInbox(deps, { dir: inbox, now: () => new Date(EMAIL_MS) });

  assert.equal(result.skipped, 1);
  assert.equal(result.imported, 0);
  assert.equal(deps.bills.count(), 0);
  assert.match(result.results[0]?.reason ?? '', /未识别/);
  close();
  rmSync(dir, { recursive: true, force: true });
});

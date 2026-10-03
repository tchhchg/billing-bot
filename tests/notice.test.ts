import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppNotice, looksLikeAppNotice, isOwnDigest, PACKAGE_CHANNELS } from '../src/app/parseNotice.ts';
import { defaultConfigDraft, setByPath } from '../src/infra/config/schema.ts';
import { toAppSettings } from '../src/app/settings.ts';

const NOW = new Date('2026-10-04T00:40:00+08:00');

function settings() {
  const draft = defaultConfigDraft();
  setByPath(draft, 'push.timezone', 'Asia/Shanghai');
  return toAppSettings(draft);
}

/** 真实样例 1：2026-10-04 00:32 支付宝通知 */
const ALIPAY = [
  'com.eg.android.AlipayGphone',
  '你有一笔10.84元的支出，点击领取6个支付宝积分。',
  '交易提醒',
  'UID：10209',
  '2026-10-04 00:32:15',
].join('\n');

/** 真实样例 2：2026-10-04 00:37 安徽农金动账通知 */
const AHRCU = [
  'com.ahrcu.mobilebank',
  '您尾号为1234的账户于10月04日00时37分收入人民币10.84元，对方户名：支付宝（中国）网络技术有限公司，点击查看详情>>',
  '动账通知',
  'UID：10609',
  '2026-10-04 00:37:27',
].join('\n');

/** 真实样例 3：通道自测通知（不该被当成账单） */
const SELFTEST = [
  '19999999999',
  '【应用通知】恭喜您，该发送通道测试成功，请继续添加转发规则！',
  'SIM1_测试运营商_18888888888',
  'SubId：0',
  '2026-10-04 00:15:10',
].join('\n');

test('支付宝通知：抽出金额/方向/渠道/时间（它没有商户，也不该编一个出来）', () => {
  const notice = parseAppNotice({ subject: '[通知]', body: ALIPAY, settings: settings(), now: NOW });
  assert.equal(notice.packageName, 'com.eg.android.alipaygphone');
  assert.equal(notice.channel, '支付宝');
  assert.equal(notice.amountMinor, 1084);
  assert.equal(notice.direction, 'expense');
  assert.equal(notice.recognized, true);
  assert.equal(notice.occurredAt, '2026-10-04T00:32:15');
  assert.equal(notice.counterparty, null);
  assert.equal(notice.refundCandidate, false);
  // 正文里的"6个支付宝积分"不能被当成金额
  assert.notEqual(notice.amountMinor, 600);
});

test('银行动账通知：抽出金额/方向/对方户名/卡尾号，并认出这是"退款候选"', () => {
  const notice = parseAppNotice({ subject: '[通知]', body: AHRCU, settings: settings(), now: NOW });
  assert.equal(notice.channel, '安徽农金');
  assert.equal(notice.amountMinor, 1084);
  assert.equal(notice.direction, 'income');
  assert.equal(notice.counterparty, '支付宝（中国）网络技术有限公司');
  assert.equal(notice.cardTail, '1234');
  assert.equal(notice.refundCandidate, true, '银行入账 + 对方是支付通道 = 退款/提现候选');
  assert.equal(notice.occurredAt, '2026-10-04T00:37:27');
});

test('通道自测通知：认不出金额时保留原文，绝不丢弃（recognized=false）', () => {
  const notice = parseAppNotice({ subject: '[通知]', body: SELFTEST, settings: settings(), now: NOW });
  assert.equal(notice.packageName, null);
  assert.equal(notice.channel, '未知来源');
  assert.equal(notice.amountMinor, null);
  assert.equal(notice.recognized, false);
  assert.match(notice.raw, /该发送通道测试成功/, '原文必须完整保留');
  assert.equal(notice.occurredAt, '2026-10-04T00:15:10');
});

test('没见过的包名：不报错、不丢内容，渠道显示为"未知来源:包名"', () => {
  const body = ['com.some.newbank.app', '您尾号为1234的账户支出人民币55.00元', '动账通知', '2026-10-04 09:00:00'].join('\n');
  const notice = parseAppNotice({ subject: '[通知]', body, settings: settings(), now: NOW });
  assert.equal(notice.channel, '未知来源:com.some.newbank.app');
  assert.equal(notice.amountMinor, 5500);
  assert.equal(notice.direction, 'expense');
  assert.equal(notice.recognized, true);
});

test('余额/额度不会被当成交易金额', () => {
  const body = [
    'com.icbc.android',
    '您尾号1234的储蓄卡支出(消费)46.50元，余额1234.56元。',
    '动账通知',
    '2026-10-04 10:00:00',
  ].join('\n');
  const notice = parseAppNotice({ subject: '[通知]', body, settings: settings(), now: NOW });
  assert.equal(notice.amountMinor, 4650, '应取 46.50 而不是余额 1234.56');
});

test('识别"这封邮件是不是应用通知转发"', () => {
  assert.equal(looksLikeAppNotice('[通知]', '随便什么正文'), true, '主题带 [通知] 就算');
  assert.equal(looksLikeAppNotice('银行短信106980095588', ALIPAY), true, '正文首行是包名也算');
  assert.equal(looksLikeAppNotice('银行短信106980095588', '106980095588 【工商银行】支出46.50元'), false);
  assert.equal(looksLikeAppNotice('账单日报 · 2026-10-03', '【日报】净支出 ¥0'), false);
});

test('自己的汇总邮件必须被认出来（否则会回灌成假账单）', () => {
  assert.equal(isOwnDigest('账单日报 · 2026-10-04'), true);
  assert.equal(isOwnDigest('账单日报 · 2026-10-03'), true);
  assert.equal(isOwnDigest('[通知]'), false);
  assert.equal(isOwnDigest('银行短信106980095588'), false);
});

test('渠道映射表覆盖已知来源；新增来源只需加一行', () => {
  for (const pkg of ['com.eg.android.AlipayGphone', 'com.ahrcu.mobilebank', 'com.xunmeng.pinduoduo']) {
    assert.ok(PACKAGE_CHANNELS[pkg], `${pkg} 应有映射`);
  }
});

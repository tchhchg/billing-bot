import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeishuClient } from '../src/channels/feishu/client.ts';
import { cardFromRendered } from '../src/channels/feishu/card.ts';
import { handleCardAction, parseCallback } from '../src/channels/feishu/callback.ts';
import { createFeishuChannel, inferReceiveIdType } from '../src/channels/feishu/index.ts';
import { renderDailyCard } from '../src/domain/advice/render.ts';
import type { Advice } from '../src/domain/types.ts';
import { stubMetrics } from './helpers.ts';

const DAY = '2026-10-03';

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function fakeFetch(responses: Array<{ ok?: boolean; status?: number; json: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses[Math.min(index, responses.length - 1)] as { ok?: boolean; status?: number; json: unknown };
    index += 1;
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function advice(over: Partial<Advice> = {}): Advice {
  return {
    adviceId: `adv_${DAY}_R1`,
    ruleId: 'R1',
    severity: 'warn',
    title: '今日支出高于你的近期平均水平',
    evidence: { merchant: '某某咖啡店' },
    suggestions: ['占比最高的是「餐饮」'],
    confidence: 0.8,
    actions: [
      { type: 'view_detail', label: '查看明细' },
      { type: 'snooze', label: '稍后提醒', payload: { days: 3 } },
      { type: 'mark_inaccurate', label: '不准' },
    ],
    disclaimerRequired: true,
    ...over,
  };
}

// ---------------------------------------------------------------- 客户端
test('飞书客户端：缓存 tenant_access_token 并只请求一次', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { json: { code: 0, tenant_access_token: 't-123', expire: 7200 } },
    { json: { code: 0, data: { message_id: 'om_1' } } },
    { json: { code: 0, data: { message_id: 'om_2' } } },
  ]);
  const client = createFeishuClient({ appId: 'a', appSecret: 's', fetchImpl });

  const first = await client.sendCard({ receiveId: 'ou_1', card: { a: 1 } });
  const second = await client.sendCard({ receiveId: 'ou_1', card: { a: 2 } });

  assert.equal(first.ok, true);
  assert.equal(first.messageId, 'om_1');
  assert.equal(second.ok, true);
  assert.equal(calls.length, 3, '两次发送只应取一次 token');
  assert.match(calls[0]?.url ?? '', /tenant_access_token/);
  assert.match(calls[1]?.url ?? '', /receive_id_type=open_id/);
  assert.equal((calls[1]?.headers as Record<string, string>)['Authorization'], 'Bearer t-123');
  assert.equal((calls[1]?.body as { msg_type: string }).msg_type, 'interactive');
});

test('飞书客户端：业务码非 0 时返回失败原因，不抛异常', async () => {
  const { fetchImpl } = fakeFetch([
    { json: { code: 0, tenant_access_token: 't', expire: 7200 } },
    { json: { code: 230002, msg: 'receive_id 无效' } },
  ]);
  const client = createFeishuClient({ appId: 'a', appSecret: 's', fetchImpl });
  const result = await client.sendCard({ receiveId: 'bad', card: {} });
  assert.equal(result.ok, false);
  assert.equal(result.code, 230002);
  assert.match(result.error ?? '', /receive_id/);
});

test('飞书客户端：取 token 失败时抛出，由适配层兜住', async () => {
  const { fetchImpl } = fakeFetch([{ json: { code: 10003, msg: 'invalid app_secret' } }]);
  const client = createFeishuClient({ appId: 'a', appSecret: 'bad', fetchImpl });
  await assert.rejects(() => client.getTenantAccessToken(), /invalid app_secret/);
});

// ---------------------------------------------------------------- 卡片
test('卡片结构：标题、摘要、按钮动作与免责声明齐备', () => {
  const card = renderDailyCard({
    metrics: stubMetrics({ netConvertedTotalMinor: 48_000, expenseCount: 5 }),
    advices: [advice()],
  });
  const json = cardFromRendered(card, { date: DAY }) as {
    header: { title: { content: string }; template: string };
    elements: Array<Record<string, unknown>>;
  };

  assert.equal(json.header.title.content, `今日支出 · ${DAY}`);
  assert.equal(json.header.template, 'orange', '含 warn 建议时用醒目配色');

  const actionBlock = json.elements.find((e) => e['tag'] === 'action') as { actions: Array<{ value: Record<string, string> }> };
  assert.ok(actionBlock);
  const acts = actionBlock.actions.map((a) => a.value['act']);
  assert.deepEqual(acts, ['view_detail', 'snooze', 'mark_inaccurate']);
  assert.equal(actionBlock.actions[0]?.value['date'], DAY);
  assert.equal(actionBlock.actions[0]?.value['ruleId'], 'R1');

  const note = json.elements.find((e) => e['tag'] === 'note');
  assert.ok(note, '带免责要求的建议必须附 note');
  assert.equal(JSON.stringify(json).includes('某某咖啡店'), false, '卡片不得携带商户名');
});

test('卡片：无建议时不带 hr 与 action，也不带免责声明', () => {
  const card = renderDailyCard({ metrics: stubMetrics({ netConvertedTotalMinor: 1000 }), advices: [] });
  const json = cardFromRendered(card, { date: DAY }) as { elements: Array<Record<string, unknown>> };
  assert.equal(json.elements.some((e) => e['tag'] === 'action'), false);
  assert.equal(json.elements.some((e) => e['tag'] === 'note'), false);
});

// ---------------------------------------------------------------- 回调
test('回调解析：card.action.trigger 按钮动作', () => {
  const parsed = parseCallback({
    header: { event_id: 'e1', event_type: 'card.action.trigger' },
    event: {
      operator: { open_id: 'ou_1' },
      action: { value: { act: 'snooze', date: DAY, ruleId: 'R1', adviceId: 'adv_1' }, form_value: {} },
      context: { open_message_id: 'om_1' },
    },
  });
  assert.equal(parsed.kind, 'card_action');
  if (parsed.kind !== 'card_action') return;
  assert.equal(parsed.act, 'snooze');
  assert.equal(parsed.ruleId, 'R1');
  assert.equal(parsed.messageId, 'om_1');

  const outcome = handleCardAction(parsed);
  assert.equal(outcome.feedback?.action, 'snoozed');
  assert.equal(outcome.immediate.toast.type, 'success');
  assert.equal(outcome.navigate, null);
});

test('回调解析：未知事件与未知动作被安全忽略', () => {
  assert.equal(parseCallback({ header: { event_type: 'im.message.receive_v1' } }).kind, 'unknown');
  const parsed = parseCallback({
    header: { event_type: 'card.action.trigger' },
    event: { action: { value: { act: 'delete_everything' } } },
  });
  assert.equal(parsed.kind, 'unknown');
});

test('回调：查看明细/补记/不准各自的回执与落库动作', () => {
  const detail = parseCallback({
    header: { event_type: 'card.action.trigger' },
    event: { action: { value: { act: 'view_detail', date: DAY } } },
  });
  assert.equal(detail.kind, 'card_action');
  if (detail.kind === 'card_action') {
    const outcome = handleCardAction(detail);
    assert.equal(outcome.feedback?.action, 'viewed');
    assert.match(outcome.navigate ?? '', /^\/bills\?date=/);
  }

  const inaccurate = parseCallback({
    header: { event_type: 'card.action.trigger' },
    event: { action: { value: { act: 'mark_inaccurate', ruleId: 'R5' }, form_value: { reason: '分类错误' } } },
  });
  assert.equal(inaccurate.kind, 'card_action');
  if (inaccurate.kind === 'card_action') {
    const outcome = handleCardAction(inaccurate);
    assert.equal(outcome.feedback?.action, 'inaccurate');
    assert.equal(outcome.feedback?.reason, '分类错误');
  }

  const bogusReason = parseCallback({
    header: { event_type: 'card.action.trigger' },
    event: { action: { value: { act: 'mark_inaccurate' }, form_value: { reason: '随便写的' } } },
  });
  if (bogusReason.kind === 'card_action') {
    assert.equal(handleCardAction(bogusReason).feedback?.reason, '其他', '非法原因要回落到「其他」');
  }
});

// ---------------------------------------------------------------- 适配器
test('通道适配器：未配置凭证时如实失败（触发降级）', async () => {
  const channel = createFeishuChannel({ appId: '', appSecret: '', receiveId: '' });
  const card = renderDailyCard({ metrics: stubMetrics(), advices: [] });
  const result = await channel.send({ localDate: DAY, card, adviceIds: [], revision: 1 });
  assert.equal(result.ok, false);
  assert.match(result.detail ?? '', /未配置/);
});

test('通道适配器：配置齐全时把卡片发出去', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { json: { code: 0, tenant_access_token: 't', expire: 7200 } },
    { json: { code: 0, data: { message_id: 'om_9' } } },
  ]);
  const channel = createFeishuChannel({
    appId: 'a',
    appSecret: 's',
    receiveId: 'ou_1',
    fetchImpl,
  });
  const card = renderDailyCard({ metrics: stubMetrics({ netConvertedTotalMinor: 1000 }), advices: [advice()] });
  const result = await channel.send({ localDate: DAY, card, adviceIds: ['adv_1'], revision: 1 });

  assert.equal(result.ok, true);
  assert.match(result.detail ?? '', /om_9/);
  assert.match(calls[1]?.url ?? '', /receive_id_type=open_id/);
  assert.equal(channel.capabilities().supportsCallbacks, true);
});

test('接收人类型按 ID 形态自动推断', () => {
  assert.equal(inferReceiveIdType('oc_a6ffde15'), 'chat_id');
  assert.equal(inferReceiveIdType('ou_b4b78997'), 'open_id');
  assert.equal(inferReceiveIdType('me@example.com'), 'email');
  assert.equal(inferReceiveIdType('  匿名ID  '), 'open_id');
});

// 真实踩坑回归：群 ID 若按 open_id 发会报 99992351（"ID 无效"），
// 容易被误判成权限问题。这里锁死"不显式指定时必须按形态推断"。
test('通道适配器：不显式指定类型时，群 ID 必须走 chat_id', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { json: { code: 0, tenant_access_token: 't', expire: 7200 } },
    { json: { code: 0, data: { message_id: 'om_chat' } } },
  ]);
  const channel = createFeishuChannel({
    appId: 'a',
    appSecret: 's',
    receiveId: 'oc_a6ffde156d5b6cdf4e426e157cf0056b',
    fetchImpl,
  });
  const card = renderDailyCard({ metrics: stubMetrics(), advices: [] });
  const result = await channel.send({ localDate: DAY, card, adviceIds: [], revision: 1 });

  assert.equal(result.ok, true);
  assert.match(calls[1]?.url ?? '', /receive_id_type=chat_id/);
  assert.equal((calls[1]?.body as { receive_id: string }).receive_id, 'oc_a6ffde156d5b6cdf4e426e157cf0056b');
  assert.match(result.detail ?? '', /chat_id=/);
});

test('通道适配器：邮箱接收人自动走 email', async () => {
  const { fetchImpl, calls } = fakeFetch([
    { json: { code: 0, tenant_access_token: 't', expire: 7200 } },
    { json: { code: 0, data: { message_id: 'om_mail' } } },
  ]);
  const channel = createFeishuChannel({ appId: 'a', appSecret: 's', receiveId: 'me@example.com', fetchImpl });
  const card = renderDailyCard({ metrics: stubMetrics(), advices: [] });
  await channel.send({ localDate: DAY, card, adviceIds: [], revision: 1 });
  assert.match(calls[1]?.url ?? '', /receive_id_type=email/);
});

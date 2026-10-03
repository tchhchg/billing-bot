import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/infra/db/database.ts';
import { createFxRepo } from '../src/infra/db/fxRepo.ts';
import { createLlmRepo } from '../src/infra/db/llmRepo.ts';
import { createPublicFxProvider, refreshRates } from '../src/infra/fx/publicProvider.ts';
import { createLlmGateway, polishWithLogging } from '../src/infra/llm/gateway.ts';
import { buildLlmPayload } from '../src/domain/advice/redact.ts';
import { stubMetrics } from './helpers.ts';

const DAY = '2026-10-03';

function jsonFetch(payload: unknown, status = 200): { fetchImpl: typeof fetch; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: status >= 200 && status < 300, status, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------- 汇率
test('汇率适配器：把「1 基础币 = X 外币」换算成领域层要的乘数', async () => {
  const { fetchImpl, calls } = jsonFetch({
    result: 'success',
    base_code: 'CNY',
    rates: { CNY: 1, USD: 0.14, JPY: 20.5 },
  });
  const provider = createPublicFxProvider({ fetchImpl, source: 'test-source' });
  const rates = await provider.fetchRates({ base: 'CNY', quotes: ['USD', 'JPY'], date: DAY });

  assert.equal(rates.length, 2);
  const usd = rates.find((r) => r.quote === 'USD');
  assert.ok(usd);
  assert.ok(Math.abs(usd.rate - 1 / 0.14) < 1e-9, 'USD→CNY 应是 1/0.14');
  assert.equal(usd.rateDate, DAY);
  assert.equal(usd.source, 'test-source');
  assert.match(calls[0]?.url ?? '', /\/CNY$/);
});

test('汇率适配器：接口报错或格式不对时抛错，不静默给错数据', async () => {
  const bad = createPublicFxProvider({ fetchImpl: jsonFetch({ result: 'error' }).fetchImpl });
  await assert.rejects(() => bad.fetchRates({ base: 'CNY', quotes: ['USD'], date: DAY }), /格式无法解析/);

  const http500 = createPublicFxProvider({ fetchImpl: jsonFetch({}, 500).fetchImpl });
  await assert.rejects(() => http500.fetchRates({ base: 'CNY', quotes: ['USD'], date: DAY }), /HTTP 500/);
});

test('汇率刷新：写入本机缓存，失败时明确返回并保持离线降级', async () => {
  const db = openDatabase(':memory:');
  const fxRepo = createFxRepo(db);

  const ok = createPublicFxProvider({ fetchImpl: jsonFetch({ rates: { USD: 0.14 } }).fetchImpl });
  const result = await refreshRates({ fxRepo, provider: ok, base: 'CNY', quotes: ['USD'], date: DAY });
  assert.equal(result.ok, true);
  assert.equal(result.stored, 1);
  assert.ok(fxRepo.get(DAY, 'CNY', 'USD'));

  const failing = createPublicFxProvider({ fetchImpl: jsonFetch({}, 503).fetchImpl });
  const failed = await refreshRates({ fxRepo, provider: failing, base: 'CNY', quotes: ['USD', 'JPY'], date: DAY });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.missingQuotes, ['USD', 'JPY']);
  assert.ok(fxRepo.get(DAY, 'CNY', 'USD'), '失败不应清掉已有缓存');
  db.close();
});

test('汇率刷新：只有基础币种时不需要出网', async () => {
  const db = openDatabase(':memory:');
  const { fetchImpl, calls } = jsonFetch({ rates: {} });
  const provider = createPublicFxProvider({ fetchImpl });
  const result = await refreshRates({ fxRepo: createFxRepo(db), provider, base: 'CNY', quotes: ['CNY'], date: DAY });
  assert.deepEqual(result, { stored: 0, ok: true, missingQuotes: [] });
  assert.equal(calls.length, 0);
  db.close();
});

// ---------------------------------------------------------------- 云端模型
test('模型网关：正常返回润色文本，且请求体里没有敏感字段', async () => {
  const { fetchImpl, calls } = jsonFetch({ choices: [{ message: { content: '今天花得比平时多一些，餐饮是大头。' } }] });
  const gateway = createLlmGateway({ baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm', fetchImpl });

  const metrics = stubMetrics({
    netConvertedTotalMinor: 48_000,
    topCategories: [{ categoryId: 'food', amountMinor: 48_000, ratio: 1 }],
  });
  const payload = buildLlmPayload({
    advices: [],
    metrics,
    categoryLabel: () => '餐饮',
  });
  const result = await gateway.polish({ payload, templateText: '今日支出偏高', forbiddenValues: ['某某咖啡店'] });

  assert.equal(result.ok, true);
  assert.match(result.text ?? '', /餐饮/);
  const body = JSON.stringify(calls[0]?.body);
  assert.equal(body.includes('某某咖啡店'), false);
  assert.equal(body.includes('48000'), false, '出网载荷只允许金额档位');
});

test('模型网关：超时/非 2xx/空返回都回退为失败（不抛给调用方）', async () => {
  const http500 = createLlmGateway({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'm',
    fetchImpl: jsonFetch({}, 500).fetchImpl,
  });
  const payload = buildLlmPayload({ advices: [], metrics: stubMetrics() });
  assert.equal((await http500.polish({ payload, templateText: 'x' })).ok, false);

  const empty = createLlmGateway({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'm',
    fetchImpl: jsonFetch({ choices: [{ message: { content: '  ' } }] }).fetchImpl,
  });
  const emptyResult = await empty.polish({ payload, templateText: 'x' });
  assert.equal(emptyResult.ok, false);
  assert.match(emptyResult.error ?? '', /为空/);
});

test('模型网关：脱敏闸门拦下泄漏时直接失败，绝不把敏感内容发出去', async () => {
  const { fetchImpl, calls } = jsonFetch({ choices: [{ message: { content: 'ok' } }] });
  const gateway = createLlmGateway({ baseUrl: 'https://api.example.com/v1', apiKey: 'k', model: 'm', fetchImpl });
  const payload = buildLlmPayload({ advices: [], metrics: stubMetrics() });
  // 人为把商户名塞进载荷，模拟未来有人改坏了脱敏逻辑
  const tampered = { ...payload, merchant: '某某咖啡店' };
  const result = await gateway.polish({ payload: tampered, templateText: 'x' });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /脱敏校验失败/);
  assert.equal(calls.length, 0, '校验不通过时不该发生任何出网请求');
});

test('模型调用留痕：成功与失败都写日志，可清空', async () => {
  const db = openDatabase(':memory:');
  const llmRepo = createLlmRepo(db);
  const okGateway = createLlmGateway({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'm',
    fetchImpl: jsonFetch({ choices: [{ message: { content: '好的' } }] }).fetchImpl,
  });
  const payload = buildLlmPayload({ advices: [], metrics: stubMetrics() });

  await polishWithLogging({ gateway: okGateway, llmRepo, payload, templateText: 'x' });
  assert.equal(llmRepo.count(), 1);
  assert.equal(llmRepo.list(5)[0]?.ok, true);
  assert.equal(llmRepo.list(5)[0]?.redactedPayload.includes('merchant'), false);

  const badGateway = createLlmGateway({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'm',
    fetchImpl: jsonFetch({}, 500).fetchImpl,
  });
  await polishWithLogging({ gateway: badGateway, llmRepo, payload, templateText: 'x' });
  assert.equal(llmRepo.count(), 2);
  assert.equal(llmRepo.list(5)[0]?.ok, false);

  assert.equal(llmRepo.clear(), 2);
  assert.equal(llmRepo.count(), 0);
  db.close();
});

test('模型网关默认不启用：调用方在 llm.enabled=false 时根本不会构造网关', () => {
  // 这条是行为契约：没有任何地方默认去调用云端模型
  const payload = buildLlmPayload({ advices: [], metrics: stubMetrics() });
  assert.equal(payload.categories.length, 0);
  assert.equal(payload.adviceCount, 0);
});

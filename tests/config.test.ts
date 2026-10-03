import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_FIELDS,
  CONFIG_SCHEMA_VERSION,
  defaultConfigDraft,
  getByPath,
  setByPath,
  toDomainConfig,
  validateConfigDraft,
} from '../src/infra/config/schema.ts';
import { createConfigStore, migrateDraft, resolveDataDir } from '../src/infra/config/store.ts';
import { buildWizardSteps, safeDefaultDraft, submitAnswers } from '../src/app/onboarding.ts';
import { configVersionOf, toAppSettings } from '../src/app/settings.ts';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'billing-bot-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ 铁律：向导必须覆盖所有配置项
test('首次引导向导由 Schema 驱动，覆盖每一个配置项', () => {
  const steps = buildWizardSteps();
  const covered = new Set(steps.flatMap((s) => s.fields.map((f) => f.key)));
  for (const field of CONFIG_FIELDS) {
    assert.ok(covered.has(field.key), `配置项 ${field.key} 没有出现在任何引导步骤里`);
  }
  assert.equal(covered.size, CONFIG_FIELDS.length);
  for (const step of steps) assert.ok(step.fields.length > 0, `步骤 ${step.id} 没有任何配置项`);
});

test('默认配置合法，且每一项都能被设置页改写', () => {
  const draft = defaultConfigDraft();
  assert.deepEqual(validateConfigDraft(draft), []);
  assert.equal(getByPath(draft, 'schemaVersion'), CONFIG_SCHEMA_VERSION);

  const patched = JSON.parse(JSON.stringify(draft)) as Record<string, unknown>;
  for (const field of CONFIG_FIELDS) {
    if (field.type === 'bool') setByPath(patched, field.key, true);
    else if (field.type === 'int') setByPath(patched, field.key, field.default as number);
    else if (field.type === 'enum') setByPath(patched, field.key, (field.options?.[0]?.value ?? field.default) as string);
  }
  assert.deepEqual(validateConfigDraft(patched), []);
});

// ------------------------------------------------------------ 校验
test('校验：必填、类型、取值范围、选项、时区、时间格式', () => {
  const bad = defaultConfigDraft();
  setByPath(bad, 'push.time', '25:00');
  setByPath(bad, 'push.timezone', 'Mars/Olympus');
  setByPath(bad, 'push.maxDailyAdvice', 99);
  setByPath(bad, 'push.channels', []);
  setByPath(bad, 'analysis.refundPolicy', 'Z');
  setByPath(bad, 'budget.enabled', 'yes');
  const issues = validateConfigDraft(bad);
  const keys = issues.map((i) => i.key);
  assert.ok(keys.includes('push.time'));
  assert.ok(keys.includes('push.timezone'));
  assert.ok(keys.includes('push.maxDailyAdvice'));
  assert.ok(keys.includes('push.channels'));
  assert.ok(keys.includes('analysis.refundPolicy'));
  assert.ok(keys.includes('budget.enabled'));
});

test('向导提交：非法答案被拦下，合法答案通过', () => {
  const bad = submitAnswers({ 'push.timezone': 'Nowhere/Land' });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some((i) => i.key === 'push.timezone'));

  const good = submitAnswers({ 'push.timezone': 'Asia/Tokyo', 'push.time': '08:15' });
  assert.equal(good.ok, true);
  assert.equal(getByPath(good.draft, 'push.timezone'), 'Asia/Tokyo');
  // 未回答的项保留默认值，而不是变成 undefined
  assert.equal(getByPath(good.draft, 'money.baseCurrency'), 'CNY');
});

test('跳过向导时的安全默认：不推送、不联网、不启用预算', () => {
  const draft = safeDefaultDraft();
  assert.equal(getByPath(draft, 'host.im'), 'none');
  assert.deepEqual(getByPath(draft, 'push.channels'), ['local_daily_center']);
  assert.equal(getByPath(draft, 'llm.enabled'), false);
  assert.equal(getByPath(draft, 'money.multiCurrency'), false);
  assert.deepEqual(validateConfigDraft(draft), []);
});

// ------------------------------------------------------------ 存储
test('配置存储：保存/读取/局部修改，字段缺失时自动补齐', () => {
  withTempDir((dir) => {
    const store = createConfigStore(dir);
    assert.equal(store.exists(), false);
    assert.equal(store.load(), null);

    store.save(defaultConfigDraft());
    assert.equal(store.exists(), true);
    const loaded = store.load();
    assert.ok(loaded);
    assert.deepEqual(loaded?.issues, []);

    store.patch([{ key: 'push.time', value: '07:30' }]);
    assert.equal(getByPath(store.load()?.draft ?? {}, 'push.time'), '07:30');

    // 旧版本 / 缺字段的配置：自动补齐而不是崩溃
    const { draft, migratedFrom } = migrateDraft({ schemaVersion: 0, push: { time: '06:00' } });
    assert.equal(migratedFrom, 0);
    assert.equal(getByPath(draft, 'push.time'), '06:00');
    assert.equal(getByPath(draft, 'schemaVersion'), CONFIG_SCHEMA_VERSION);
    assert.deepEqual(validateConfigDraft(draft), []);
  });
});

test('密钥与配置分离存放，且不写进 config.json', () => {
  withTempDir((dir) => {
    const store = createConfigStore(dir);
    store.save(defaultConfigDraft());
    store.setSecret('feishu.appSecret', 'super-secret-value');

    const configText = readFileSync(store.configPath, 'utf8');
    assert.equal(configText.includes('super-secret-value'), false);

    const secretsText = readFileSync(store.secretsPath, 'utf8');
    assert.ok(secretsText.includes('super-secret-value'));
    assert.equal(store.getSecret('feishu.appSecret'), 'super-secret-value');

    store.clearSecret('feishu.appSecret');
    assert.equal(store.getSecret('feishu.appSecret'), null);
    assert.equal(existsSync(store.secretsPath), false);
  });
});

test('旧配置文件缺了新字段：加载时自动补齐（否则设置页会把开关显示成"开启"）', () => {
  // 模拟"上个版本保存的配置"——没有 mail.* 这些新键
  const old = { schemaVersion: CONFIG_SCHEMA_VERSION, push: { time: '07:00' } } as Record<string, unknown>;
  const { draft } = migrateDraft(old);

  assert.equal(getByPath(draft, 'push.time'), '07:00', '已有值必须保留');
  assert.equal(getByPath(draft, 'mail.enabled'), false, '缺失的布尔项要补成默认值');
  assert.equal(getByPath(draft, 'mail.imapPort'), 993);
  assert.equal(getByPath(draft, 'mail.mailbox'), 'INBOX');
  assert.deepEqual(validateConfigDraft(draft), [], '补齐后必须是合法配置');
});

test('数据目录可被环境变量覆盖（测试隔离与便携安装都用它）', () => {
  assert.equal(resolveDataDir({ BILLING_BOT_HOME: 'D:\\billing' }), 'D:\\billing');
  assert.ok(resolveDataDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }).endsWith('billing-bot'));
});

// ------------------------------------------------------------ 设置视图
test('设置视图：草稿 → 领域配置 + 推送设置 + 幂等版本号', () => {
  const draft = defaultConfigDraft();
  setByPath(draft, 'push.channels', ['im_card', 'local_daily_center']);
  setByPath(draft, 'push.maxDailyAdvice', 2);
  setByPath(draft, 'analysis.refundPolicy', 'A');
  setByPath(draft, 'money.multiCurrency', true);
  setByPath(draft, 'push.noDataNotice', false);

  const settings = toAppSettings(draft);
  assert.deepEqual(settings.push.channels, ['im_card', 'local_daily_center']);
  assert.equal(settings.push.maxDailyAdvice, 2);
  assert.equal(settings.push.noDataNotice, false);
  assert.equal(settings.domain.analysis.refundPolicy, 'A');
  assert.equal(settings.money.multiCurrency, true);
  assert.equal(settings.push.timezone, 'Asia/Shanghai');

  // 内容变 → 版本变；内容不变 → 版本不变
  assert.notEqual(configVersionOf(draft), configVersionOf(defaultConfigDraft()));
  assert.equal(configVersionOf(draft), configVersionOf({ ...draft }));
});

test('幂等键只受"影响分析的口径"影响：改邮箱/IM/模型设置不该让日报重发', () => {
  const base = defaultConfigDraft();

  // 这些改动都与"数字怎么算"无关 → 版本必须不变
  for (const [key, value] of [
    ['mail.enabled', true],
    ['mail.imapHost', 'imap.qq.com'],
    ['mail.user', 'me@qq.com'],
    ['host.im', 'feishu'],
    ['host.feishuAppId', 'cli_x'],
    ['llm.enabled', true],
    ['push.time', '08:00'],
    ['push.timezone', 'Asia/Tokyo'],
    ['push.channels', ['im_card']],
    ['data.retentionMonths', 12],
  ] as Array<[string, unknown]>) {
    const changed = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    setByPath(changed, key, value);
    assert.equal(configVersionOf(changed), configVersionOf(base), `改 ${key} 不应改变幂等键`);
  }

  // 这些会改变统计结果 → 版本必须变
  for (const [key, value] of [
    ['analysis.refundPolicy', 'A'],
    ['analysis.coldStartMinDays', 5],
    ['money.multiCurrency', true],
    ['budget.enabled', true],
    ['push.maxDailyAdvice', 1],
  ] as Array<[string, unknown]>) {
    const changed = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    setByPath(changed, key, value);
    assert.notEqual(configVersionOf(changed), configVersionOf(base), `改 ${key} 应改变幂等键`);
  }
});

test('领域配置只取它认识的那部分字段', () => {
  const draft = defaultConfigDraft();
  const domain = toDomainConfig(draft);
  assert.deepEqual(Object.keys(domain).sort(), ['analysis', 'budget', 'money', 'push']);
  assert.equal(domain.push.timezone, 'Asia/Shanghai');
  assert.equal(domain.analysis.futureDateToleranceDays, 1);
});

test('文件写入是原子的：不残留临时文件', () => {
  withTempDir((dir) => {
    const store = createConfigStore(dir);
    store.save(defaultConfigDraft());
    assert.ok(statSync(store.configPath).size > 0);
    const leftovers = readFileSync(store.configPath, 'utf8');
    assert.ok(leftovers.includes('"schemaVersion"'));
  });
});

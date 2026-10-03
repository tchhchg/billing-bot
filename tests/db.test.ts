import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, currentVersion, tx } from '../src/infra/db/database.ts';
import { SCHEMA_VERSION } from '../src/infra/db/schema.ts';
import { createBillRepo } from '../src/infra/db/billRepo.ts';
import { createCategoryRepo } from '../src/infra/db/categoryRepo.ts';
import { createRunRepo } from '../src/infra/db/runRepo.ts';
import { createFxRepo } from '../src/infra/db/fxRepo.ts';
import { cooldownReason, createFeedbackRepo } from '../src/infra/db/feedbackRepo.ts';
import { createImportRepo } from '../src/infra/db/importRepo.ts';
import { createAuditRepo } from '../src/infra/db/auditRepo.ts';
import { PRESET_CATEGORIES } from '../src/domain/category.ts';
import { makeBill } from './helpers.ts';

const NOW = '2026-10-03T13:00:00.000Z';
const TZ = 'Asia/Shanghai';

function freshDb(): ReturnType<typeof openDatabase> {
  const db = openDatabase(':memory:');
  return db;
}

test('打开数据库即完成迁移，版本号正确', () => {
  const db = freshDb();
  assert.equal(currentVersion(db), SCHEMA_VERSION);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as unknown as Array<{
    name: string;
  }>).map((r) => r.name);
  for (const expected of ['bill', 'daily_run', 'fx_rate', 'advice_feedback', 'import_batch', 'csv_mapping', 'rule_pref']) {
    assert.ok(tables.includes(expected), `缺少表 ${expected}`);
  }
  db.close();
});

test('迁移可重复调用（幂等）', () => {
  const db = freshDb();
  assert.equal(currentVersion(db), SCHEMA_VERSION);
  db.close();
});

test('账单：插入、幂等插入、软删与恢复', () => {
  const db = freshDb();
  const bills = createBillRepo(db);

  const a = makeBill({ billId: 'a', amountMinor: 1000, occurredAt: '2026-10-03T10:00:00+08:00', sourceRef: 'SN001' });
  bills.insert(a);
  assert.equal(bills.count(), 1);

  const dup = makeBill({ billId: 'a2', amountMinor: 1000, occurredAt: '2026-10-03T10:00:00+08:00', sourceRef: 'SN001' });
  assert.equal(bills.insertIfNew(dup), 'duplicate');
  assert.equal(bills.count(), 1, 'source_ref 相同的导入不应重复入库');

  const fresh = makeBill({ billId: 'b', amountMinor: 2000, occurredAt: '2026-10-03T11:00:00+08:00', sourceRef: 'SN002' });
  assert.equal(bills.insertIfNew(fresh), 'inserted');
  assert.equal(bills.count(), 2);

  assert.equal(bills.softDelete('b', NOW), true);
  assert.equal(bills.count(), 1);
  assert.equal(bills.count(true), 2);
  assert.equal(bills.getById('b')?.deletedAt, NOW);

  assert.equal(bills.restore('b'), true);
  assert.equal(bills.count(), 2);
  db.close();
});

test('账单：乐观锁更新，版本不匹配则拒绝', () => {
  const db = freshDb();
  const bills = createBillRepo(db);
  const bill = makeBill({ billId: 'a', amountMinor: 1000, occurredAt: '2026-10-03T10:00:00+08:00' });
  bills.insert(bill);

  assert.equal(bills.update({ ...bill, merchant: 'X' }, 99), false, '版本不符必须拒绝');

  assert.equal(bills.update({ ...bill, amountMinor: 1500, merchant: 'X' }, 1), true);
  const after = bills.getById('a');
  assert.equal(after?.amountMinor, 1500);
  assert.equal(after?.version, 2);
  db.close();
});

test('账单：按本地自然日查询，跨零点归属正确', () => {
  const db = freshDb();
  const bills = createBillRepo(db);
  bills.insert(makeBill({ billId: 'a', amountMinor: 100, occurredAt: '2026-10-03T23:59:00+08:00' }));
  bills.insert(makeBill({ billId: 'b', amountMinor: 200, occurredAt: '2026-10-04T00:00:00+08:00' }));
  bills.insert(makeBill({ billId: 'c', amountMinor: 300, occurredAt: '2026-10-03T00:00:00+08:00' }));

  const day3 = bills.listByLocalDay('2026-10-03', TZ).map((b) => b.billId);
  assert.deepEqual(day3, ['c', 'a']);

  const day4 = bills.listByLocalDay('2026-10-04', TZ).map((b) => b.billId);
  assert.deepEqual(day4, ['b']);

  // 换一个时区，同一批数据归属到不同的日子
  assert.equal(bills.listByLocalDay('2026-10-03', 'UTC').length, 2);
  db.close();
});

test('账单：多条件查询（分类/金额/关键词/标签/状态）', () => {
  const db = freshDb();
  const bills = createBillRepo(db);
  bills.insert(makeBill({ billId: 'a', amountMinor: 1000, categoryId: 'food', merchant: '咖啡馆', tags: ['日常'], occurredAt: '2026-10-01T10:00:00+08:00' }));
  bills.insert(makeBill({ billId: 'b', amountMinor: 90000, categoryId: 'shopping', merchant: '电商', occurredAt: '2026-10-02T10:00:00+08:00' }));
  bills.insert(makeBill({ billId: 'c', amountMinor: 3000, categoryId: null, status: 'pending_review', occurredAt: '2026-10-03T10:00:00+08:00' }));

  const byCategory = bills.query({ timeZone: TZ, categoryId: 'food' }).map((b) => b.billId);
  assert.deepEqual(byCategory, ['a']);

  const uncategorized = bills.query({ timeZone: TZ, categoryId: null }).map((b) => b.billId);
  assert.deepEqual(uncategorized, ['c']);

  const byAmount = bills.query({ timeZone: TZ, minMinor: 2000, maxMinor: 5000 }).map((b) => b.billId);
  assert.deepEqual(byAmount, ['c']);

  const byKeyword = bills.query({ timeZone: TZ, keyword: '咖啡' }).map((b) => b.billId);
  assert.deepEqual(byKeyword, ['a']);

  const byTag = bills.query({ timeZone: TZ, tag: '日常' }).map((b) => b.billId);
  assert.deepEqual(byTag, ['a']);

  const byStatus = bills.query({ timeZone: TZ, status: ['pending_review'] }).map((b) => b.billId);
  assert.deepEqual(byStatus, ['c']);

  const byDate = bills.query({ timeZone: TZ, fromDate: '2026-10-02', toDate: '2026-10-03' }).map((b) => b.billId);
  assert.deepEqual(byDate, ['c', 'b']);

  const paged = bills.query({ timeZone: TZ, limit: 1, offset: 1 }).map((b) => b.billId);
  assert.equal(paged.length, 1);
  db.close();
});

test('账单：疑似重复候选窗口', () => {
  const db = freshDb();
  const bills = createBillRepo(db);
  const target = makeBill({ billId: 't', amountMinor: 5000, merchant: 'A', occurredAt: '2026-10-03T12:00:00+08:00' });
  bills.insert(target);
  bills.insert(makeBill({ billId: 'near', amountMinor: 5000, merchant: 'A', occurredAt: '2026-10-02T12:00:00+08:00' }));
  bills.insert(makeBill({ billId: 'far', amountMinor: 5000, merchant: 'A', occurredAt: '2026-09-20T12:00:00+08:00' }));

  const hits = bills.findSimilar({
    amountMinor: 5000,
    currency: 'CNY',
    occurredAtMs: Date.parse('2026-10-03T12:00:00+08:00'),
    timeZone: TZ,
    windowDays: 1,
    merchant: 'A',
  });
  assert.deepEqual(hits.map((b) => b.billId).sort(), ['near', 't']);
  db.close();
});

test('分类与规则：预置写入幂等，规则可增删', () => {
  const db = freshDb();
  const categories = createCategoryRepo(db);
  categories.seedPreset(PRESET_CATEGORIES, NOW);
  categories.seedPreset(PRESET_CATEGORIES, NOW);
  assert.equal(categories.count(), PRESET_CATEGORIES.length);

  const id = categories.upsertRule({ kind: 'merchant', pattern: '星巴克', categoryId: 'food.drinks', now: NOW });
  assert.ok(id > 0);
  const again = categories.upsertRule({ kind: 'merchant', pattern: '星巴克', categoryId: 'food', now: NOW });
  const rules = categories.listRules();
  assert.equal(rules.length, 1, '同 kind+pattern 只保留一条');
  assert.equal(rules[0]?.categoryId, 'food');
  assert.equal(again, rules[0]?.id);

  categories.bumpRule(rules[0]!.id, NOW);
  assert.equal(categories.listRules()[0]?.hits, 1);
  categories.removeRule(rules[0]!.id);
  assert.equal(categories.listRules().length, 0);
  db.close();
});

test('分类删除时账单迁移到未分类，不留下悬空引用', () => {
  const db = freshDb();
  const categories = createCategoryRepo(db);
  const bills = createBillRepo(db);
  categories.insertIfAbsent({ categoryId: 'tmp', parentId: null, name: '临时', preset: false, sort: 1 });
  bills.insert(makeBill({ billId: 'a', amountMinor: 100, categoryId: 'tmp', occurredAt: '2026-10-03T10:00:00+08:00' }));

  categories.remove('tmp', null);
  assert.equal(bills.getById('a')?.categoryId, null);
  assert.equal(categories.list().length, 0);
  db.close();
});

test('汇率仓储：写入、按日读取、最近可用、充当 FxLookup', () => {
  const db = freshDb();
  const fx = createFxRepo(db);
  fx.putMany([
    { rateDate: '2026-09-30', base: 'CNY', quote: 'USD', rate: 7.0, source: 'test', fetchedAt: NOW },
    { rateDate: '2026-10-03', base: 'CNY', quote: 'USD', rate: 7.1, source: 'test', fetchedAt: NOW },
  ]);
  assert.equal(fx.count(), 2);
  assert.equal(fx.get('2026-10-03', 'CNY', 'USD')?.rate, 7.1);
  assert.equal(fx.get('2026-10-02', 'CNY', 'USD'), null);
  assert.equal(fx.latest('CNY', 'USD')?.rateDate, '2026-10-03');

  const lookup = fx.lookup();
  assert.equal(lookup.onDate('2026-10-03', 'CNY', 'USD'), 7.1);
  assert.equal(lookup.onDate('2026-10-02', 'CNY', 'USD'), null);
  assert.deepEqual(lookup.latest('CNY', 'USD'), { rate: 7.1, rateDate: '2026-10-03' });
  assert.equal(lookup.onDate('2026-10-03', 'CNY', 'CNY'), 1);
  assert.equal(lookup.latest('CNY', 'JPY'), null);

  assert.deepEqual(fx.findMissingDates('CNY', ['USD'], ['2026-10-02', '2026-10-03']), ['2026-10-02']);
  db.close();
});

test('运行记录：保存、推送状态、修订号递增', () => {
  const db = freshDb();
  const runs = createRunRepo(db);
  const key = '2026-10-03:1.0.0:abcd1234';
  assert.equal(runs.get(key), null);

  runs.save({ runKey: key, localDate: '2026-10-03', metricsJson: '{}', advicesJson: '[]' });
  assert.equal(runs.get(key)?.revision, 1);
  assert.equal(runs.get(key)?.pushedAt, null);

  runs.markPushed({ runKey: key, at: NOW, channel: 'local_daily_center', status: 'pushed', revision: 1 });
  assert.equal(runs.get(key)?.pushStatus, 'pushed');
  assert.equal(runs.latestForDate('2026-10-03')?.runKey, key);
  assert.equal(runs.nextRevision(key), 2);
  assert.equal(runs.countPushedSince('2026-10-01T00:00:00.000Z'), 1);
  db.close();
});

test('反馈仓储：忽略/不准/稍后提醒 → 降噪状态', () => {
  const db = freshDb();
  const feedback = createFeedbackRepo(db);
  feedback.add({ adviceId: 'adv_1', ruleId: 'R1', action: 'inaccurate', reason: '分类错误' }, NOW);
  feedback.add({ adviceId: 'adv_1', ruleId: 'R1', action: 'inaccurate' }, NOW);
  feedback.add({ adviceId: 'adv_2', ruleId: 'R5', action: 'snoozed', reason: cooldownReason('2026-10-10') }, NOW);
  feedback.muteRule('R9', NOW);

  const state = feedback.state();
  assert.equal(state.inaccurateCounts['R1'], 2);
  assert.deepEqual(state.mutedRuleIds, ['R9']);
  assert.equal(state.cooldownUntil['R5'], '2026-10-10');

  feedback.resetInaccurate('R1');
  assert.equal(feedback.state().inaccurateCounts['R1'], undefined);
  feedback.unmuteRule('R9');
  assert.deepEqual(feedback.mutedRules(), []);
  db.close();
});

test('导入批次与列映射模板', () => {
  const db = freshDb();
  const imports = createImportRepo(db);
  assert.equal(imports.batchExists('hash1', 'alipay'), false);

  imports.saveBatch(
    {
      batchId: 'batch1',
      fileName: 'alipay.csv',
      fileSha256: 'hash1',
      sourceKind: 'alipay',
      mappingJson: null,
      okCount: 10,
      dupCount: 1,
      failCount: 0,
      reportJson: null,
    },
    NOW,
  );
  assert.equal(imports.batchExists('hash1', 'alipay'), true);
  assert.equal(imports.listBatches(5)[0]?.okCount, 10);

  imports.saveMapping({
    sourceKind: 'bank',
    name: '招商银行',
    mapping: { columns: { 交易日期: 'occurredAt', 金额: 'amountMinor' }, amountUnit: 'major', headerRow: 3 },
    now: NOW,
  });
  const mapping = imports.getMapping('bank', '招商银行');
  assert.equal(mapping?.columns['金额'], 'amountMinor');
  assert.equal(mapping?.headerRow, 3);
  assert.equal(imports.listMappings('bank').length, 1);
  assert.equal(imports.listMappings('alipay').length, 0);
  db.close();
});

test('审计：编辑留痕可回溯', () => {
  const db = freshDb();
  const audit = createAuditRepo(db);
  audit.append({ billId: 'a', action: 'create', afterJson: '{"amountMinor":100}' }, NOW);
  audit.append({ billId: 'a', action: 'update', beforeJson: '{"amountMinor":100}', afterJson: '{"amountMinor":200}' }, NOW);
  assert.equal(audit.count(), 2);
  const history = audit.listForBill('a', 10);
  assert.equal(history[0]?.action, 'update');
  assert.equal(history[1]?.action, 'create');
  db.close();
});

test('事务：抛错回滚，数据不半写', () => {
  const db = freshDb();
  const bills = createBillRepo(db);
  assert.throws(() =>
    tx(db, () => {
      bills.insert(makeBill({ billId: 'x', amountMinor: 100, occurredAt: '2026-10-03T10:00:00+08:00' }));
      throw new Error('boom');
    }),
  );
  assert.equal(bills.count(), 0);
  db.close();
});

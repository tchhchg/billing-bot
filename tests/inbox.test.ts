import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/infra/db/database.ts';
import { createBillRepo } from '../src/infra/db/billRepo.ts';
import { createCategoryRepo } from '../src/infra/db/categoryRepo.ts';
import { createImportRepo } from '../src/infra/db/importRepo.ts';
import { hasImportedToday, listInboxFiles, scanInbox, type InboxDeps } from '../src/app/inbox.ts';
import { defaultConfigDraft, setByPath } from '../src/infra/config/schema.ts';
import { toAppSettings } from '../src/app/settings.ts';
import { PRESET_CATEGORIES } from '../src/domain/category.ts';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-10-03T21:05:00+08:00');

const ALIPAY = `交易时间,交易分类,交易对方,商品说明,收/支,金额,交易订单号
2026-10-01 12:30:45,餐饮美食,某某餐厅,午餐,支出,¥38.00,SN1001
2026-10-02 08:15:00,交通出行,地铁,地铁票,支出,¥5.00,SN1002
`;

function settingsWith(over: (d: Record<string, unknown>) => void = () => {}) {
  const draft = defaultConfigDraft();
  setByPath(draft, 'push.timezone', TZ);
  over(draft);
  return toAppSettings(draft);
}

function makeEnv(): { dir: string; deps: InboxDeps; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'billing-inbox-'));
  const inbox = join(dir, 'inbox');
  mkdirSync(inbox, { recursive: true });
  const db = openDatabase(':memory:');
  const deps: InboxDeps = {
    bills: createBillRepo(db),
    categories: createCategoryRepo(db),
    imports: createImportRepo(db),
    settings: () => settingsWith(),
  };
  deps.categories.seedPreset(PRESET_CATEGORIES, NOW.toISOString());
  return { dir: inbox, deps, close: () => db.close() };
}

function withEnv(fn: (env: ReturnType<typeof makeEnv>) => void): void {
  const env = makeEnv();
  try {
    fn(env);
  } finally {
    env.close();
    rmSync(join(env.dir, '..'), { recursive: true, force: true });
  }
}

test('丢进投递箱即自动导入，并归档到 done/', () => {
  withEnv((env) => {
    writeFileSync(join(env.dir, 'alipay.csv'), ALIPAY, 'utf8');
    const result = scanInbox(env.deps, { dir: env.dir, now: () => NOW });

    assert.equal(result.found, 1);
    assert.equal(result.imported, 1);
    assert.equal(result.failed, 0);
    assert.equal(env.deps.bills.count(), 2);
    assert.equal(result.importedToday, true);

    // 归档：原文件消失、done/ 里有带时间戳的副本
    assert.equal(existsSync(join(env.dir, 'alipay.csv')), false);
    const done = listInboxFiles(join(env.dir));
    assert.deepEqual(done, []);
    assert.equal(existsSync(join(env.dir, 'done')), true);

    // 日志可审计
    const log = readFileSync(join(env.dir, 'inbox.log'), 'utf8').trim().split('\n');
    assert.equal(log.length, 1);
    assert.match(log[0] ?? '', /"imported":1/);
  });
});

test('同一份文件再丢一次：文件指纹拦截，不重复入库', () => {
  withEnv((env) => {
    writeFileSync(join(env.dir, 'a.csv'), ALIPAY, 'utf8');
    scanInbox(env.deps, { dir: env.dir, now: () => NOW });
    assert.equal(env.deps.bills.count(), 2);

    writeFileSync(join(env.dir, 'a.csv'), ALIPAY, 'utf8');
    const second = scanInbox(env.deps, { dir: env.dir, now: () => NOW });
    assert.equal(second.alreadyImported, 1);
    assert.equal(second.imported, 0);
    assert.equal(env.deps.bills.count(), 2, '重复文件不得二次入库');
  });
});

test('不同文件含同一笔交易：按交易单号去重', () => {
  withEnv((env) => {
    writeFileSync(join(env.dir, 'a.csv'), ALIPAY, 'utf8');
    scanInbox(env.deps, { dir: env.dir, now: () => NOW });

    const overlapping = `交易时间,交易分类,交易对方,商品说明,收/支,金额,交易订单号
2026-10-03 09:00:00,购物,某商城,新买的,支出,¥12.00,SN1003
2026-10-02 08:15:00,交通出行,地铁,地铁票,支出,¥5.00,SN1002
`;
    writeFileSync(join(env.dir, 'b.csv'), overlapping, 'utf8');
    const result = scanInbox(env.deps, { dir: env.dir, now: () => NOW });

    assert.equal(result.imported, 1);
    assert.equal(env.deps.bills.count(), 3, '只有新交易入库');
  });
});

test('压缩包不被吞掉：明确提示先解压，文件留在原地', () => {
  withEnv((env) => {
    writeFileSync(join(env.dir, '账单.zip'), 'PK\u0003\u0004fake', 'utf8');
    const result = scanInbox(env.deps, { dir: env.dir, now: () => NOW });

    assert.equal(result.skipped, 1);
    assert.match(result.results[0]?.reason ?? '', /解压/);
    assert.equal(existsSync(join(env.dir, '账单.zip')), true, '跳过时不应移走文件，方便用户先解压');
    assert.equal(env.deps.bills.count(), 0);
  });
});

test('不认识的文件类型：跳过并说明', () => {
  withEnv((env) => {
    writeFileSync(join(env.dir, 'notes.pdf'), 'x', 'utf8');
    writeFileSync(join(env.dir, 'inbox.log'), '', 'utf8'); // 自己的日志文件不算待处理
    const result = scanInbox(env.deps, { dir: env.dir, now: () => NOW });

    assert.equal(result.found, 1, 'inbox.log 不应被当成待处理文件');
    assert.equal(result.skipped, 1);
    assert.match(result.results[0]?.reason ?? '', /不支持/);
    assert.equal(listInboxFiles(env.dir).includes('inbox.log'), false);
  });
});

test('全行解析失败的文件归到 failed/', () => {
  withEnv((env) => {
    const broken = `交易时间,交易对方,收/支,金额,交易订单号
无日期,某店,支出,¥10.00,SN1
这里也没有日期,某店,支出,¥20.00,SN2
`;
    writeFileSync(join(env.dir, 'broken.csv'), broken, 'utf8');
    const result = scanInbox(env.deps, { dir: env.dir, now: () => NOW });

    assert.equal(result.failed, 1);
    assert.equal(result.imported, 0);
    assert.equal(existsSync(join(env.dir, 'broken.csv')), false);
    assert.equal(env.deps.bills.count(), 0);
  });
});

test('预览模式：不写库、不移动文件', () => {
  withEnv((env) => {
    writeFileSync(join(env.dir, 'a.csv'), ALIPAY, 'utf8');
    const result = scanInbox(env.deps, { dir: env.dir, dryRun: true, now: () => NOW });

    assert.equal(result.imported, 0);
    assert.equal(result.results[0]?.reason, '预览模式，未实际导入');
    assert.equal(existsSync(join(env.dir, 'a.csv')), true);
    assert.equal(env.deps.bills.count(), 0);
  });
});

test('关闭归档时文件留在原地（方便反复观察）', () => {
  withEnv((env) => {
    writeFileSync(join(env.dir, 'a.csv'), ALIPAY, 'utf8');
    scanInbox(env.deps, { dir: env.dir, archive: false, now: () => NOW });
    assert.equal(existsSync(join(env.dir, 'a.csv')), true);
    assert.equal(env.deps.bills.count(), 2);
  });
});

test('一次丢多个文件：按上限逐个处理', () => {
  withEnv((env) => {
    for (const name of ['a.csv', 'b.csv', 'c.csv']) {
      writeFileSync(
        join(env.dir, name),
        `交易时间,交易对方,收/支,金额,交易订单号\n2026-10-0${name.charCodeAt(0) - 96} 10:00:00,某店,支出,¥10.00,SN-${name}\n`,
        'utf8',
      );
    }
    const result = scanInbox(env.deps, { dir: env.dir, maxFiles: 2, now: () => NOW });
    assert.equal(result.found, 3);
    assert.equal(result.processed, 2);
    assert.equal(result.imported, 2);
    assert.equal(listInboxFiles(env.dir).length, 1, '超上限的文件留到下次');
  });
});

test('importedToday：有导入则 true；没有则看历史批次', () => {
  withEnv((env) => {
    assert.equal(hasImportedToday(env.deps, TZ, NOW.getTime()), false);

    writeFileSync(join(env.dir, 'a.csv'), ALIPAY, 'utf8');
    const result = scanInbox(env.deps, { dir: env.dir, now: () => NOW });
    assert.equal(result.importedToday, true);
    assert.equal(hasImportedToday(env.deps, TZ, NOW.getTime()), true);

    // 换成"第二天"，且当天没有任何导入 → false
    const nextDay = new Date('2026-10-04T21:05:00+08:00');
    assert.equal(hasImportedToday(env.deps, TZ, nextDay.getTime()), false);
  });
});

test('投递箱不存在时扫描不报错，并自动创建目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'billing-inbox-'));
  const missing = join(dir, 'nope', 'inbox');
  const db = openDatabase(':memory:');
  const deps: InboxDeps = {
    bills: createBillRepo(db),
    categories: createCategoryRepo(db),
    imports: createImportRepo(db),
    settings: () => settingsWith(),
  };
  const result = scanInbox(deps, { dir: missing, now: () => NOW });
  assert.equal(result.found, 0);
  assert.equal(result.failed, 0);
  assert.equal(existsSync(missing), true, '应自动创建目录，用户可以直接往里丢文件');
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

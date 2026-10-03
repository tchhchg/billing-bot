import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/infra/db/database.ts';
import { createBillRepo } from '../src/infra/db/billRepo.ts';
import { createCategoryRepo } from '../src/infra/db/categoryRepo.ts';
import { createImportRepo } from '../src/infra/db/importRepo.ts';
import { importBillFile, previewImport, type ImportDeps } from '../src/app/importBills.ts';
import { decodeBuffer, detectEncoding, parseCsv, tableFromCsv } from '../src/infra/importer/csv.ts';
import { detectSourceKind, defaultMappingFor, guessHeaderRow, parseAmountText, parseDirectionText } from '../src/infra/importer/mapping.ts';
import { normalizeBills } from '../src/domain/analysis/refund.ts';
import { UNLINKED_REFUND } from '../src/domain/analysis/refund.ts';
import { PRESET_CATEGORIES } from '../src/domain/category.ts';
import { makeConfig } from './helpers.ts';

const TZ = 'Asia/Shanghai';
const NOW = new Date('2026-10-04T09:00:00.000Z');

const ALIPAY_CSV = `支付宝交易流水明细
账号:test@example.com
起始时间:[2026-10-01 00:00:00]    终止时间:[2026-10-03 23:59:59]
导出时间:[2026-10-04 09:00:00]
----------------------
交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注
2026-10-01 12:30:45,餐饮美食,某某餐厅,abc,午餐,支出,¥38.00,余额宝,交易成功,SN1001,M001,
2026-10-02 08:15:00,交通出行,地铁,xyz,地铁票,支出,¥5.00,花呗,交易成功,SN1002,M002,
2026-10-02 09:00:00,转账,某某,---,转账,不计收支,¥200.00,余额,交易成功,SN1003,M003,
2026-10-03 20:00:00,退款,某某餐厅,abc,退款,收入,¥38.00,余额宝,退款成功,SN1004,M004,
2026-10-03 21:00:00,购物,某商城,qqq,耳机,支出,"¥1,299.00",信用卡,交易成功,SN1005,M005,
`;

const WECHAT_CSV = `\uFEFF微信支付账单明细,,,,,,,,
微信昵称：[张三],,,,,,,,
起始时间：[2026-10-01 00:00:00],,,,,,,,
终止时间：[2026-10-03 23:59:59],,,,,,,,
导出时间：[2026-10-04 09:00:00],,,,,,,,
交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
2026-10-01 19:00:00,商户消费,某某超市,日用品,支出,¥56.80,零钱,支付成功,SN2001,W001,
2026-10-02 12:00:00,转账,某某,转账,不计收支,¥100.00,零钱,已转账,SN2002,W002,
2026-10-03 15:00:00,退款,某某超市,退款,收入,¥56.80,零钱,已全额退款,SN2003,W003,
`;

const BANK_CSV = `交易日期,摘要,交易金额,借贷标志,交易流水号
2026-10-01,超市采购,120.50,借,SN3001
2026-10-02,工资,10000.00,贷,SN3002
`;

function deps(): { d: ImportDeps; close: () => void } {
  const db = openDatabase(':memory:');
  const d: ImportDeps = {
    bills: createBillRepo(db),
    categories: createCategoryRepo(db),
    imports: createImportRepo(db),
  };
  d.categories.seedPreset(PRESET_CATEGORIES, NOW.toISOString());
  return { d, close: () => db.close() };
}

function baseArgs(content: string, over: Record<string, unknown> = {}) {
  return {
    fileName: 'x.csv',
    content: Buffer.from(content, 'utf8'),
    baseCurrency: 'CNY',
    timeZone: TZ,
    analysis: { futureDateToleranceDays: 1 },
    now: NOW,
    ...over,
  };
}

// ---------------------------------------------------------------- CSV 解析
test('支付宝的长前导（20+ 行说明）也能定位真正的表头，不会整份文件被跳过', () => {
  const preamble = [
    '------------------------------------------------------------------------------------',
    '导出信息：',
    '姓名：某用户',
    '支付宝账户：13800000000',
    '起始时间：[2026-07-03 00:00:00]    终止时间：[2026-10-03 23:59:59]',
    '导出交易类型：[全部]',
    '导出时间：[2026-10-03 21:30:37]',
    '共171笔记录',
    '收入：2笔 59.38元',
    '支出：92笔 1421.36元',
    '不计收支：77笔 3332.78元',
    '',
    '特别提示：',
    '1.本回单内容可表明支付宝受理了相应支付交易申请；',
    '2.请勿将本回单作为收款方发货的凭据使用；',
    '3.请勿使用本回单进行重复记账；',
    '4.本回单如经任何涂改、编造，均立即失去效力；',
    '5.部分账单不计入为收入或者支出；',
    '6.明细金额直接累加后可能和统计金额不一致；',
    '7.禁止将本回单用于非法用途；',
    '8.本明细仅供个人对账使用。',
    '',
    '------------------------支付宝支付科技有限公司  电子客户回单------------------------',
  ];
  const csv = [
    ...preamble,
    '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
    '2026-10-01 12:30:45,餐饮美食,某某餐厅,abc,午餐,支出,¥38.00,余额宝,交易成功,SN9001,M001,',
    '2026-10-02 08:15:00,交通出行,地铁,xyz,地铁票,支出,¥5.00,花呗,交易成功,SN9002,M002,',
  ].join('\n');

  const { d, close } = deps();
  try {
    const report = importBillFile(d, baseArgs(csv, { fileName: 'alipay-long-preamble.csv' }));
    assert.equal(report.skippedCount, 0, '不该有任何行被跳过');
    assert.equal(report.okCount, 2, '两笔都应入账（修复前整份会被跳过）');
    // 真正要保证的是"认对了列、金额取对了"，而不是某个下标数字
    const imported = d.bills.query({ timeZone: TZ, limit: 10 });
    assert.deepEqual(
      imported.map((b) => b.merchant).sort(),
      ['地铁', '某某餐厅'],
    );
    assert.deepEqual(
      imported.map((b) => b.amountMinor).sort((a, b) => a - b),
      [500, 3800],
    );
  } finally {
    close();
  }
});

test('CSV 状态机：引号、逗号、换行、CRLF、双写引号', () => {
  const rows = parseCsv('a,b,c\r\n1,"x,y",3\n4,"he said ""hi""",6\n7,"multi\nline",9\n');
  assert.deepEqual(rows[0], ['a', 'b', 'c']);
  assert.deepEqual(rows[1], ['1', 'x,y', '3']);
  assert.deepEqual(rows[2], ['4', 'he said "hi"', '6']);
  assert.deepEqual(rows[3], ['7', 'multi\nline', '9']);
  assert.equal(parseCsv('a,b\n\n\nc,d\n').length, 2, '空行应被丢弃');
});

test('编码识别：BOM、UTF-8、非 UTF-8 回退 GB18030', () => {
  assert.equal(detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61])).encoding, 'utf-8');
  assert.equal(detectEncoding(Buffer.from([0xff, 0xfe, 0x61, 0x00])).encoding, 'utf-16le');
  assert.equal(detectEncoding(Buffer.from('交易时间', 'utf8')).encoding, 'utf-8');

  // GBK 编码的「你好」= C4 E3 BA C3（不是合法 UTF-8）
  const gbkHello = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
  assert.equal(detectEncoding(gbkHello).encoding, 'gb18030');
  const decoded = decodeBuffer(gbkHello);
  assert.equal(decoded.text, '你好');
  assert.equal(decoded.encoding, 'gb18030');
});

test('表头探测：跳过导出说明行', () => {
  const lines = ALIPAY_CSV.split('\n').map((l) => l.split(','));
  assert.equal(guessHeaderRow(lines), 5);
  const table = tableFromCsv(ALIPAY_CSV, 5);
  assert.equal(table.headers[0], '交易时间');
  assert.equal(table.preamble.length, 5);
  assert.equal(table.rows.length, 5);
});

test('来源识别与默认列映射', () => {
  const alipayTable = tableFromCsv(ALIPAY_CSV, 5);
  assert.equal(detectSourceKind(alipayTable.headers, ALIPAY_CSV), 'alipay');
  const mapping = defaultMappingFor('alipay', alipayTable.headers);
  assert.equal(mapping.columns['交易时间'], 'occurredAt');
  assert.equal(mapping.columns['金额'], 'amount');
  assert.equal(mapping.columns['收/支'], 'direction');
  assert.equal(mapping.columns['交易订单号'], 'sourceRef');

  const wechatTable = tableFromCsv(WECHAT_CSV, 5);
  assert.equal(detectSourceKind(wechatTable.headers, WECHAT_CSV), 'wechat');
  assert.equal(defaultMappingFor('wechat', wechatTable.headers).columns['金额(元)'], 'amount');
});

test('金额与收支方向解析', () => {
  assert.equal(parseAmountText('¥1,234.56'), 1234.56);
  assert.equal(parseAmountText(' 1234.56 元'), 1234.56);
  assert.equal(parseAmountText('-1,200'), -1200);
  assert.equal(parseAmountText('/'), null);
  assert.equal(parseAmountText(''), null);
  assert.equal(parseAmountText('abc'), null);

  assert.equal(parseDirectionText('支出'), 'expense');
  assert.equal(parseDirectionText('收入'), 'income');
  assert.equal(parseDirectionText('不计收支'), 'skip');
  assert.equal(parseDirectionText('/'), 'skip');
  assert.equal(parseDirectionText('借'), 'expense');
  assert.equal(parseDirectionText('贷'), 'income');
});

// ---------------------------------------------------------------- 支付宝
test('导入支付宝账单：跳过"不计收支"、识别退款、解析千分位金额', () => {
  const { d, close } = deps();
  const report = importBillFile(d, baseArgs(ALIPAY_CSV, { fileName: 'alipay.csv' }));

  assert.equal(report.sourceKind, 'alipay');
  assert.equal(report.headerRow, 5);
  assert.equal(report.encoding, 'utf-8');
  assert.equal(report.okCount, 4);
  assert.equal(report.skippedCount, 1);
  assert.equal(report.failedCount, 0);
  assert.equal(report.alreadyImported, false);

  const bills = d.bills.query({ timeZone: TZ, limit: 100 });
  assert.equal(bills.length, 4);

  const big = bills.find((b) => b.amountMinor === 129_900);
  assert.ok(big, '千分位金额应被正确解析');
  assert.equal(big?.merchant, '某商城');

  const refund = bills.find((b) => b.refundOf === UNLINKED_REFUND);
  assert.ok(refund, '退款应标记为未关联原单的退款');
  assert.equal(refund?.amountMinor, 3_800);
  assert.equal(refund?.direction, 'income');

  // 退款在口径 B 下冲减退款当日
  const attributed = normalizeBills(bills, makeConfig(), TZ);
  const net = attributed
    .filter((a) => a.localDate === '2026-10-03')
    .reduce((s, a) => s + a.sign * a.amountMinor, 0);
  assert.equal(net, 129_900 - 3_800);
  close();
});

test('导入是幂等的：同文件二次导入被拦截，行级单号也不会重复', () => {
  const { d, close } = deps();
  const first = importBillFile(d, baseArgs(ALIPAY_CSV, { fileName: 'alipay.csv' }));
  assert.equal(first.okCount, 4);

  const second = importBillFile(d, baseArgs(ALIPAY_CSV, { fileName: 'alipay.csv' }));
  assert.equal(second.alreadyImported, true);
  assert.equal(d.bills.count(), 4);

  // 不同文件（比如换了导出区间）但含同一笔交易 → 行级幂等
  const overlapping = `交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注
2026-10-01 12:30:45,餐饮美食,某某餐厅,abc,午餐,支出,¥38.00,余额宝,交易成功,SN1001,M001,
2026-10-04 10:00:00,购物,某商城,qqq,新买的东西,支出,¥12.00,余额,交易成功,SN1006,M009,
`;
  const third = importBillFile(d, baseArgs(overlapping, { fileName: 'alipay2.csv' }));
  assert.equal(third.alreadyImported, false);
  assert.equal(third.dupCount, 1, '相同交易单号只应计一次');
  assert.equal(third.okCount, 1, '只有新交易入库');
  assert.equal(d.bills.count(), 5);
  close();
});

test('导入报告能定位到具体行', () => {
  const csv = `交易时间,交易对方,收/支,金额,交易订单号
2026-10-01 10:00:00,某店,支出,¥10.00,SN9001
无日期,某店,支出,¥20.00,SN9002
2026-10-01 11:00:00,某店,支出,金额不详,SN9003
`;
  const { d, close } = deps();
  const report = importBillFile(d, baseArgs(csv, { headerRow: 0 }));
  assert.equal(report.okCount, 1);
  assert.equal(report.failedCount, 1);
  assert.equal(report.skippedCount, 1);
  const failed = report.rows.find((r) => r.status === 'failed');
  assert.match(failed?.reason ?? '', /交易时间无法解析|日期/);
  const skipped = report.rows.find((r) => r.status === 'skipped');
  assert.match(skipped?.reason ?? '', /金额无法识别/);
  close();
});

// ---------------------------------------------------------------- 微信
test('导入微信账单：BOM 与说明行，退款正确识别', () => {
  const { d, close } = deps();
  const report = importBillFile(d, baseArgs(WECHAT_CSV, { fileName: 'wechat.csv' }));
  assert.equal(report.sourceKind, 'wechat');
  assert.equal(report.okCount, 2);
  assert.equal(report.skippedCount, 1);
  assert.equal(report.failedCount, 0);

  const bills = d.bills.query({ timeZone: TZ, limit: 10 });
  assert.equal(bills.length, 2);
  assert.ok(bills.some((b) => b.amountMinor === 5_680 && b.direction === 'expense'));
  assert.ok(bills.some((b) => b.refundOf === UNLINKED_REFUND));
  close();
});

// ---------------------------------------------------------------- 银行
test('导入银行流水：借贷标志映射为收支，无方向列时默认支出', () => {
  const { d, close } = deps();
  const withFlag = importBillFile(d, baseArgs(BANK_CSV, { fileName: 'bank.csv' }));
  assert.equal(withFlag.failedCount, 0);
  assert.equal(withFlag.okCount, 2);
  const bills = d.bills.query({ timeZone: TZ, limit: 10 });
  assert.equal(bills.find((b) => b.amountMinor === 12_050)?.direction, 'expense');
  assert.equal(bills.find((b) => b.amountMinor === 1_000_000)?.direction, 'income');
  close();

  const noDirection = `交易日期,交易金额,交易摘要
2026-10-01,88.00,午饭
`;
  const { d: d2, close: close2 } = deps();
  const report = importBillFile(d2, baseArgs(noDirection, { fileName: 'bank2.csv' }));
  assert.equal(report.okCount, 1, '缺少收支列时不应全部跳过');
  assert.equal(d2.bills.query({ timeZone: TZ, limit: 5 })[0]?.direction, 'expense');
  close2();
});

// ---------------------------------------------------------------- 映射模板
test('自定义列映射与模板保存（未知银行格式的解法）', () => {
  const csv = `日期,说明,钱,进出
2026-10-01,午饭,12.50,出
2026-10-02,退款,12.50,入
`;
  const { d, close } = deps();
  const custom = {
    columns: { 日期: 'occurredAt', 说明: 'merchant', 钱: 'amount' },
    amountUnit: 'major' as const,
    headerRow: 0,
    skipPatterns: [],
  };
  const report = importBillFile(d, baseArgs(csv, { fileName: 'weird.csv', mapping: custom, sourceKind: 'bank' }));
  assert.equal(report.okCount, 2);
  assert.equal(report.sourceKind, 'bank');

  d.imports.saveMapping({ sourceKind: 'bank', name: '某银行', mapping: custom, now: NOW.toISOString() });
  assert.equal(d.imports.getMapping('bank', '某银行')?.columns['钱'], 'amount');
  close();
});

test('预演：只给表头、编码、样本行，不写库', () => {
  const { d, close } = deps();
  const preview = previewImport({ content: Buffer.from(ALIPAY_CSV, 'utf8'), baseCurrency: 'CNY' });
  assert.equal(preview.sourceKind, 'alipay');
  assert.equal(preview.headerRow, 5);
  assert.equal(preview.preamble.length, 5);
  assert.equal(preview.sampleRows.length, 5);
  assert.equal(d.bills.count(), 0, '预演不得写入数据库');
  close();
});

test('分类猜词：文件中带交易分类时映射到已存在的分类', () => {
  const { d, close } = deps();
  importBillFile(d, baseArgs(ALIPAY_CSV, { fileName: 'alipay.csv' }));
  const bills = d.bills.query({ timeZone: TZ, limit: 10 });
  // 预置分类名是「餐饮」，文件里是「餐饮美食」，没有精确命中时留空进入待补充
  const lunch = bills.find((b) => b.amountMinor === 3_800 && b.direction === 'expense');
  assert.equal(lunch?.categoryId, null);
  assert.equal(lunch?.status, 'pending_review');
  close();
});

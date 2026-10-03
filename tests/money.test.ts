import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertMinor,
  currencyDigits,
  formatMinor,
  fromMinor,
  isSafeMinor,
  isValidCurrency,
  sumMinor,
  toMinor,
} from '../src/domain/money.ts';

test('币种校验只接受三字母大写代码', () => {
  assert.equal(isValidCurrency('CNY'), true);
  assert.equal(isValidCurrency('USD'), true);
  assert.equal(isValidCurrency('rmb'), false);
  assert.equal(isValidCurrency('CN'), false);
});

test('货币小数位：人民币 2 位、日元 0 位、未知币种回退 2 位', () => {
  assert.equal(currencyDigits('CNY'), 2);
  assert.equal(currencyDigits('USD'), 2);
  assert.equal(currencyDigits('JPY'), 0);
  assert.equal(currencyDigits('KRW'), 0);
  assert.equal(currencyDigits('ZZZ'), 2);
});

test('主单位与最小单位互转（整数运算）', () => {
  assert.equal(toMinor(12.34, 'CNY'), 1234);
  assert.equal(toMinor(1200, 'JPY'), 1200);
  assert.equal(fromMinor(1234, 'CNY'), 12.34);
  assert.equal(fromMinor(1200, 'JPY'), 1200);
  // 0.1 + 0.2 类浮点误差不允许出现
  assert.equal(toMinor(0.1, 'CNY') + toMinor(0.2, 'CNY'), 30);
});

test('格式化按币种小数位输出', () => {
  assert.equal(formatMinor(123456, 'CNY', 'zh-CN').replace(/\s/g, ''), '¥1,234.56');
  assert.equal(formatMinor(1200, 'JPY', 'zh-CN').replace(/\s/g, ''), 'JP¥1,200');
});

test('汇率换算取整到最小单位', () => {
  assert.equal(convertMinor(10000, 7.1), 71000); // 100.00 USD → 710.00 CNY
  assert.equal(convertMinor(333, 7.1234), 2372); // 3.33 → 23.72
  assert.throws(() => convertMinor(100, 0), RangeError);
  assert.throws(() => convertMinor(100, Number.NaN), RangeError);
});

test('金额安全性与求和', () => {
  assert.equal(isSafeMinor(0), true);
  assert.equal(isSafeMinor(1.5), false);
  assert.equal(isSafeMinor(Number.MAX_SAFE_INTEGER + 2), false);
  assert.equal(sumMinor([]), 0);
  assert.equal(sumMinor([100, -30, 5]), 75);
});

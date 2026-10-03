/**
 * 金额工具：全程最小货币单位整数运算，**禁止浮点**。
 */

const CURRENCY_RE = /^[A-Z]{3}$/;

export function isValidCurrency(currency: string): boolean {
  return CURRENCY_RE.test(currency);
}

/** 货币小数位（人民币 2、日元 0……），未知币种回退 2 */
export function currencyDigits(currency: string): number {
  try {
    const nf = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    return nf.resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function isSafeMinor(value: number): boolean {
  return Number.isSafeInteger(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER;
}

/** 主单位 → 最小单位（仅用于导入解析等入口） */
export function toMinor(major: number, currency: string): number {
  const digits = currencyDigits(currency);
  const scaled = Math.round(major * 10 ** digits);
  if (!isSafeMinor(scaled)) throw new RangeError(`amount out of safe integer range: ${major} ${currency}`);
  return scaled;
}

export function fromMinor(minor: number, currency: string): number {
  return minor / 10 ** currencyDigits(currency);
}

export function formatMinor(minor: number, currency: string, locale = 'zh-CN'): string {
  const digits = currencyDigits(currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minor / 10 ** digits);
}

export function sumMinor(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  if (!isSafeMinor(total)) throw new RangeError('sum out of safe integer range');
  return total;
}

/** 两币种间换算：amount(quote) → base，四舍五入到最小单位 */
export function convertMinor(amountMinor: number, rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError(`invalid fx rate: ${rate}`);
  return Math.round(amountMinor * rate);
}

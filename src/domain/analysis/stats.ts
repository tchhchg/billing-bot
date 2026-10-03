/** 统计小工具：全部整数运算，中位数取整到最小货币单位。 */

export function meanMinor(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  return Math.round(total / values.length);
}

export function medianMinor(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

export function maxMinor(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.max(...values);
}

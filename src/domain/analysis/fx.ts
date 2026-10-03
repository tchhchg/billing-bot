/**
 * 多币种折算。
 *
 * 铁律：**缺少汇率时绝不给出跨币种合计。** 此时只能分币种分组展示，
 * convertedTotalMinor 返回 null，依赖单一总额的规则自动跳过。
 */
import type { AttributedAmount, MoneyConfig } from '../types.ts';
import { convertMinor, sumMinor } from '../money.ts';
import { isExpenseLike } from './refund.ts';

export interface FxLookup {
  /** 指定日期的汇率（quote → base）；该日无数据返回 null */
  onDate(rateDate: string, base: string, quote: string): number | null;
  /** 最近可用汇率（离线降级），返回汇率与其日期 */
  latest(base: string, quote: string): { rate: number; rateDate: string } | null;
}

export interface FxedAmount extends AttributedAmount {
  /** 折算到基础币种后的绝对值（方向仍由 sign 表达） */
  convertedMinor: number | null;
  fxMissing: boolean;
  rateUsed: number | null;
  rateDate: string | null;
  /** 使用的不是当日汇率（离线回退或按最新汇率策略） */
  rateIsFallback: boolean;
}

export interface FxResult {
  amounts: FxedAmount[];
  /** 分币种净额（原始最小单位，可能为负） */
  netTotalByCurrency: Record<string, number>;
  /** 全部条目均可折算时才有值；否则 null */
  convertedTotalMinor: number | null;
  fxMissingCount: number;
  fxMissingByCurrency: Record<string, number>;
  usedFallbackRate: boolean;
}

export function applyFx(
  amounts: readonly AttributedAmount[],
  money: MoneyConfig,
  lookup: FxLookup | undefined,
): FxResult {
  const base = money.baseCurrency;
  const netTotalByCurrency: Record<string, number> = {};
  const fxMissingByCurrency: Record<string, number> = {};
  let fxMissingCount = 0;
  let usedFallbackRate = false;

  const fxed: FxedAmount[] = amounts.map((amount) => {
    netTotalByCurrency[amount.currency] =
      (netTotalByCurrency[amount.currency] ?? 0) + amount.sign * amount.amountMinor;

    if (amount.currency === base) {
      return { ...amount, convertedMinor: amount.amountMinor, fxMissing: false, rateUsed: 1, rateDate: null, rateIsFallback: false };
    }

    if (!money.multiCurrency || !lookup) {
      fxMissingCount += 1;
      fxMissingByCurrency[amount.currency] =
        (fxMissingByCurrency[amount.currency] ?? 0) + amount.amountMinor;
      return { ...amount, convertedMinor: null, fxMissing: true, rateUsed: null, rateDate: null, rateIsFallback: false };
    }

    let rate: number | null = null;
    let rateDate: string | null = null;
    let fallback = false;

    if (money.fxPolicy === 'on_date') {
      rate = lookup.onDate(amount.localDate, base, amount.currency);
      rateDate = amount.localDate;
      if (rate === null) {
        const latest = lookup.latest(base, amount.currency);
        if (latest) {
          rate = latest.rate;
          rateDate = latest.rateDate;
          fallback = true;
        }
      }
    } else {
      const latest = lookup.latest(base, amount.currency);
      if (latest) {
        rate = latest.rate;
        rateDate = latest.rateDate;
        fallback = true;
      }
    }

    if (rate === null || rateDate === null) {
      fxMissingCount += 1;
      fxMissingByCurrency[amount.currency] =
        (fxMissingByCurrency[amount.currency] ?? 0) + amount.amountMinor;
      return { ...amount, convertedMinor: null, fxMissing: true, rateUsed: null, rateDate: null, rateIsFallback: false };
    }

    if (fallback) usedFallbackRate = true;
    return {
      ...amount,
      convertedMinor: convertMinor(amount.amountMinor, rate),
      fxMissing: false,
      rateUsed: rate,
      rateDate,
      rateIsFallback: fallback,
    };
  });

  const allConvertible = fxed.every((a) => a.convertedMinor !== null);
  const convertedTotalMinor = allConvertible
    ? sumMinor(fxed.filter(isExpenseLike).map((a) => (a.sign * (a.convertedMinor as number))))
    : null;

  return { amounts: fxed, netTotalByCurrency, convertedTotalMinor, fxMissingCount, fxMissingByCurrency, usedFallbackRate };
}

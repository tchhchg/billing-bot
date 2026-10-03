/**
 * 基线：近 7 日 / 近 28 日 / 同星期几。
 *
 * 口径说明：只有**存在账单的自然日**才计入样本（无账单日不参与，也不当作 0），
 * 避免“某天忘记记账”把基线整体拉低造成误报。
 * 样本不足时对应基线返回 null，规则自动降级（冷启动模式）。
 */
import type { AnalysisConfig, Baseline } from '../types.ts';
import { meanMinor } from './stats.ts';
import { previousDays, weekdayOf } from './period.ts';

export const P28_MIN_SAMPLES = 14;
export const SAME_WEEKDAY_MIN_SAMPLES = 3;

export function computeBaseline(
  dailyNet: Readonly<Record<string, number>>,
  date: string,
  cfg: AnalysisConfig,
): Baseline {
  const p28Dates = previousDays(date, 28);
  const p7Dates = p28Dates.slice(-7);
  const p56Dates = previousDays(date, 56);

  const present = (dates: readonly string[]): number[] =>
    dates.filter((d) => Object.hasOwn(dailyNet, d)).map((d) => dailyNet[d] as number);

  const p7Values = present(p7Dates);
  const p28Values = present(p28Dates);
  const sampleDays = p28Values.length;
  const coldStart = sampleDays < cfg.coldStartMinDays;

  const targetWeekday = weekdayOf(date);
  const sameWeekdayValues = p56Dates
    .filter((d) => weekdayOf(d) === targetWeekday && Object.hasOwn(dailyNet, d))
    .map((d) => dailyNet[d] as number);

  return {
    p7: p7Values.length >= cfg.coldStartMinDays ? meanMinor(p7Values) : null,
    p28: p28Values.length >= Math.max(cfg.coldStartMinDays, P28_MIN_SAMPLES) ? meanMinor(p28Values) : null,
    sameWeekday:
      sameWeekdayValues.length >= Math.max(cfg.coldStartMinDays, SAME_WEEKDAY_MIN_SAMPLES)
        ? meanMinor(sameWeekdayValues)
        : null,
    sampleDays,
    coldStart,
  };
}

/** 规则使用的“参照基线”：优先同星期几，其次近 7 日，最后近 28 日 */
export function referenceBaseline(baseline: Baseline, windows: readonly string[]): number | null {
  return referenceBaselineDetail(baseline, windows)?.value ?? null;
}

export type BaselineKind = 'same_weekday' | 'p7' | 'p28';

export interface BaselineReference {
  kind: BaselineKind;
  value: number;
}

/** 同 referenceBaseline，但把“用了哪条基线”一并返回，便于证据可追溯 */
export function referenceBaselineDetail(
  baseline: Baseline,
  windows: readonly string[],
): BaselineReference | null {
  if (windows.includes('same_weekday') && baseline.sameWeekday !== null) {
    return { kind: 'same_weekday', value: baseline.sameWeekday };
  }
  if (windows.includes('p7') && baseline.p7 !== null) {
    return { kind: 'p7', value: baseline.p7 };
  }
  if (windows.includes('p28') && baseline.p28 !== null) {
    return { kind: 'p28', value: baseline.p28 };
  }
  return null;
}

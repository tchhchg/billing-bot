/**
 * 建议节流与降噪：
 *  - 用户关闭的规则不再出现（R7 数据质量类允许关闭，但设置页会提示后果）
 *  - 被标记“不准”≥3 次的规则临时停用
 *  - 冷却期内的规则跳过
 *  - 每日总量封顶，warn 优先
 */
import type { Advice, FeedbackState } from '../types.ts';
import { SEVERITY_RANK } from '../rules/engine.ts';

export const INACCURATE_SUSPEND_THRESHOLD = 3;

export interface ThrottleOptions {
  localDate: string;
  maxDailyAdvice: number;
}

export function throttleAdvices(
  advices: readonly Advice[],
  feedback: FeedbackState | undefined,
  options: ThrottleOptions,
): Advice[] {
  const muted = new Set(feedback?.mutedRuleIds ?? []);
  const cooldown = feedback?.cooldownUntil ?? {};
  const inaccurate = feedback?.inaccurateCounts ?? {};

  const seen = new Set<string>();
  const filtered = advices.filter((a) => {
    if (muted.has(a.ruleId)) return false;
    const until = cooldown[a.ruleId];
    if (until && until > options.localDate) return false;
    if ((inaccurate[a.ruleId] ?? 0) >= INACCURATE_SUSPEND_THRESHOLD) return false;
    if (seen.has(a.ruleId)) return false;
    seen.add(a.ruleId);
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const rank = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (rank !== 0) return rank;
    return a.ruleId.localeCompare(b.ruleId);
  });

  const cap = Math.max(1, options.maxDailyAdvice);
  return sorted.slice(0, cap);
}

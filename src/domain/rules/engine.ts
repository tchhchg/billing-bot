/**
 * 规则引擎：纯函数，输入全是已算好的指标与历史，输出可追溯的建议。
 *
 * 设计约束：
 *  - 每条建议都携带 evidence（触发它的具体数字），用户点开能看到“为什么这么说”。
 *  - 数据不足以支撑结论时**宁可不出建议**（返回 null），也不猜。
 *  - 模型只允许润色文案，不允许在这里生成结论。
 */
import type {
  Advice,
  AdviceAction,
  AdviceSeverity,
  AttributedAmount,
  Baseline,
  BudgetProgress,
  Config,
  DayMetrics,
  FeedbackState,
} from '../types.ts';
import { referenceBaselineDetail } from '../analysis/baseline.ts';
import { addDays, daysBetween } from '../analysis/period.ts';
import { resolveThresholds, type RuleThresholds } from './ruleset.ts';

export interface EvaluateArgs {
  metrics: DayMetrics;
  baseline: Baseline;
  budgetProgress: BudgetProgress | null;
  cfg: Config;
  thresholds?: Partial<RuleThresholds>;
  feedback?: FeedbackState;
  /** key = categoryId，value = 按日期升序的占比序列（末位为当日） */
  categoryRatioHistory?: Record<string, number[]>;
  /** 归一化后的历史条目（订阅识别用） */
  history?: readonly AttributedAmount[];
  /** 分类名解析（仅用于文案，测试可注入） */
  categoryLabel?: (categoryId: string | null) => string;
}

const SEVERITY_RANK: Record<AdviceSeverity, number> = { warn: 3, notice: 2, info: 1 };

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function makeAdvice(args: {
  date: string;
  ruleId: string;
  severity: AdviceSeverity;
  title: string;
  evidence: Record<string, string | number | boolean | null>;
  suggestions: string[];
  confidence: number;
  actions?: AdviceAction[];
  disclaimerRequired?: boolean;
}): Advice {
  const defaultActions: AdviceAction[] = [
    { type: 'view_detail', label: '查看明细', payload: { date: args.date } },
    { type: 'snooze', label: '稍后提醒', payload: { days: 3 } },
    { type: 'mark_inaccurate', label: '不准' },
  ];
  return {
    adviceId: `adv_${args.date}_${args.ruleId}`,
    ruleId: args.ruleId,
    severity: args.severity,
    title: args.title,
    evidence: { date: args.date, ...args.evidence },
    suggestions: args.suggestions,
    confidence: args.confidence,
    actions: args.actions ?? defaultActions,
    disclaimerRequired: args.disclaimerRequired ?? false,
  };
}

// ---------------------------------------------------------------- R1
function ruleR1(a: EvaluateArgs, t: RuleThresholds): Advice | null {
  const { metrics, baseline, cfg } = a;
  const total = metrics.anomalyEligibleTotalMinor;
  if (total === null || total <= 0) return null;
  const reference = referenceBaselineDetail(baseline, cfg.analysis.baselineWindow);
  if (reference === null || reference.value <= 0) return null;
  const delta = total / reference.value - 1;
  if (delta <= t.r1Alpha) return null;
  const top = metrics.topCategories[0];
  const reason = `当日（剔除固定支出）支出 ${total}，${reference.kind} 基线 ${reference.value}`;
  return makeAdvice({
    date: metrics.localDate,
    ruleId: 'R1',
    severity: 'warn',
    title: '今日支出高于你的近期平均水平',
    evidence: {
      eligibleTotalMinor: total,
      baselineMinor: reference.value,
      baselineKind: reference.kind,
      deltaRatio: round3(delta),
      threshold: t.r1Alpha,
      topCategory: top ? a.categoryLabel?.(top.categoryId) ?? top.categoryId : null,
      topCategoryMinor: top ? top.amountMinor : 0,
      billCount: metrics.expenseCount,
      reason,
    },
    suggestions: [
      top
        ? `占比最高的是「${a.categoryLabel?.(top.categoryId) ?? top.categoryId}」${top.amountMinor}（最小货币单位），可优先看这里`
        : '可在明细里按分类查看主要支出方向',
    ],
    confidence: 0.82,
    disclaimerRequired: true,
  });
}

// ---------------------------------------------------------------- R2
function ruleR2(a: EvaluateArgs, t: RuleThresholds): Advice | null {
  const { metrics, categoryRatioHistory } = a;
  if (!categoryRatioHistory) return null;
  let best: { categoryId: string; series: number[] } | null = null;
  for (const [categoryId, series] of Object.entries(categoryRatioHistory)) {
    if (series.length < t.r2RisingDays) continue;
    const tail = series.slice(-t.r2RisingDays);
    const strictlyRising = tail.every((v, i) => i === 0 || v > (tail[i - 1] as number));
    const last = tail[tail.length - 1] as number;
    if (strictlyRising && last > t.r2MinRatio) {
      if (!best || last > (best.series[best.series.length - 1] as number)) {
        best = { categoryId, series: tail };
      }
    }
  }
  if (!best) return null;
  const label = a.categoryLabel?.(best.categoryId) ?? best.categoryId;
  return makeAdvice({
    date: metrics.localDate,
    ruleId: 'R2',
    severity: 'notice',
    title: `「${label}」占比连续 ${t.r2RisingDays} 天上升`,
    evidence: {
      categoryId: best.categoryId,
      categoryLabel: label,
      ratioSeries: best.series.map(round3).join(' → '),
      lastRatio: round3(best.series[best.series.length - 1] as number),
      threshold: t.r2MinRatio,
    },
    suggestions: [`近期「${label}」的支出占比在持续上升，可留意是否属于一次性消费`],
    confidence: 0.7,
  });
}

// ---------------------------------------------------------------- R3
function ruleR3(a: EvaluateArgs, t: RuleThresholds): Advice | null {
  const { metrics, budgetProgress } = a;
  if (!budgetProgress) return null;
  if (budgetProgress.ratio < t.r3BudgetRatio) return null;
  const pct = Math.round(budgetProgress.ratio * 100);
  return makeAdvice({
    date: metrics.localDate,
    ruleId: 'R3',
    severity: 'warn',
    title: `本期预算已使用 ${pct}%`,
    evidence: {
      periodStart: budgetProgress.periodStart,
      periodEnd: budgetProgress.periodEnd,
      spentMinor: budgetProgress.spentMinor,
      limitMinor: budgetProgress.limitMinor,
      ratio: round3(budgetProgress.ratio),
      remainingMinor: budgetProgress.remainingMinor,
      daysLeft: budgetProgress.daysLeft,
      dailyAllowanceMinor: budgetProgress.dailyAllowanceMinor,
      threshold: t.r3BudgetRatio,
    },
    suggestions: [
      budgetProgress.remainingMinor > 0
        ? `剩余 ${budgetProgress.remainingMinor}（最小货币单位），含今天还有 ${budgetProgress.daysLeft} 天，日均可用约 ${budgetProgress.dailyAllowanceMinor}`
        : '本期预算已用尽',
    ],
    confidence: 0.95,
    actions: [
      { type: 'open_budget', label: '查看预算' },
      { type: 'view_detail', label: '查看明细', payload: { date: metrics.localDate } },
      { type: 'mark_inaccurate', label: '不准' },
    ],
    disclaimerRequired: true,
  });
}

// ---------------------------------------------------------------- R4
function ruleR4(a: EvaluateArgs, t: RuleThresholds): Advice | null {
  const { metrics, history } = a;
  if (!history || history.length === 0) return null;
  const cutoff = addDays(metrics.localDate, -t.r4LookbackDays);
  const charges = history.filter(
    (x) => x.kind === 'expense' && !x.isFixedExpense && x.merchant !== null && x.localDate >= cutoff,
  );
  if (charges.length === 0) return null;

  const groups = new Map<string, AttributedAmount[]>();
  for (const c of charges) {
    const key = `${c.merchant}|${c.currency}`;
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }

  let best: { merchant: string; count: number; amount: number; avgGap: number; currency: string } | null = null;

  for (const list of groups.values()) {
    if (list.length < t.r4MinOccurrences) continue;
    const sorted = [...list].sort((x, y) => x.localDate.localeCompare(y.localDate));
    const amounts = sorted.map((x) => x.amountMinor).sort((x, y) => x - y);
    const mid = Math.floor(amounts.length / 2);
    const median =
      amounts.length % 2 === 1
        ? (amounts[mid] as number)
        : Math.round(((amounts[mid - 1] as number) + (amounts[mid] as number)) / 2);
    const similar = sorted.filter(
      (x) => median > 0 && Math.abs(x.amountMinor - median) <= median * t.r4AmountTolerance,
    );
    if (similar.length < t.r4MinOccurrences) continue;

    const gaps: number[] = [];
    for (let i = 1; i < similar.length; i += 1) {
      gaps.push(daysBetween((similar[i - 1] as AttributedAmount).localDate, (similar[i] as AttributedAmount).localDate));
    }
    if (gaps.length === 0) continue;
    const monthly = gaps.filter((g) => g >= t.r4MinGapDays && g <= t.r4MaxGapDays);
    if (monthly.length / gaps.length < 0.5) continue;

    const avgGap = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
    if (
      !best ||
      similar.length > best.count ||
      (similar.length === best.count && median > best.amount)
    ) {
      best = {
        merchant: (similar[0] as AttributedAmount).merchant ?? '',
        count: similar.length,
        amount: median,
        avgGap,
        currency: (similar[0] as AttributedAmount).currency,
      };
    }
  }

  if (!best) return null;
  return makeAdvice({
    date: metrics.localDate,
    ruleId: 'R4',
    severity: 'info',
    title: '发现疑似订阅扣费',
    evidence: {
      merchant: best.merchant,
      occurrences: best.count,
      amountMinor: best.amount,
      currency: best.currency,
      avgGapDays: best.avgGap,
      lookbackDays: t.r4LookbackDays,
    },
    suggestions: [`发现 ${best.count} 次近似金额扣费，间隔约 ${best.avgGap} 天，可核对是否为自动续费（商户见明细）`],
    confidence: 0.66,
  });
}

// ---------------------------------------------------------------- R5
function ruleR5(a: EvaluateArgs, t: RuleThresholds): Advice | null {
  const { metrics } = a;
  if (metrics.expenses.length === 0) return null;
  const groups = new Map<string, number>();
  for (const e of metrics.expenses) {
    if (e.merchant === null) continue;
    const key = `${e.merchant}|${e.originalMinor}|${e.currency}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  let hit: { key: string; count: number } | null = null;
  for (const [key, count] of groups.entries()) {
    if (count >= t.r5MinCount && (!hit || count > hit.count)) hit = { key, count };
  }
  if (!hit) return null;
  const [merchant, amount, currency] = hit.key.split('|');
  return makeAdvice({
    date: metrics.localDate,
    ruleId: 'R5',
    severity: 'notice',
    title: '疑似重复记账',
    evidence: { merchant: merchant ?? '', amountMinor: Number(amount), currency: currency ?? '', occurrences: hit.count },
    suggestions: [`同一天出现 ${hit.count} 笔相同金额的记录，确认一下是否重复（商户见明细）`],
    confidence: 0.6,
  });
}

// ---------------------------------------------------------------- R6
function ruleR6(a: EvaluateArgs, t: RuleThresholds): Advice | null {
  const { metrics, baseline, cfg } = a;
  const max = metrics.maxNonFixedExpenseMinor;
  if (max === null) return null;
  const reference = referenceBaselineDetail(baseline, cfg.analysis.baselineWindow);
  const overMultiplier = reference !== null && reference.value > 0 && max > reference.value * t.r6Multiplier;
  const overAbsolute = max > t.r6AbsoluteMinor;
  if (!overMultiplier && !overAbsolute) return null;
  const culprit = metrics.expenses
    .filter((e) => e.valueMinor !== null && !e.isFixedExpense)
    .sort((x, y) => (y.valueMinor as number) - (x.valueMinor as number))[0];
  return makeAdvice({
    date: metrics.localDate,
    ruleId: 'R6',
    severity: 'notice',
    title: '今日出现较大单笔支出',
    evidence: {
      amountMinor: max,
      thresholdMinor: overMultiplier && reference ? Math.round(reference.value * t.r6Multiplier) : t.r6AbsoluteMinor,
      matchedBy: overMultiplier ? 'baseline_multiplier' : 'absolute',
      baselineMinor: reference?.value ?? null,
      merchant: culprit?.merchant ?? null,
      category: a.categoryLabel?.(culprit?.categoryId ?? null) ?? null,
    },
    suggestions: ['确认这笔支出的金额与分类是否正确'],
    confidence: 0.72,
  });
}

// ---------------------------------------------------------------- R7
function ruleR7(a: EvaluateArgs, t: RuleThresholds): Advice | null {
  const { metrics } = a;
  if (metrics.pendingReviewCount < t.r7PendingMin) return null;
  return makeAdvice({
    date: metrics.localDate,
    ruleId: 'R7',
    severity: 'info',
    title: `有 ${metrics.pendingReviewCount} 笔账单待补充信息`,
    evidence: {
      pendingReviewCount: metrics.pendingReviewCount,
      uncategorizedMinor: metrics.uncategorizedMinor,
      threshold: t.r7PendingMin,
    },
    suggestions: ['补齐分类后，支出结构分析会更准确'],
    confidence: 1,
    actions: [
      { type: 'record_added', label: '去补分类' },
      { type: 'snooze', label: '稍后提醒', payload: { days: 3 } },
      { type: 'mark_inaccurate', label: '不准' },
    ],
  });
}

// ---------------------------------------------------------------- R9
function ruleR9(a: EvaluateArgs, t: RuleThresholds): Advice | null {
  const { metrics } = a;
  const known = metrics.expenses.filter((e) => e.valueMinor !== null && !e.isFixedExpense);
  if (known.length === 0) return null;
  const small = known.filter((e) => (e.valueMinor as number) < t.r9SmallAmountMinor);
  if (small.length < t.r9MinCount) return null;
  const share = small.length / known.length;
  if (share < t.r9MinShare) return null;
  const total = small.reduce((s, e) => s + (e.valueMinor as number), 0);
  return makeAdvice({
    date: metrics.localDate,
    ruleId: 'R9',
    severity: 'info',
    title: '小额高频支出偏多',
    evidence: {
      smallCount: small.length,
      smallTotalMinor: total,
      expenseCount: known.length,
      share: round3(share),
      smallThresholdMinor: t.r9SmallAmountMinor,
    },
    suggestions: [`${small.length} 笔小额支出合计 ${total}（最小货币单位），单笔不起眼但累计可观`],
    confidence: 0.64,
  });
}

/** R8 由用例层在“当日零账单”时单独触发 */
export function noDataAdvice(localDate: string): Advice {
  return makeAdvice({
    date: localDate,
    ruleId: 'R8',
    severity: 'info',
    title: '今天还没有记录',
    evidence: { billCount: 0 },
    suggestions: ['今天没有账单记录，是否补记一笔？'],
    confidence: 1,
    actions: [
      { type: 'record_added', label: '补记一笔' },
      { type: 'snooze', label: '今天不再提醒', payload: { days: 1 } },
    ],
  });
}

export function evaluateRules(args: EvaluateArgs): Advice[] {
  const t = resolveThresholds(args.thresholds);
  const rules = [ruleR1, ruleR2, ruleR3, ruleR4, ruleR5, ruleR6, ruleR7, ruleR9];
  const out: Advice[] = [];
  for (const rule of rules) {
    const advice = rule(args, t);
    if (advice) out.push(advice);
  }
  return out;
}

export { SEVERITY_RANK };

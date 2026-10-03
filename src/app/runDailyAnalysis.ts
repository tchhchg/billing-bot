/**
 * 每日分析用例（P3 主线）。
 *
 * 幂等：run_key = localDate : RULESET_VERSION : CONFIG_VERSION
 *  - 同一 key 已成功推送过、且推送后账单没变 → 直接跳过（防止重复轰炸）
 *  - 推送后账单变了 → 重算并发"修正版"（revision+1），而不是重复发一条
 *  - 用户改了配置 → CONFIG_VERSION 变化 → 允许当日重算一次
 *  - 某日无账单 → 不生成"0 元=省钱"结论，只发"是否补记"或静默
 */
import type { Advice, AttributedAmount, DayMetrics, MoneyConfig } from '../domain/types.ts';
import { addDays, eachDate, localDateOf, previousDays, todayLocal } from '../domain/analysis/period.ts';
import { normalizeBills } from '../domain/analysis/refund.ts';
import { anomalyEligibleByDate, computeMetrics, netByDate } from '../domain/analysis/metrics.ts';
import { computeBaseline } from '../domain/analysis/baseline.ts';
import { budgetPeriodRange, computeBudgetProgress } from '../domain/analysis/budget.ts';
import { evaluateRules, noDataAdvice } from '../domain/rules/engine.ts';
import { throttleAdvices } from '../domain/advice/throttle.ts';
import { renderDailyCard, type RenderedCard } from '../domain/advice/render.ts';
import { categoryName, type Category } from '../domain/category.ts';
import { pickAdapters, tryChannelsInOrder, type ChannelAdapter, type SendResult } from '../channels/adapter.ts';
import type { BillRepo } from '../infra/db/billRepo.ts';
import type { CategoryRepo } from '../infra/db/categoryRepo.ts';
import type { FeedbackRepo } from '../infra/db/feedbackRepo.ts';
import type { FxRepo } from '../infra/db/fxRepo.ts';
import type { RunRepo } from '../infra/db/runRepo.ts';
import { runKeyOf, type AppSettings } from './settings.ts';

export const BASELINE_LOOKBACK_DAYS = 56;
export const CATEGORY_HISTORY_DAYS = 7;

export interface DailyDeps {
  bills: BillRepo;
  categories: CategoryRepo;
  runs: RunRepo;
  feedback: FeedbackRepo;
  fx: FxRepo;
  channels: readonly ChannelAdapter[];
  now?: () => Date;
  log?: (message: string) => void;
}

export type RunStatus = 'pushed' | 'revised' | 'skipped_already_run' | 'skipped_no_data' | 'failed';

export interface RunDailyOutcome {
  status: RunStatus;
  localDate: string;
  runKey: string;
  metrics?: DayMetrics;
  advices?: Advice[];
  card?: RenderedCard;
  results?: SendResult[];
  note?: string;
}

export interface RunDailyOptions {
  /** 指定日期（补跑用）；默认用户时区的"今天" */
  date?: string;
  /** 忽略幂等，强制重算（设置页"立即重算"按钮） */
  force?: boolean;
  /** 修正版的最小间隔判断：传入现有 run 的推送时间由内部读取 */
  dryRun?: boolean;
  /**
   * 追加到卡片摘要里的行。
   * 用例层用它加"今天还没导账单"之类的提醒——领域层不认识 inbox，也不需要认识。
   */
  extraSummaryLines?: readonly string[];
}

function appendExtraLines(card: RenderedCard, extra?: readonly string[]): RenderedCard {
  if (!extra || extra.length === 0) return card;
  return { ...card, summaryLines: [...card.summaryLines, ...extra] };
}

/** 每个分类在这些天里的占比序列（末位为当天），供 R2 使用 */
export function categoryRatioHistory(args: {
  dates: readonly string[];
  attributed: readonly AttributedAmount[];
  money: MoneyConfig;
  lookup: ReturnType<FxRepo['lookup']>;
  categoryIds: readonly string[];
}): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const id of args.categoryIds) out[id] = [];
  for (const date of args.dates) {
    const metrics = computeMetrics({
      localDate: date,
      attributed: args.attributed,
      money: args.money,
      lookup: args.lookup,
    });
    const positive = Object.values(metrics.categoryTotals).filter((v) => v > 0);
    const total = positive.reduce((s, v) => s + v, 0);
    for (const id of args.categoryIds) {
      const value = metrics.categoryTotals[id] ?? 0;
      out[id]?.push(total > 0 ? value / total : 0);
    }
  }
  return out;
}

function labelsFor(categories: readonly Category[]): (id: string | null) => string {
  return (id) => categoryName(categories, id);
}

export async function runDailyAnalysis(
  deps: DailyDeps,
  settings: AppSettings,
  options: RunDailyOptions = {},
): Promise<RunDailyOutcome> {
  const now = deps.now ?? ((): Date => new Date());
  const tz = settings.push.timezone;
  const localDate = options.date ?? todayLocal(tz, now().getTime());
  const runKey = runKeyOf(localDate, settings);
  const nowIso = now().toISOString();
  const log = deps.log ?? ((): void => {});

  const existing = deps.runs.get(runKey);
  const budgetPeriod = budgetPeriodRange(settings.budget, localDate);
  const lookback = addDays(localDate, -BASELINE_LOOKBACK_DAYS);
  const from = budgetPeriod.start < lookback ? budgetPeriod.start : lookback;
  const windowBills = deps.bills.listByLocalRange(from, localDate, tz);
  const dayBills = windowBills.filter((b) => localDateOf(b.occurredAt, tz) === localDate);

  // ---------------------------------------------------------- 幂等判断
  if (existing && existing.pushedAt && !options.force) {
    const pushedMs = Date.parse(existing.pushedAt);
    const maxUpdated = dayBills.reduce((max, b) => Math.max(max, Date.parse(b.updatedAt)), 0);
    if (maxUpdated <= pushedMs) {
      return { status: 'skipped_already_run', localDate, runKey, note: '该日已推送且数据未变化' };
    }
  }

  const revision = existing ? existing.revision + 1 : 1;
  const categoryList = deps.categories.list();

  // ---------------------------------------------------------- 无数据日
  if (dayBills.length === 0) {
    if (!settings.push.noDataNotice) {
      if (!options.dryRun) {
        deps.runs.save({
          runKey,
          localDate,
          metricsJson: JSON.stringify({ localDate, empty: true }),
          advicesJson: JSON.stringify([]),
          revision,
        });
      }
      return { status: 'skipped_no_data', localDate, runKey, note: '当日无账单，且已配置静默' };
    }
    const advice = noDataAdvice(localDate);
    const metrics = computeMetrics({
      localDate,
      attributed: [],
      money: settings.money,
      lookup: deps.fx.lookup(),
    });
    const card = appendExtraLines(
      renderDailyCard({ metrics, advices: [advice], options: { categories: categoryList } }),
      options.extraSummaryLines,
    );
    const adapters = pickAdapters(settings.push.channels, deps.channels);
    const results = options.dryRun
      ? []
      : await tryChannelsInOrder(adapters, { localDate, card, adviceIds: [advice.adviceId], revision });
    const okOne = results.find((r) => r.ok);
    if (!options.dryRun) {
      deps.runs.save({
        runKey,
        localDate,
        metricsJson: JSON.stringify(metrics),
        advicesJson: JSON.stringify([advice]),
        revision,
      });
      deps.runs.markPushed({
        runKey,
        at: nowIso,
        channel: okOne?.channel ?? 'none',
        status: okOne ? 'pushed' : 'failed',
        revision,
      });
    }
    log(`[daily] ${localDate} 无账单记录，已${okOne ? '推送补记提示' : '仅保留本地'}`);
    return {
      status: 'pushed',
      localDate,
      runKey,
      metrics,
      advices: [advice],
      card,
      results,
      note: options.dryRun ? 'dry-run，未推送' : '无数据日提示',
    };
  }

  // ---------------------------------------------------------- 口径与指标
  const attributed = normalizeBills(windowBills, settings.domain, tz);
  const lookup = deps.fx.lookup();
  const metrics = computeMetrics({ localDate, attributed, money: settings.money, lookup });

  const seriesDates = previousDays(localDate, BASELINE_LOOKBACK_DAYS);
  const anomalySeries = anomalyEligibleByDate({ dates: seriesDates, attributed, money: settings.money, lookup });
  const baseline = computeBaseline(anomalySeries, localDate, settings.domain.analysis);

  const periodDates = eachDate(budgetPeriod.start, localDate);
  const periodSeries = netByDate({ dates: periodDates, attributed, money: settings.money, lookup });
  const spentMinor = Object.values(periodSeries).reduce((s, v) => s + v, 0);
  const budgetProgress = computeBudgetProgress({ cfg: settings.budget, date: localDate, spentMinor });

  const ratioDates = previousDays(localDate, CATEGORY_HISTORY_DAYS - 1).concat(localDate);
  const categoryIds = Object.keys(metrics.categoryTotals);
  const ratioHistory = categoryRatioHistory({
    dates: ratioDates,
    attributed,
    money: settings.money,
    lookup,
    categoryIds,
  });

  const feedbackState = deps.feedback.state();
  const rawAdvices = evaluateRules({
    metrics,
    baseline,
    budgetProgress,
    cfg: settings.domain,
    feedback: feedbackState,
    categoryRatioHistory: ratioHistory,
    history: attributed,
    categoryLabel: labelsFor(categoryList),
  });
  const advices = throttleAdvices(rawAdvices, feedbackState, {
    localDate,
    maxDailyAdvice: settings.push.maxDailyAdvice,
  });

  const card = appendExtraLines(
    renderDailyCard({ metrics, advices, options: { categories: categoryList, includeMerchant: false } }),
    options.extraSummaryLines,
  );

  // ---------------------------------------------------------- 推送
  const adapters = pickAdapters(settings.push.channels, deps.channels);
  const results = options.dryRun
    ? []
    : await tryChannelsInOrder(adapters, {
        localDate,
        card,
        adviceIds: advices.map((a) => a.adviceId),
        revision,
      });

  const okOne = results.find((r) => r.ok);
  if (!options.dryRun) {
    deps.runs.save({
      runKey,
      localDate,
      metricsJson: JSON.stringify(metrics),
      advicesJson: JSON.stringify(advices),
      revision,
    });
    deps.runs.markPushed({
      runKey,
      at: nowIso,
      channel: okOne?.channel ?? 'none',
      status: okOne ? 'pushed' : 'failed',
      revision,
    });
  }

  const status: RunStatus = options.dryRun ? 'pushed' : okOne ? (revision > 1 ? 'revised' : 'pushed') : 'failed';
  log(
    `[daily] ${localDate} 建议 ${advices.length} 条，通道 ${okOne?.channel ?? '无'}，状态 ${status}` +
      (metrics.fxMissingCount > 0 ? `（${metrics.fxMissingCount} 笔缺汇率未计入合计）` : ''),
  );

  return { status, localDate, runKey, metrics, advices, card, results, note: options.dryRun ? 'dry-run，未推送' : undefined };
}

/**
 * 休眠/关机补跑：把错过的日子补上，但最多只回补 maxDays 天。
 * 更早的日子只写一条汇总提示，避免开机后一次刷屏。
 */
export async function catchUp(
  deps: DailyDeps,
  settings: AppSettings,
  args: { maxDays?: number } = {},
): Promise<RunDailyOutcome[]> {
  const maxDays = args.maxDays ?? 1;
  const now = deps.now ?? ((): Date => new Date());
  const tz = settings.push.timezone;
  const today = todayLocal(tz, now().getTime());
  const outcomes: RunDailyOutcome[] = [];
  for (let i = maxDays; i >= 1; i -= 1) {
    const date = addDays(today, -i);
    outcomes.push(await runDailyAnalysis(deps, settings, { date }));
  }
  return outcomes;
}

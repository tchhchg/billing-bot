/**
 * 卡片渲染（本地模板）。
 *
 * 隐私：卡片会经过 IM 服务端，因此默认**不下发商户名与备注**（includeMerchant 开关）。
 * 云端模型关闭时直接用这里的模板，功能不降级。
 */
import type { Advice, DayMetrics } from '../types.ts';
import { formatMinor } from '../money.ts';
import { categoryName, type Category } from '../category.ts';

export const DISCLAIMER_TEXT = '以上为基于你记录数据的统计提示，仅供参考，不构成投资、理财或借贷建议。';

export interface RenderOptions {
  categories?: readonly Category[];
  locale?: string;
  /** 是否允许卡片出现商户名（默认 false，保护隐私） */
  includeMerchant?: boolean;
}

export interface RenderedCard {
  title: string;
  summaryLines: string[];
  categoryLines: string[];
  adviceLines: string[];
  disclaimers: string[];
  /** 结构化建议原文，供本地 UI 使用（本地 UI 不受隐私开关限制） */
  advices: Advice[];
}

const SEVERITY_ICON: Record<Advice['severity'], string> = { warn: '⚠️', notice: '🔎', info: 'ℹ️' };

/** 证据行的键白名单：商户名只在允许时输出 */
const EVIDENCE_KEYS = [
  'baselineMinor',
  'baselineKind',
  'deltaRatio',
  'eligibleTotalMinor',
  'ratio',
  'remainingMinor',
  'daysLeft',
  'dailyAllowanceMinor',
  'occurrences',
  'amountMinor',
  'avgGapDays',
  'smallCount',
  'smallTotalMinor',
  'pendingReviewCount',
  'categoryLabel',
] as const;

function formatEvidenceLine(advice: Advice, options: RenderOptions): string | null {
  const parts: string[] = [];
  for (const key of EVIDENCE_KEYS) {
    const value = advice.evidence[key];
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${String(value)}`);
  }
  if (options.includeMerchant) {
    const merchant = advice.evidence['merchant'];
    if (merchant !== undefined && merchant !== null) parts.push(`merchant=${String(merchant)}`);
  }
  return parts.length > 0 ? `证据：${parts.join(', ')}` : null;
}

/** 真正发往 IM 通道的文本集合（结构化建议仅供本地 UI，不在其中） */
export function cardDisplayText(card: RenderedCard): string {
  return [card.title, ...card.summaryLines, ...card.categoryLines, ...card.adviceLines, ...card.disclaimers].join('\n');
}

export function renderDailyCard(args: {
  metrics: DayMetrics;
  advices: readonly Advice[];
  options?: RenderOptions;
}): RenderedCard {
  const { metrics, advices } = args;
  const options = args.options ?? {};
  const locale = options.locale ?? 'zh-CN';
  const base = metrics.baseCurrency;

  const summaryLines: string[] = [];

  if (metrics.netConvertedTotalMinor !== null) {
    const total = metrics.netConvertedTotalMinor;
    summaryLines.push(
      metrics.negativeNet
        ? `今日净支出为负（退款冲减）：${formatMinor(total, base, locale)}`
        : `今日净支出 ${formatMinor(total, base, locale)}`,
    );
  } else {
    const entries = Object.entries(metrics.netTotalByCurrency);
    if (entries.length === 0) summaryLines.push('今日无支出记录');
    for (const [currency, amount] of entries) {
      const prefix = amount < 0 ? '净额为负（退款冲减）' : '净支出';
      summaryLines.push(`${currency} ${prefix} ${formatMinor(amount, currency, locale)}`);
    }
  }

  summaryLines.push(`共 ${metrics.expenseCount} 笔支出${metrics.refundCount > 0 ? `、${metrics.refundCount} 笔退款` : ''}`);

  if (metrics.fxMissingCount > 0) {
    const detail = Object.entries(metrics.fxMissingByCurrency)
      .map(([currency, amount]) => `${currency} ${amount}`)
      .join('、');
    summaryLines.push(`有 ${metrics.fxMissingCount} 笔缺少汇率未计入合计（${detail}）`);
  }
  if (metrics.pendingReviewCount > 0) {
    summaryLines.push(`有 ${metrics.pendingReviewCount} 笔待补充分类`);
  }

  const categoryLines = metrics.topCategories
    .slice(0, 3)
    .map(
      (slice) =>
        `${categoryName(options.categories ?? [], slice.categoryId)} ${formatMinor(
          slice.amountMinor,
          metrics.categoryBreakdownCurrency ?? base,
          locale,
        )}（${Math.round(slice.ratio * 100)}%）`,
    );

  const adviceLines: string[] = [];
  const disclaimers: string[] = [];
  for (const advice of advices) {
    adviceLines.push(`${SEVERITY_ICON[advice.severity]} ${advice.title}`);
    const first = advice.suggestions[0];
    if (first) adviceLines.push(`　${first}`);
    const evidenceLine = formatEvidenceLine(advice, options);
    if (evidenceLine) adviceLines.push(`　${evidenceLine}`);
    if (advice.disclaimerRequired && !disclaimers.includes(DISCLAIMER_TEXT)) {
      disclaimers.push(DISCLAIMER_TEXT);
    }
  }

  return {
    title: `今日支出 · ${metrics.localDate}`,
    summaryLines,
    categoryLines,
    adviceLines,
    disclaimers,
    advices: [...advices],
  };
}

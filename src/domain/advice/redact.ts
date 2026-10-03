/** 云端模型的脱敏载荷（出网白名单）。 */
import type { Advice, DayMetrics } from '../types.ts';
import { fromMinor } from '../money.ts';

/** 绝对禁止出现在出网载荷里的字段名 */
export const FORBIDDEN_LLM_KEYS: readonly string[] = [
  'merchant',
  'note',
  'accountid',
  'billid',
  'sourceref',
  'expenses',
  'items',
  'originalminor',
  'valueminor',
  'paymentmethod',
  'tags',
];

export interface LlmRedactedPayload {
  locale: string;
  baseCurrency: string;
  /** 命中的规则模板 id */
  templateIds: string[];
  /** 只允许分类名 */
  categories: string[];
  /** 只允许金额档位，绝不含精确金额 */
  amountBuckets: string[];
  adviceCount: number;
}

const BUCKET_EDGES_MAJOR: readonly number[] = [50, 100, 500, 1000, 5000];

export function bucketAmountMinor(minor: number, currency: string): string {
  const major = Math.abs(fromMinor(minor, currency));
  let lower = 0;
  for (const edge of BUCKET_EDGES_MAJOR) {
    if (major < edge) {
      return lower === 0 ? `<${edge}` : `${lower}-${edge}`;
    }
    lower = edge;
  }
  return `>=${BUCKET_EDGES_MAJOR[BUCKET_EDGES_MAJOR.length - 1]}`;
}

export function buildLlmPayload(args: {
  advices: readonly Advice[];
  metrics: DayMetrics;
  locale?: string;
  categoryLabel?: (categoryId: string | null) => string;
}): LlmRedactedPayload {
  const { advices, metrics } = args;
  const label = args.categoryLabel ?? ((id: string | null) => id ?? '未分类');
  const categories = new Set<string>();
  const amountBuckets = new Set<string>();
  const templateIds = new Set<string>();

  for (const advice of advices) {
    templateIds.add(advice.ruleId);
    const cat = advice.evidence['categoryLabel'];
    if (typeof cat === 'string') categories.add(cat);
    const catId = advice.evidence['categoryId'];
    if (typeof catId === 'string') categories.add(label(catId));
  }
  for (const slice of metrics.topCategories.slice(0, 3)) {
    categories.add(label(slice.categoryId));
    amountBuckets.add(bucketAmountMinor(slice.amountMinor, metrics.categoryBreakdownCurrency ?? metrics.baseCurrency));
  }
  if (metrics.netConvertedTotalMinor !== null) {
    amountBuckets.add(bucketAmountMinor(metrics.netConvertedTotalMinor, metrics.baseCurrency));
  }

  return {
    locale: args.locale ?? 'zh-CN',
    baseCurrency: metrics.baseCurrency,
    templateIds: [...templateIds].sort(),
    categories: [...categories].sort(),
    amountBuckets: [...amountBuckets].sort(),
    adviceCount: advices.length,
  };
}

/**
 * 出网前的最后一道闸：任何禁用字段名或敏感值出现即抛错。
 * 由 privacy 测试与运行时同时调用（失败时静默回退本地模板）。
 */
export function assertNoForbiddenContent(
  payload: unknown,
  forbiddenValues: readonly string[] = [],
): void {
  const forbidden = forbiddenValues.filter((v) => v.trim() !== '').map((v) => v.toLowerCase());
  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      const lower = node.toLowerCase();
      for (const value of forbidden) {
        if (lower.includes(value)) {
          throw new Error(`脱敏校验失败：${path} 含敏感值「${value}」`);
        }
      }
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (FORBIDDEN_LLM_KEYS.includes(key.toLowerCase())) {
        throw new Error(`脱敏校验失败：载荷含禁用字段「${key}」`);
      }
      walk(value, `${path}.${key}`);
    }
  };
  walk(payload, '$');
}

/**
 * 分类：预置两级分类 + 规则化自动分类。
 * 自动分类优先级：商户映射 > 关键词 > 金额区间 > 历史同商户多数类。
 */

export interface Category {
  categoryId: string;
  parentId: string | null;
  name: string;
  preset: boolean;
  sort: number;
}

export const UNCATEGORIZED = '__uncategorized__';

export const PRESET_CATEGORIES: readonly Category[] = [
  { categoryId: 'food', parentId: null, name: '餐饮', preset: true, sort: 10 },
  { categoryId: 'food.dining', parentId: 'food', name: '正餐', preset: true, sort: 11 },
  { categoryId: 'food.drinks', parentId: 'food', name: '饮品', preset: true, sort: 12 },
  { categoryId: 'transport', parentId: null, name: '交通', preset: true, sort: 20 },
  { categoryId: 'transport.public', parentId: 'transport', name: '公共交通', preset: true, sort: 21 },
  { categoryId: 'transport.taxi', parentId: 'transport', name: '打车', preset: true, sort: 22 },
  { categoryId: 'housing', parentId: null, name: '居住', preset: true, sort: 30 },
  { categoryId: 'housing.rent', parentId: 'housing', name: '房租', preset: true, sort: 31 },
  { categoryId: 'housing.utilities', parentId: 'housing', name: '水电煤', preset: true, sort: 32 },
  { categoryId: 'shopping', parentId: null, name: '购物', preset: true, sort: 40 },
  { categoryId: 'medical', parentId: null, name: '医疗', preset: true, sort: 50 },
  { categoryId: 'entertainment', parentId: null, name: '娱乐', preset: true, sort: 60 },
  { categoryId: 'social', parentId: null, name: '人情', preset: true, sort: 70 },
  { categoryId: 'other', parentId: null, name: '其他', preset: true, sort: 999 },
];

export type RuleKind = 'merchant' | 'keyword' | 'amount_range' | 'history_merchant';

export interface CategoryRule {
  id: number;
  kind: RuleKind;
  pattern: string;
  categoryId: string;
  hits: number;
}

export interface SuggestInput {
  merchant: string | null;
  note: string | null;
  amountMinor: number;
  currency: string;
  /** 历史“同商户 → 分类”的多数结果（由仓储层预聚合） */
  historyCategoryByMerchant?: Record<string, string>;
}

export interface Suggestion {
  categoryId: string;
  reason: RuleKind;
  confidence: number;
}

function amountRangeMatches(pattern: string, amountMinor: number): boolean {
  // 形如 "0-5000" / "5000-" / "-2000"（单位：最小货币单位）
  const m = /^(-?\d*)\s*-\s*(-?\d*)$/.exec(pattern.trim());
  if (!m) return false;
  const [, loRaw, hiRaw] = m;
  const lo = loRaw === '' ? Number.NEGATIVE_INFINITY : Number(loRaw);
  const hi = hiRaw === '' ? Number.POSITIVE_INFINITY : Number(hiRaw);
  return amountMinor >= lo && amountMinor <= hi;
}

/**
 * 返回自动分类建议；无把握时返回 null（调用方置为“未分类/待补充”）。
 */
export function suggestCategory(input: SuggestInput, rules: readonly CategoryRule[]): Suggestion | null {
  const merchant = (input.merchant ?? '').toLowerCase();
  const text = `${input.merchant ?? ''} ${input.note ?? ''}`.toLowerCase();

  for (const rule of rules) {
    if (rule.kind === 'merchant' && merchant && merchant.includes(rule.pattern.toLowerCase())) {
      return { categoryId: rule.categoryId, reason: 'merchant', confidence: 0.9 };
    }
  }
  for (const rule of rules) {
    if (rule.kind === 'keyword' && text.trim() && text.includes(rule.pattern.toLowerCase())) {
      return { categoryId: rule.categoryId, reason: 'keyword', confidence: 0.75 };
    }
  }
  for (const rule of rules) {
    if (rule.kind === 'amount_range' && amountRangeMatches(rule.pattern, input.amountMinor)) {
      return { categoryId: rule.categoryId, reason: 'amount_range', confidence: 0.45 };
    }
  }
  if (merchant && input.historyCategoryByMerchant?.[merchant]) {
    return {
      categoryId: input.historyCategoryByMerchant[merchant] as string,
      reason: 'history_merchant',
      confidence: 0.65,
    };
  }
  return null;
}

export function categoryName(categories: readonly Category[], categoryId: string | null): string {
  if (!categoryId || categoryId === UNCATEGORIZED) return '未分类';
  return categories.find((c) => c.categoryId === categoryId)?.name ?? categoryId;
}

export function rootsOf(categories: readonly Category[]): Category[] {
  return categories.filter((c) => c.parentId === null).sort((a, b) => a.sort - b.sort);
}

export function childrenOf(categories: readonly Category[], parentId: string): Category[] {
  return categories.filter((c) => c.parentId === parentId).sort((a, b) => a.sort - b.sort);
}

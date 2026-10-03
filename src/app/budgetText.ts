/** 预算额度的文本形式（界面里用「分类 金额」每行一项），保证可读可编辑。 */
import { fromMinor, toMinor } from '../domain/money.ts';

export interface BudgetItemLike {
  categoryId: string | null;
  limitMinor: number;
}

export function serializeBudgetItems(items: readonly BudgetItemLike[], currency: string): string {
  return items.map((i) => `${i.categoryId ?? '*'} ${fromMinor(i.limitMinor, currency)}`).join('\n');
}

/** 解析「* 6000」/「food 1200」；无法识别的行被忽略并计入 errors */
export function parseBudgetItems(
  text: string,
  currency: string,
): { items: BudgetItemLike[]; errors: string[] } {
  const items: BudgetItemLike[] = [];
  const errors: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) {
      errors.push(`无法识别：${line}（应为「分类 金额」或「* 金额」）`);
      continue;
    }
    const key = parts[0] as string;
    const amountText = parts[parts.length - 1] as string;
    const amount = Number(amountText);
    if (!Number.isFinite(amount) || amount < 0) {
      errors.push(`金额非法：${line}`);
      continue;
    }
    items.push({
      categoryId: key === '*' || key === '总额' ? null : key,
      limitMinor: toMinor(amount, currency),
    });
  }
  return { items, errors };
}

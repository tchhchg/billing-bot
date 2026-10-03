/** 预算：周期区间、额度解析、进度计算。 */
import type { BudgetConfig, BudgetProgress } from '../types.ts';
import { daysBetween, endOfMonth, startOfMonth, startOfWeek, addDays } from './period.ts';

export interface BudgetPeriod {
  start: string;
  end: string;
}

export function budgetPeriodRange(cfg: BudgetConfig, date: string): BudgetPeriod {
  if (cfg.period === 'week') {
    const start = startOfWeek(date);
    return { start, end: addDays(start, 6) };
  }
  // month 与 custom 暂按自然月处理（custom 的显式区间在 P1 由设置页提供）
  return { start: startOfMonth(date), end: endOfMonth(date) };
}

/** 总额额度 = categoryId 为 null 的条目之和；没有则视为未设置总额预算 */
export function totalBudgetLimit(cfg: BudgetConfig): number | null {
  const items = cfg.items.filter((i) => i.categoryId === null);
  if (items.length === 0) return null;
  return items.reduce((sum, i) => sum + i.limitMinor, 0);
}

export function categoryBudgetLimit(cfg: BudgetConfig, categoryId: string): number | null {
  const item = cfg.items.find((i) => i.categoryId === categoryId);
  return item ? item.limitMinor : null;
}

export function computeBudgetProgress(args: {
  cfg: BudgetConfig;
  date: string;
  /** 本周期已发生的净支出（基础币种最小单位） */
  spentMinor: number;
}): BudgetProgress | null {
  const { cfg, date, spentMinor } = args;
  if (!cfg.enabled) return null;
  const limitMinor = totalBudgetLimit(cfg);
  if (limitMinor === null || limitMinor <= 0) return null;

  const { start, end } = budgetPeriodRange(cfg, date);
  const daysLeft = Math.max(1, daysBetween(date, end) + 1);
  const remainingMinor = limitMinor - spentMinor;

  return {
    periodStart: start,
    periodEnd: end,
    spentMinor,
    limitMinor,
    ratio: spentMinor / limitMinor,
    remainingMinor,
    daysLeft,
    dailyAllowanceMinor: remainingMinor > 0 ? Math.floor(remainingMinor / daysLeft) : 0,
  };
}

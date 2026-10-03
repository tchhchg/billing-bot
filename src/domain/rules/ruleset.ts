/**
 * 规则集定义与阈值。规则版本号进入幂等键：改了规则集当日允许重算一次。
 * 所有阈值都可由用户配置覆盖（每用户可配置铁律）。
 */
import type { AdviceSeverity } from '../types.ts';

export const RULESET_VERSION = '1.0.0';

export interface RuleThresholds {
  /** R1 单日超基线比例（0.5 = 超出 50% 才提醒） */
  r1Alpha: number;
  /** R2 连续上升天数 */
  r2RisingDays: number;
  /** R2 占比下限 */
  r2MinRatio: number;
  /** R3 预算告警比例 */
  r3BudgetRatio: number;
  /** R4 订阅：回顾窗口天数 */
  r4LookbackDays: number;
  /** R4 订阅：最少出现次数 */
  r4MinOccurrences: number;
  /** R4 订阅：金额近似容忍度（相对值） */
  r4AmountTolerance: number;
  /** R4 订阅：周期最小/最大间隔天数 */
  r4MinGapDays: number;
  r4MaxGapDays: number;
  /** R5 疑似重复：最少条数 */
  r5MinCount: number;
  /** R6 大额单笔：相对基线的倍数 */
  r6Multiplier: number;
  /** R6 大额单笔：绝对阈值（基础币种最小单位） */
  r6AbsoluteMinor: number;
  /** R7 数据质量：待补充分类条数下限 */
  r7PendingMin: number;
  /** R9 长尾高频：小额上限（基础币种最小单位） */
  r9SmallAmountMinor: number;
  /** R9 长尾高频：最少笔数 */
  r9MinCount: number;
  /** R9 长尾高频：占当日笔数比例下限 */
  r9MinShare: number;
}

export const DEFAULT_THRESHOLDS: RuleThresholds = {
  r1Alpha: 0.5,
  r2RisingDays: 3,
  r2MinRatio: 0.3,
  r3BudgetRatio: 0.8,
  r4LookbackDays: 90,
  r4MinOccurrences: 2,
  r4AmountTolerance: 0.1,
  r4MinGapDays: 25,
  r4MaxGapDays: 35,
  r5MinCount: 2,
  r6Multiplier: 2,
  r6AbsoluteMinor: 100_000,
  r7PendingMin: 3,
  r9SmallAmountMinor: 2_000,
  r9MinCount: 5,
  r9MinShare: 0.6,
};

export function resolveThresholds(partial?: Partial<RuleThresholds>): RuleThresholds {
  return { ...DEFAULT_THRESHOLDS, ...(partial ?? {}) };
}

export interface RuleMeta {
  id: string;
  title: string;
  severity: AdviceSeverity;
  /** 规则依赖的输入；缺失时该规则自动跳过 */
  requires: readonly string[];
  description: string;
}

export const RULES: readonly RuleMeta[] = [
  {
    id: 'R1',
    title: '单日支出高于基线',
    severity: 'warn',
    requires: ['anomalyEligibleTotalMinor', 'baseline'],
    description: '当日（剔除固定支出）高于参照基线超过阈值比例时提醒',
  },
  {
    id: 'R2',
    title: '分类占比连续上升',
    severity: 'notice',
    requires: ['categoryRatioHistory'],
    description: '某分类占比连续 N 日上升且超过占比下限',
  },
  {
    id: 'R3',
    title: '预算进度提醒',
    severity: 'warn',
    requires: ['budgetProgress'],
    description: '本期累计支出达到预算预警比例',
  },
  {
    id: 'R4',
    title: '疑似订阅扣费',
    severity: 'info',
    requires: ['history'],
    description: '同商户近似金额按约一个月周期重复出现',
  },
  {
    id: 'R5',
    title: '疑似重复记账',
    severity: 'notice',
    requires: ['expenses'],
    description: '同日同商户同金额出现多条',
  },
  {
    id: 'R6',
    title: '大额单笔提醒',
    severity: 'notice',
    requires: ['expenses', 'baseline'],
    description: '单笔超过基线倍数或绝对阈值（固定支出除外）',
  },
  {
    id: 'R7',
    title: '数据质量提醒',
    severity: 'info',
    requires: ['pendingReviewCount'],
    description: '未分类/待补充条目过多',
  },
  {
    id: 'R8',
    title: '无数据日提示',
    severity: 'info',
    requires: ['billCount=0'],
    description: '当日没有任何账单记录（由用例层触发，不参与规则评估）',
  },
  {
    id: 'R9',
    title: '长尾高频小额',
    severity: 'info',
    requires: ['expenses'],
    description: '小额支出笔数与占比同时偏高',
  },
];

export function ruleMeta(id: string): RuleMeta | undefined {
  return RULES.find((r) => r.id === id);
}

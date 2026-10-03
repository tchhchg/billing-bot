/**
 * 领域层公共类型。
 *
 * 铁律：本文件及 domain/ 下所有模块**不得** import infra/、channels/、server/。
 * 依赖方向永远是 infra → domain，不是反过来。
 */

export type Direction = 'expense' | 'income' | 'transfer';
export type BillStatus = 'normal' | 'pending_review' | 'void';
export type BillSource = 'manual' | 'import' | 'api';

/** 账单实体。金额一律为最小货币单位整数（人民币=分），禁止浮点。 */
export interface Bill {
  billId: string;
  amountMinor: number;
  currency: string;
  direction: Direction;
  categoryId: string | null;
  /** ISO8601 带偏移，账单“发生”时间（≠创建时间），统计归属依据 */
  occurredAt: string;
  merchant: string | null;
  accountId: string | null;
  paymentMethod: string | null;
  tags: string[];
  note: string | null;
  source: BillSource;
  /** 外部唯一键（如支付宝流水号），导入幂等的唯一依据 */
  sourceRef: string | null;
  /** 非空表示这是一笔退款，指向原单 */
  refundOf: string | null;
  status: BillStatus;
  recurringId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** 退款口径：A 冲减原单日 / B 冲减退款当日 / C 不计入 */
export type RefundPolicy = 'A' | 'B' | 'C';

export interface MoneyConfig {
  baseCurrency: string;
  multiCurrency: boolean;
  fxPolicy: 'on_date' | 'latest';
}

export interface BudgetItem {
  /** null = 总额预算 */
  categoryId: string | null;
  limitMinor: number;
}

export interface BudgetConfig {
  enabled: boolean;
  period: 'month' | 'week' | 'custom';
  items: BudgetItem[];
}

export interface AnalysisConfig {
  refundPolicy: RefundPolicy;
  baselineWindow: Array<'p7' | 'p28' | 'same_weekday'>;
  coldStartMinDays: number;
  recurringAmortize: boolean;
  fixedExpenseWhitelist: string[];
  /** 允许的未来日期容差（天），超出即硬拒绝 */
  futureDateToleranceDays: number;
}

export interface PushConfig {
  channels: string[];
  time: string;
  timezone: string;
  maxDailyAdvice: number;
}

export interface Config {
  money: MoneyConfig;
  budget: BudgetConfig;
  analysis: AnalysisConfig;
  push: PushConfig;
}

export interface Issue {
  field: string;
  code: string;
  message: string;
  severity: 'hard' | 'soft';
}

export interface ValidationOutcome {
  ok: boolean;
  bill: Bill | null;
  hardIssues: Issue[];
  softIssues: Issue[];
  /** 是否需要进入“待补充”队列 */
  needsReview: boolean;
}

/** 归一化后的归属金额：金额永远是正数，方向由 sign 表达 */
export interface AttributedAmount {
  billId: string;
  amountMinor: number;
  sign: 1 | -1;
  currency: string;
  /** 该金额被归属到的本地日期（口径 A/B 在这里产生差异） */
  localDate: string;
  categoryId: string | null;
  merchant: string | null;
  kind: 'expense' | 'refund' | 'income' | 'transfer';
  /** 命中固定支出白名单（参与总额，但异常检测排除） */
  isFixedExpense: boolean;
  /** 分类缺失等待补充：金额仍计入总额（钱确实花了），但不参与分类占比结论 */
  needsReview: boolean;
}

export interface FxRate {
  rateDate: string;
  base: string;
  quote: string;
  rate: number;
  source: string;
  fetchedAt: string;
}

export interface CategorySlice {
  categoryId: string | null;
  amountMinor: number;
  ratio: number;
}

/** 单笔支出的统计口径值（valueMinor = 折算后金额；null 表示缺汇率） */
export interface ExpenseValue {
  billId: string;
  valueMinor: number | null;
  originalMinor: number;
  currency: string;
  merchant: string | null;
  categoryId: string | null;
  isFixedExpense: boolean;
  needsReview: boolean;
}

export interface DayMetrics {
  localDate: string;
  baseCurrency: string;
  /** 各币种净额（含退款冲减，可能为负），原始分币种金额 */
  netTotalByCurrency: Record<string, number>;
  /** 折算到基础币种的净额；null = 缺少汇率，**不可**给出跨币种合计 */
  netConvertedTotalMinor: number | null;
  fxMissingCount: number;
  fxMissingByCurrency: Record<string, number>;
  expenseCount: number;
  refundCount: number;
  /** 等待补充分类/日期可疑的条数 */
  pendingReviewCount: number;
  /** 未分类金额（不参与分类占比结论） */
  uncategorizedMinor: number;
  avgExpenseMinor: number | null;
  medianExpenseMinor: number | null;
  maxExpenseMinor: number | null;
  /** 均值/中位数/最大单笔等统计量所用币种 */
  statsCurrency: string;
  /** 统计量是否已完成跨币种折算（false = 仅使用基础币种条目，结果不完整） */
  statsConverted: boolean;
  /** 分类占比所使用的币种（折算可用时为基础币种，否则为当日主导币种） */
  categoryBreakdownCurrency: string | null;
  categoryBreakdownConverted: boolean;
  topCategories: CategorySlice[];
  categoryTotals: Record<string, number>;
  fixedExpenseMinor: number;
  fixedExpenseCount: number;
  /** 剔除固定支出白名单后的净支出，异常检测规则用它（null = 不可折算） */
  anomalyEligibleTotalMinor: number | null;
  /** 剔除固定支出后的最大单笔支出 */
  maxNonFixedExpenseMinor: number | null;
  /** 当日单笔支出明细（供规则生成可追溯证据） */
  expenses: ExpenseValue[];
  /** 当日净额为负（退款冲减所致） */
  negativeNet: boolean;
}

export interface Baseline {
  p7: number | null;
  p28: number | null;
  sameWeekday: number | null;
  /** 参与统计的有效天数 */
  sampleDays: number;
  coldStart: boolean;
}

export interface BudgetProgress {
  periodStart: string;
  periodEnd: string;
  spentMinor: number;
  limitMinor: number;
  ratio: number;
  remainingMinor: number;
  daysLeft: number;
  dailyAllowanceMinor: number;
}

export type AdviceSeverity = 'info' | 'notice' | 'warn';

export interface AdviceAction {
  type: 'view_detail' | 'snooze' | 'mark_inaccurate' | 'record_added' | 'open_budget';
  label: string;
  payload?: Record<string, string | number>;
}

export interface Advice {
  adviceId: string;
  ruleId: string;
  severity: AdviceSeverity;
  title: string;
  /** 证据：触发这条建议的具体数字，用户点开可看到“为什么这么说” */
  evidence: Record<string, string | number | boolean | null>;
  suggestions: string[];
  confidence: number;
  actions: AdviceAction[];
  disclaimerRequired: boolean;
}

export interface FeedbackState {
  /** 用户已关闭的规则 */
  mutedRuleIds: string[];
  /** 规则 → 冷却截止日期（YYYY-MM-DD） */
  cooldownUntil: Record<string, string>;
  /** 规则 → 被标记“不准”的次数 */
  inaccurateCounts: Record<string, number>;
}

/**
 * 消费通知邮件解析：从银行/信用卡/支付渠道的通知正文里抽取一笔账单。
 *
 * 为什么值得单独做：银行与信用卡的每笔消费通知是**主动推送**的，
 * 不需要导出、不需要解压密码、不需要人工参与——这是唯一能真正做到
 * "无人值守自动记账"的数据来源。
 *
 * 设计原则（宁可不出，不可出错）：
 *  1. 必须同时命中"交易关键词"和"金额"才算识别成功，否则明确返回未命中原因；
 *  2. 先把"余额 / 可用额度 / 积分 / 账单日"等极易误判的句子剔除，再抽金额；
 *  3. 抽不到时间就用邮件时间兜底，但会降低置信度并如实标注；
 *  4. 模板可扩展：内置通用模板，用户可为自己的银行补一条模板。
 */
import { isoWithOffset, wallClockToUtcMs } from '../../domain/analysis/period.ts';

export interface NotificationPatterns {
  amount: string;
  occurredAt?: string;
  merchant?: string;
  cardTail?: string;
}

export interface NotificationTemplate {
  id: string;
  name: string;
  /** 全部命中才尝试解析（用于区分银行/渠道） */
  matchAll?: string[];
  /** 任一命中即可 */
  matchAny?: string[];
  /** 命中任一即放弃（例如"营销""账单分期"） */
  exclude?: string[];
  patterns: NotificationPatterns;
  /** 命中这些词判为收入（退款/入账） */
  incomeKeywords?: string[];
  /** 该模板的默认定向 */
  defaultDirection?: 'expense' | 'income';
}

export interface NotificationFields {
  amountText: string;
  amountMinor: number;
  currency: string;
  occurredAt: string;
  occurredAtFromEmail: boolean;
  merchant: string | null;
  direction: 'expense' | 'income';
  cardTail: string | null;
}

export interface NotificationParseResult {
  matched: boolean;
  templateId?: string;
  templateName?: string;
  fields?: NotificationFields;
  /** 未命中时的明确原因，便于用户决定要不要补模板 */
  reason?: string;
  confidence: number;
  /** 命中的交易关键词（证据） */
  signals: string[];
}

export interface ParseNotificationArgs {
  subject: string;
  body: string;
  /** 邮件时间（ISO）：通知里没写时间时兜底 */
  emailDate: string;
  timeZone: string;
  currency: string;
  templates?: readonly NotificationTemplate[];
}

/** 交易关键词：至少命中一个，否则不认为这是一条消费通知 */
const TRANSACTION_KEYWORDS = [
  '消费',
  '支出',
  '支付',
  '扣款',
  '交易',
  '入账',
  '存入',
  '转入',
  '退款',
  '退货',
  '还款',
  '取现',
  '代扣',
  '快捷支付',
];

/** 收入类关键词 */
const INCOME_KEYWORDS = ['退款', '退货', '入账', '存入', '转入', '收入', '工资', '还款', '返现', '冲正'];

/**
 * 营销/优惠类邮件的特征词。
 * 这是实测踩到的坑："消费满 300 元立减 50 元"会被当成一笔 300 元消费——
 * 自动记账最怕的就是这种误报，所以单独加一道闸门。
 */
const PROMO_SIGNALS = [
  '立减',
  '满减',
  '优惠',
  '领取',
  '抽奖',
  '活动',
  '办卡',
  '邀请',
  '点击',
  '下载App',
  '下载 App',
  '推广',
  '折扣',
  '返券',
  '积分兑换',
  '限时',
  '福利',
];

/**
 * 强信号：真实交易通知几乎一定会带其中之一（账户标识或明确的交易金额/状态）。
 * 只有营销词、没有强信号 → 判定为非交易邮件。
 */
const STRONG_SIGNALS = [
  '尾号',
  '末四位',
  '末4位',
  '卡号',
  '账号',
  '账户',
  '交易金额',
  '消费金额',
  '交易时间',
  '已消费',
  '已支付',
  '已扣款',
  '扣款',
  '入账',
  '退款',
  '退货',
  '支出',
  '交易成功',
];

/**
 * 这些句子极易被误当成金额来源（余额、额度、积分、分期），先整句剔除。
 * 这是把"识别准确率"从"看起来能用"提到"敢用"的关键一步。
 */
const NOISE_PATTERNS = [
  /余额/,
  /可用额度/,
  /信用额度/,
  /额度/,
  /积分/,
  /账单日/,
  /还款日/,
  /最低还款/,
  /应还/,
  /待还/,
  /还款额/,
  /账单金额/,
  /分期/,
  /年费/,
  /利率/,
  /汇率/,
  /营销/,
  /优惠券/,
  /活动/,
];

function stripNoise(text: string): string {
  // 按"分句"而不是"整句"剔除：短信里余额常常和交易金额写在同一句，
  // 例如「…支出(消费)46.50元，余额1234.00元。」——按整句删会把交易也删掉。
  // 但逗号也可能出现在千分位里（1,299.00），所以只切"两侧不同时为数字"的逗号。
  return text
    .split(/(?<!\d)[。；;，,、](?!\d)|\n|\r/)
    .filter((clause) => !NOISE_PATTERNS.some((re) => re.test(clause)))
    .join('\n');
}

function cleanAmount(raw: string): number | null {
  const normalized = raw.replace(/[,\s]/g, '');
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** 金额抽取：按"标记明确度"排序，先找 金额:xxx，再找 ¥/人民币，最后找 xxx元 */
const AMOUNT_CANDIDATES: RegExp[] = [
  /(?:交易金额|消费金额|金额|支出金额|入账金额|发生额)[：:\s]*(?:人民币|RMB|CNY|¥|￥)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
  /(?:人民币|RMB|CNY)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i,
  /[¥￥]\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/,
  /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*元/,
];

const DATE_CANDIDATES: RegExp[] = [
  // 2026-10-03 21:05 / 2026年10月3日 21:05
  /(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?(?:\s+|T)?(\d{1,2}):(\d{2})(?::(\d{2}))?/,
  /(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/,
  // 10月03日21:05（缺年份）
  /(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/,
  // 10-03 21:05（缺年份）
  /(\d{1,2})\s*[-/]\s*(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/,
];

const MERCHANT_PATTERNS: RegExp[] = [
  /(?:商户名称|商户|收款方|交易对方|特约商户|对方户名)[：:\s]*([^\s,，。;；、|]{1,30})/,
  /[「『"“]([^」』"”]{1,30})[」』"”]/,
  /(?:在|于)\s*([\u4e00-\u9fa5A-Za-z0-9·\-]{2,20})\s*(?:消费|支付|扣款|充值)/,
];

const CARD_TAIL_PATTERNS: RegExp[] = [
  /(?:卡号末四位|卡号末4位|末四位|末4位|尾号)[^\d]{0,4}(\d{4})/,
  /(?:卡号|账号)[^\d]{0,6}(\d{4})(?!\d)/,
];

export const GENERIC_TEMPLATE_ID = 'generic-cn-bank';

/** 通用模板：覆盖国内银行/信用卡/支付渠道最常见的通知写法 */
export const GENERIC_TEMPLATE: NotificationTemplate = {
  id: GENERIC_TEMPLATE_ID,
  name: '通用（银行/信用卡/支付通知）',
  patterns: {
    amount: 'builtin',
    occurredAt: 'builtin',
    merchant: 'builtin',
    cardTail: 'builtin',
  },
  incomeKeywords: INCOME_KEYWORDS,
  defaultDirection: 'expense',
};

export function defaultTemplates(): NotificationTemplate[] {
  return [GENERIC_TEMPLATE];
}

function templateCandidates(args: ParseNotificationArgs): NotificationTemplate[] {
  const templates = args.templates && args.templates.length > 0 ? args.templates : defaultTemplates();
  const text = `${args.subject}\n${args.body}`;
  const hits = templates.filter((t) => {
    if (t.exclude?.some((word) => text.includes(word))) return false;
    if (t.matchAll && !t.matchAll.every((word) => text.includes(word))) return false;
    if (t.matchAny && !t.matchAny.some((word) => text.includes(word))) return false;
    return true;
  });
  // 专有模板优先于通用模板
  return hits.sort((a, b) => (a.id === GENERIC_TEMPLATE_ID ? 1 : 0) - (b.id === GENERIC_TEMPLATE_ID ? 1 : 0));
}

function extractAmount(text: string, template: NotificationTemplate): { text: string; minor: number } | null {
  const patterns: RegExp[] =
    template.patterns.amount && template.patterns.amount !== 'builtin'
      ? [new RegExp(template.patterns.amount)]
      : AMOUNT_CANDIDATES;
  for (const re of patterns) {
    const match = re.exec(text);
    const captured = match?.[1];
    if (captured === undefined) continue;
    const value = cleanAmount(captured);
    if (value === null) continue;
    return { text: captured, minor: Math.round(value * 100) };
  }
  return null;
}

function isoWithOffsetFromParts(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
): string {
  return buildIso(parts, timeZone);
}

// 复用领域层的墙上时间换算，避免两套时区逻辑
function buildIso(
  parts: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  timeZone: string,
): string {
  return isoWithOffset(wallClockToUtcMs(parts, timeZone), timeZone);
}

function extractDate(
  text: string,
  template: NotificationTemplate,
  emailDate: string,
  timeZone: string,
): { iso: string; fromEmail: boolean } {
  const emailLocal = new Date(Date.parse(emailDate) || Date.now());
  const emailYear = Number(isoWithOffset(emailLocal.getTime(), timeZone).slice(0, 4));

  const custom = template.patterns.occurredAt && template.patterns.occurredAt !== 'builtin'
    ? [new RegExp(template.patterns.occurredAt)]
    : [];
  const patterns = [...custom, ...DATE_CANDIDATES];

  for (const [index, re] of patterns.entries()) {
    const m = re.exec(text);
    if (!m) continue;
    try {
      if (index === 0 && custom.length > 0) {
        // 自定义模板：捕获组 1 必须是完整时间文本
        const raw = m[1];
        if (!raw) continue;
        const ms = Date.parse(raw);
        if (Number.isNaN(ms)) continue;
        return { iso: isoWithOffset(ms, timeZone), fromEmail: false };
      }
      const builtinIndex = index - custom.length;
      if (builtinIndex === 0) {
        const [, y, mo, d, h, mi, s] = m;
        return {
          iso: isoWithOffsetFromParts(
            {
              year: Number(y),
              month: Number(mo),
              day: Number(d),
              hour: Number(h),
              minute: Number(mi),
              second: Number(s ?? '0'),
            },
            timeZone,
          ),
          fromEmail: false,
        };
      }
      if (builtinIndex === 1) {
        const [, y, mo, d] = m;
        return {
          iso: isoWithOffsetFromParts(
            { year: Number(y), month: Number(mo), day: Number(d), hour: 12, minute: 0, second: 0 },
            timeZone,
          ),
          fromEmail: true,
        };
      }
      if (builtinIndex === 2) {
        const [, mo, d, h, mi, s] = m;
        return {
          iso: resolveYearless(Number(mo), Number(d), Number(h), Number(mi), Number(s ?? '0'), emailYear, emailLocal.getTime(), timeZone),
          fromEmail: false,
        };
      }
      if (builtinIndex === 3) {
        const [, mo, d, h, mi, s] = m;
        return {
          iso: resolveYearless(Number(mo), Number(d), Number(h), Number(mi), Number(s ?? '0'), emailYear, emailLocal.getTime(), timeZone),
          fromEmail: false,
        };
      }
    } catch {
      continue;
    }
  }

  return { iso: isoWithOffset(emailLocal.getTime(), timeZone), fromEmail: true };
}

/**
 * 通知里常常只写"10月03日"，年份要自己补。
 * 若补出的时间比邮件时间晚了一天以上（跨年场景，如 1 月收到"12月31日"的通知），就按上一年算。
 */
function resolveYearless(
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  emailYear: number,
  emailMs: number,
  timeZone: string,
): string {
  const sameYear = wallClockToUtcMs({ year: emailYear, month, day, hour, minute, second }, timeZone);
  if (sameYear - emailMs > 24 * 60 * 60 * 1000) {
    return buildIso({ year: emailYear - 1, month, day, hour, minute, second }, timeZone);
  }
  return buildIso({ year: emailYear, month, day, hour, minute, second }, timeZone);
}

function extractMerchant(text: string, template: NotificationTemplate): string | null {
  const patterns =
    template.patterns.merchant && template.patterns.merchant !== 'builtin'
      ? [new RegExp(template.patterns.merchant)]
      : MERCHANT_PATTERNS;
  for (const re of patterns) {
    const m = re.exec(text);
    const value = (m?.[1] ?? '').trim();
    if (value !== '') return value;
  }
  return null;
}

function extractCardTail(text: string, template: NotificationTemplate): string | null {
  const patterns =
    template.patterns.cardTail && template.patterns.cardTail !== 'builtin'
      ? [new RegExp(template.patterns.cardTail)]
      : CARD_TAIL_PATTERNS;
  for (const re of patterns) {
    const m = re.exec(text);
    const value = m?.[1];
    if (value !== undefined) return value;
  }
  return null;
}

export function parseNotification(args: ParseNotificationArgs): NotificationParseResult {
  const raw = `${args.subject}\n${args.body}`;
  const signals: string[] = [];

  const hitTransaction = TRANSACTION_KEYWORDS.find((word) => raw.includes(word));
  if (!hitTransaction) {
    return {
      matched: false,
      reason: '正文里没有"消费/支出/扣款/入账"这类交易关键词，不像是一条交易通知',
      confidence: 0,
      signals: [],
    };
  }
  signals.push(hitTransaction);

  // 营销/优惠邮件闸门：只有营销词、没有账户或交易标识 → 直接判定不是交易通知
  const promoHit = PROMO_SIGNALS.find((word) => raw.includes(word));
  if (promoHit && !STRONG_SIGNALS.some((word) => raw.includes(word))) {
    return {
      matched: false,
      reason: `看起来是营销/优惠类邮件（命中「${promoHit}」且没有账户尾号或交易金额标识），已跳过`,
      confidence: 0,
      signals,
    };
  }

  const candidates = templateCandidates(args);
  if (candidates.length === 0) {
    return {
      matched: false,
      reason: '没有匹配到任何模板（可能命中了模板的排除词）',
      confidence: 0,
      signals,
    };
  }

  const text = stripNoise(raw);
  for (const template of candidates) {
    const amount = extractAmount(text, template);
    if (!amount) continue;

    const incomeWords = template.incomeKeywords ?? INCOME_KEYWORDS;
    const incomeHit = incomeWords.find((word) => raw.includes(word));
    const direction: 'expense' | 'income' =
      template.defaultDirection === 'income' || incomeHit !== undefined ? 'income' : 'expense';
    if (incomeHit) signals.push(incomeHit);

    const date = extractDate(text, template, args.emailDate, args.timeZone);
    const merchant = extractMerchant(text, template);
    const cardTail = extractCardTail(text, template);

    let confidence = 0.4;
    confidence += 0.25; // 有金额（必需）
    confidence += date.fromEmail ? 0.05 : 0.15;
    if (merchant) confidence += 0.1;
    if (cardTail) confidence += 0.05;
    if (template.id !== GENERIC_TEMPLATE_ID) confidence += 0.05;
    confidence = Math.min(0.95, Number(confidence.toFixed(2)));

    return {
      matched: true,
      templateId: template.id,
      templateName: template.name,
      confidence,
      signals,
      fields: {
        amountText: amount.text,
        amountMinor: amount.minor,
        currency: args.currency,
        occurredAt: date.iso,
        occurredAtFromEmail: date.fromEmail,
        merchant,
        direction,
        cardTail,
      },
    };
  }

  return {
    matched: false,
    reason: '命中了交易关键词，但没能抽出一个可信的金额（可能金额写在被排除的"余额/额度"句子里）',
    confidence: 0,
    signals,
  };
}

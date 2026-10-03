/**
 * 应用通知的解析（SmsForwarder「通知转发」那种邮件的正文）。
 *
 * 邮件正文的固定形态（实测）：
 *   com.eg.android.AlipayGphone        ← 包名
 *   你有一笔10.84元的支出，点击领取6个支付宝积分。  ← 通知原文
 *   交易提醒                            ← 通知标题
 *   UID：10209                          ← 设备/用户标识（无意义）
 *   2026-10-04 00:32:15                 ← 通知时间（秒级）
 *
 * 设计原则：
 *  1. **金额/方向尽量复用既有的消费通知解析器**（它已经处理了余额剔除、营销拦截、方向判定），
 *     只在它认不出来时用本地保守模板兜底——避免重复实现那些踩过坑的规则；
 *  2. **认不出来也绝不丢弃**：保留原文，标 recognized=false，由调用方落「条目」；
 *  3. 银行通知里的「对方户名」是**支付通道公司**（支付宝/财付通/银联），不是商户——
 *     单独存成 counterparty 用于判定通道，不冒充商户名。
 */
import type { AppSettings } from './settings.ts';
import { previewNotification } from './importNotifications.ts';

/** 包名 → 人话渠道名（新来源在这里补一行即可） */
export const PACKAGE_CHANNELS: Record<string, string> = {
  'com.eg.android.AlipayGphone': '支付宝',
  'com.ahrcu.mobilebank': '安徽农金',
  'com.icbc': '工商银行',
  'com.icbc.android': '工商银行',
  'com.xunmeng.pinduoduo': '拼多多',
  'com.tencent.mm': '微信',
  'com.taobao.taobao': '淘宝',
  'com.sankuai.meituan': '美团',
  'com.jingdong.app.mall': '京东',
  'com.unionpay': '云闪付',
};

export interface AppNotice {
  /** 通知来源包名；短信转发来的为 null */
  packageName: string | null;
  /** 人话渠道名（未知包名会显示成「未知来源:包名」） */
  channel: string;
  title: string;
  /** 通知原文主体（用于入库/归档） */
  content: string;
  occurredAt: string | null;
  /** 对方户名（银行通知里的支付通道公司） */
  counterparty: string | null;
  /** 银行卡尾号 */
  cardTail: string | null;
  amountMinor: number | null;
  direction: 'expense' | 'income' | null;
  /** 疑似退款/提现：银行侧的入账且对方是支付通道（可与对应支出配对冲减） */
  refundCandidate: boolean;
  /** 是否解析出金额（false 时调用方必须保留原文而不是丢弃） */
  recognized: boolean;
  raw: string;
}

const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,5}$/i;
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
const META_RE = /^(UID|SubId|SIM|卡槽|设备|当前时间|接收时间)[:：]/i;

/** 包名大小写不敏感（安卓包名惯例混合大小写，如 com.eg.android.AlipayGphone） */
const CHANNEL_INDEX = new Map(Object.entries(PACKAGE_CHANNELS).map(([key, value]) => [key.toLowerCase(), value]));

function channelOf(packageName: string | null): string {
  if (packageName === null) return '未知来源';
  return CHANNEL_INDEX.get(packageName.toLowerCase()) ?? `未知来源:${packageName}`;
}

/** 本地保守兜底：只认通知里常见的固定句式，且显式排除余额/额度/积分等噪声 */
function fallbackAmount(content: string): { amountMinor: number | null; direction: 'expense' | 'income' | null } {
  const patterns: Array<{ re: RegExp; direction: 'expense' | 'income' }> = [
    { re: /一笔\s*([\d,]+(?:\.\d{1,2})?)\s*元的\s*支出/, direction: 'expense' },
    { re: /一笔\s*([\d,]+(?:\.\d{1,2})?)\s*元的\s*收入/, direction: 'income' },
    { re: /(?:收入|入账)人民币\s*([\d,]+(?:\.\d{1,2})?)\s*元/, direction: 'income' },
    { re: /(?:支出|消费|扣款|付款)人民币\s*([\d,]+(?:\.\d{1,2})?)\s*元/, direction: 'expense' },
  ];
  for (const { re, direction } of patterns) {
    const match = re.exec(content);
    if (!match) continue;
    const raw = match[1] ?? '';
    // 命中位置的左侧若紧跟"余额/额度/积分/可用"，说明抓到的是余额而不是交易金额
    const left = content.slice(Math.max(0, match.index - 6), match.index);
    if (/余额|额度|积分|可用|剩余/.test(left)) continue;
    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0) continue;
    return { amountMinor: Math.round(value * 100), direction };
  }
  return { amountMinor: null, direction: null };
}

export function parseAppNotice(input: {
  subject: string;
  body: string;
  settings: AppSettings;
  now?: Date;
}): AppNotice {
  const raw = input.body;
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  let packageName: string | null = null;
  let occurredAt: string | null = null;
  const contentLines: string[] = [];
  const metaLines: string[] = [];

  for (const line of lines) {
    if (packageName === null && PACKAGE_RE.test(line)) {
      packageName = line.toLowerCase();
      continue;
    }
    const timeMatch = TIME_RE.exec(line);
    if (timeMatch) {
      // 通知自带的本地时间，比邮件到达时间准
      occurredAt = `${timeMatch[1]}-${timeMatch[2]}-${timeMatch[3]}T${timeMatch[4]}:${timeMatch[5]}:${timeMatch[6]}`;
      continue;
    }
    if (META_RE.test(line)) {
      metaLines.push(line);
      continue;
    }
    contentLines.push(line);
  }

  // 标题：转发模板里排在通知原文之后那一行（如"交易提醒""动账通知"）；取不到就用邮件主题
  const title = contentLines.length >= 2 ? (contentLines[contentLines.length - 1] ?? '') : input.subject.replace(/^\[通知\]\s*/, '');
  const content = contentLines.length >= 2 ? contentLines.slice(0, -1).join(' ') : (contentLines[0] ?? metaLines.join(' '));

  const counterparty = /对方户名[:：]\s*([^，,。;；]+)/.exec(content)?.[1]?.trim() ?? null;
  const cardTail = /尾号为?\s*(\d{4})/.exec(content)?.[1] ?? null;

  // 先复用既有解析器（它认得"支出(消费)46.50元，余额…"这类银行短信并会剔除余额）
  const shared = previewNotification({ subject: title, body: content, settings: input.settings, now: input.now ?? new Date() });
  let amountMinor = shared.matched ? (shared.fields?.amountMinor ?? null) : null;
  let direction: 'expense' | 'income' | null = shared.matched ? (shared.fields?.direction ?? null) : null;
  if (amountMinor === null || amountMinor <= 0) {
    const fallback = fallbackAmount(content);
    amountMinor = fallback.amountMinor;
    direction = fallback.direction;
  }

  const refundCandidate =
    direction === 'income' && counterparty !== null && /支付宝|财付通|微信|银联|支付/.test(counterparty);

  return {
    packageName,
    channel: channelOf(packageName),
    title,
    content,
    occurredAt,
    counterparty,
    cardTail,
    amountMinor,
    direction,
    refundCandidate,
    recognized: amountMinor !== null && amountMinor > 0,
    raw,
  };
}

/** 这封邮件像不像"应用通知转发"（而不是银行短信转发） */
export function looksLikeAppNotice(subject: string, body: string): boolean {
  if (subject.includes('[通知]')) return true;
  const firstLine = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  return PACKAGE_RE.test(firstLine);
}

/**
 * 是不是「我们自己发出去的汇总邮件」。
 * ⚠️ 必须排除：汇总邮件会发到同一个邮箱，IMAP 抓取时会被捞回来——
 * 而它正文里带着金额明细，一旦被当成消费通知解析，**每天就会凭空多出一笔假账单**（回灌）。
 */
export function isOwnDigest(subject: string): boolean {
  return /^\s*(账单日报|billing-bot)/.test(subject);
}

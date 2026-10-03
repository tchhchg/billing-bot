/** 配置草稿 → 各层需要的设置视图（唯一入口，避免各层各解析一遍）。 */
import type { Config, MoneyConfig } from '../domain/types.ts';
import { RULESET_VERSION } from '../domain/rules/ruleset.ts';
import { CONFIG_SCHEMA_VERSION, getByPath, toDomainConfig } from '../infra/config/schema.ts';
import { deriveSmtpHost } from '../channels/email.ts';

export interface AppSettings {
  draft: Record<string, unknown>;
  domain: Config;
  money: MoneyConfig;
  push: {
    channels: string[];
    time: string;
    timezone: string;
    maxDailyAdvice: number;
    quietHours: [string, string];
    noDataNotice: boolean;
  };
  host: { im: string; appId: string; receiveId: string; hasCredentials: boolean };
  /** 邮件自动抓取（IMAP）。授权码不在配置里，由 main 从密钥文件读取。 */
  mail: {
    enabled: boolean;
    host: string;
    port: number;
    user: string;
    mailbox: string;
    senderFilter: string;
    lookbackDays: number;
    /** 推导后的 SMTP 主机（留空则按 imap.* → smtp.* 推导） */
    smtpHost: string;
    smtpPort: number;
    /** 每天随日报发一封汇总邮件 */
    digestEnabled: boolean;
    /** 汇总邮件收件人；留空 = 发给自己 */
    notifyTo: string;
    configured: boolean;
  };
  llm: { enabled: boolean; provider: string; redaction: string };
  budget: Config['budget'];
  /** 幂等键的配置版本：用户改了配置就递增，允许当日重算但不会重复轰炸 */
  configVersion: string;
}

/** 与配置内容绑定的短哈希：内容不变则版本不变 */
function shortHash(input: string): string {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, '0');
}

/**
 * 幂等键里的"配置版本"：**只包含会影响分析结果的口径项**。
 *
 * 早期版本把整份配置都算进哈希，结果是"改一次邮箱设置"就会让当天日报重发一张——
 * 那是骚扰。现在只有真正改变数字怎么算的项才会让版本变化。
 */
const ANALYSIS_AFFECTING_KEYS = [
  'money.baseCurrency',
  'money.multiCurrency',
  'money.fxPolicy',
  'budget.enabled',
  'budget.period',
  'budget.items',
  'analysis.refundPolicy',
  'analysis.baselineWindow',
  'analysis.coldStartMinDays',
  'analysis.recurringAmortize',
  'analysis.fixedExpenseWhitelist',
  'analysis.futureDateToleranceDays',
  'analysis.fixedExpenseWhitelist',
  'push.maxDailyAdvice',
] as const;

export function configVersionOf(draft: Record<string, unknown>): string {
  const relevant = ANALYSIS_AFFECTING_KEYS.map((key) => [key, getByPath(draft, key)]);
  return shortHash(JSON.stringify(relevant));
}

export function toAppSettings(draft: Record<string, unknown>): AppSettings {
  const domain = toDomainConfig(draft);
  const quiet = getByPath(draft, 'push.quietHours');
  const quietHours: [string, string] =
    Array.isArray(quiet) && quiet.length === 2 ? [String(quiet[0]), String(quiet[1])] : ['22:30', '07:30'];

  return {
    draft,
    domain,
    money: domain.money,
    push: {
      channels: domain.push.channels.length > 0 ? domain.push.channels : ['local_daily_center'],
      time: domain.push.time,
      timezone: domain.push.timezone,
      maxDailyAdvice: domain.push.maxDailyAdvice,
      quietHours,
      noDataNotice: getByPath(draft, 'push.noDataNotice') !== false,
    },
    host: {
      im: String(getByPath(draft, 'host.im') ?? 'none'),
      appId: String(getByPath(draft, 'host.feishuAppId') ?? ''),
      receiveId: String(getByPath(draft, 'push.imRecipient') ?? ''),
      hasCredentials: String(getByPath(draft, 'host.feishuAppId') ?? '') !== '',
    },
    llm: {
      enabled: getByPath(draft, 'llm.enabled') === true,
      provider: String(getByPath(draft, 'llm.provider') ?? 'none'),
      redaction: String(getByPath(draft, 'llm.redaction') ?? 'category_only'),
    },
    mail: {
      enabled: getByPath(draft, 'mail.enabled') === true,
      host: String(getByPath(draft, 'mail.imapHost') ?? ''),
      port: Number(getByPath(draft, 'mail.imapPort') ?? 993),
      user: String(getByPath(draft, 'mail.user') ?? ''),
      mailbox: String(getByPath(draft, 'mail.mailbox') ?? 'INBOX') || 'INBOX',
      senderFilter: String(getByPath(draft, 'mail.senderFilter') ?? ''),
      lookbackDays: Number(getByPath(draft, 'mail.lookbackDays') ?? 7),
      // 出站：每天随日报发一封「账单信息 + 建议」汇总邮件
      smtpHost:
        String(getByPath(draft, 'mail.smtpHost') ?? '') ||
        deriveSmtpHost(String(getByPath(draft, 'mail.imapHost') ?? '')),
      smtpPort: Number(getByPath(draft, 'mail.smtpPort') ?? 465),
      digestEnabled: getByPath(draft, 'mail.digestEnabled') === true,
      notifyTo: String(getByPath(draft, 'mail.notifyTo') ?? ''),
      configured:
        String(getByPath(draft, 'mail.imapHost') ?? '') !== '' && String(getByPath(draft, 'mail.user') ?? '') !== '',
    },
    budget: domain.budget,
    configVersion: configVersionOf(draft),
  };
}

export function runKeyOf(localDate: string, settings: AppSettings): string {
  return `${localDate}:${RULESET_VERSION}:${settings.configVersion}`;
}

export { CONFIG_SCHEMA_VERSION };

/**
 * 把"消费通知邮件"变成账单。
 *
 * 与其他导入方式的区别：这是唯一**无人值守**的来源——不需要导出、不需要解压密码。
 * 因此这里比 CSV 导入更保守：
 *  - 邮件里必须有明确金额与交易关键词才算数，抽不到就原样留着并说明原因；
 *  - 用邮件 Message-ID 作幂等键（同一封邮件重复处理不会重复记账）；
 *  - 抽不到时间时才用邮件时间兜底，并在备注里标出来，方便回溯。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Bill } from '../domain/types.ts';
import { validateBill, type BillInput } from '../domain/bill.ts';
import { suggestCategory, type CategoryRule } from '../domain/category.ts';
import {
  parseNotification,
  type NotificationParseResult,
  type NotificationTemplate,
} from '../infra/importer/notification.ts';
import { parseEml, type ParsedEmail } from '../infra/importer/eml.ts';
import type { BillRepo } from '../infra/db/billRepo.ts';
import type { CategoryRepo } from '../infra/db/categoryRepo.ts';
import type { AppSettings } from './settings.ts';

export interface NotificationDeps {
  bills: BillRepo;
  categories: CategoryRepo;
}

export interface ImportNotificationArgs {
  email: ParsedEmail;
  settings: AppSettings;
  templates?: readonly NotificationTemplate[];
  /** 邮件时间缺失时的兜底"现在" */
  now?: Date;
}

export interface NotificationImportResult {
  status: 'imported' | 'duplicate' | 'unmatched' | 'failed';
  reason?: string;
  billId?: string;
  parsed?: NotificationParseResult;
}

/**
 * 没有 Message-ID 时，用主题+正文算一个稳定键。
 * 刻意**不含日期**：粘贴正文时日期就是"现在"，含日期会导致每次粘贴都被当成新账单。
 * 代价是：正文完全相同的两笔消费会被去重成一笔——这比"误建重复账单"好得多，
 * 而且真实通知几乎都带时间，正文本身就会不同。
 */
function syntheticRef(email: ParsedEmail): string {
  const hash = createHash('sha256').update(`${email.subject}\n${email.textBody}`).digest('hex');
  return `eml:${hash.slice(0, 32)}`;
}

export function importNotificationEmail(
  deps: NotificationDeps,
  args: ImportNotificationArgs,
): NotificationImportResult {
  const { email, settings } = args;
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();

  const parsed = parseNotification({
    subject: email.subject,
    body: email.textBody,
    emailDate: email.date ?? nowIso,
    timeZone: settings.push.timezone,
    currency: settings.money.baseCurrency,
    templates: args.templates,
  });

  if (!parsed.matched || !parsed.fields) {
    return { status: 'unmatched', reason: parsed.reason, parsed };
  }

  const fields = parsed.fields;
  const rules: CategoryRule[] = deps.categories.listRules();
  const suggestion = suggestCategory(
    { merchant: fields.merchant, note: email.subject, amountMinor: fields.amountMinor, currency: fields.currency },
    rules,
  );

  const noteParts = [email.subject.trim()].filter((s) => s !== '');
  if (fields.cardTail) noteParts.push(`卡尾号 ${fields.cardTail}`);
  if (fields.occurredAtFromEmail) noteParts.push('时间取自邮件，非通知正文');
  noteParts.push(`自动解析(置信度 ${parsed.confidence})`);

  const input: BillInput = {
    billId: randomUUID(),
    amountMinor: fields.amountMinor,
    currency: fields.currency,
    direction: fields.direction,
    categoryId: suggestion?.categoryId ?? null,
    occurredAt: fields.occurredAt,
    merchant: fields.merchant,
    paymentMethod: fields.cardTail ? `卡尾号 ${fields.cardTail}` : null,
    note: noteParts.join(' · ').slice(0, 200),
    source: 'api',
    sourceRef: email.messageId ?? syntheticRef(email),
    status: 'normal',
    tags: ['邮件通知'],
  };

  const validation = validateBill(input, {
    analysis: settings.domain.analysis,
    now: nowIso,
    knownCategoryIds: deps.categories.list().map((c) => c.categoryId),
  });
  if (!validation.ok || !validation.bill) {
    return {
      status: 'failed',
      reason: validation.hardIssues.map((i) => i.message).join('；') || '校验未通过',
      parsed,
    };
  }

  const inserted = deps.bills.insertIfNew(validation.bill);
  if (inserted === 'duplicate') {
    return { status: 'duplicate', reason: '这封邮件的通知已经记过账了', parsed };
  }
  return { status: 'imported', parsed, billId: validation.bill.billId };
}

export function importNotificationFile(
  deps: NotificationDeps,
  args: { fileName: string; content: Uint8Array; settings: AppSettings; templates?: readonly NotificationTemplate[]; now?: Date },
): NotificationImportResult {
  try {
    const email = parseEml(args.content);
    return importNotificationEmail(deps, {
      email,
      settings: args.settings,
      templates: args.templates,
      now: args.now,
    });
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 直接粘贴通知正文就记账。
 * 这是**操作成本最低**的入口：不用导出 .eml（很多客户端只能导出 .msg），
 * 短信、App 推送、邮件正文复制过来都一样能用。
 */
export function importNotificationText(
  deps: NotificationDeps,
  args: { text: string; settings: AppSettings; subject?: string; templates?: readonly NotificationTemplate[]; now?: Date },
): NotificationImportResult {
  const now = args.now ?? new Date();
  const email: ParsedEmail = {
    subject: args.subject ?? '粘贴的通知',
    from: '',
    date: now.toISOString(),
    messageId: null,
    textBody: args.text,
    usedHtml: false,
    attachments: [],
    charsetUsed: 'utf-8',
  };
  return importNotificationEmail(deps, { email, settings: args.settings, templates: args.templates, now });
}

/** 界面上"贴一段通知正文试试能不能解析"用 */
export function previewNotification(args: {
  subject: string;
  body: string;
  settings: AppSettings;
  templates?: readonly NotificationTemplate[];
  now?: Date;
}): NotificationParseResult {
  const now = args.now ?? new Date();
  return parseNotification({
    subject: args.subject,
    body: args.body,
    emailDate: now.toISOString(),
    timeZone: args.settings.push.timezone,
    currency: args.settings.money.baseCurrency,
    templates: args.templates,
  });
}

export type { Bill };

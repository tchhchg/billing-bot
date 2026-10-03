/**
 * 邮件抓取用例：连邮箱 → 取最近 N 天的邮件 → 逐封当"消费通知"解析 → 记账。
 *
 * 幂等靠邮件 Message-ID（复用 importNotifications 的机制），
 * 所以**不需要改动你的邮箱状态**（不标已读、不移动、不删除）——
 * 重复扫描同一批邮件也不会产生重复账单。
 */
import { addDays, todayLocal } from '../domain/analysis/period.ts';
import { parseEml } from '../infra/importer/eml.ts';
import { MailClientUnavailableError, type MailClient } from '../infra/mail/imapClient.ts';
import { importNotificationEmail, importNotificationText, previewNotification, type NotificationImportResult } from './importNotifications.ts';
import { isOwnDigest, looksLikeAppNotice, parseAppNotice } from './parseNotice.ts';
import type { AppSettings } from './settings.ts';
import type { BillRepo } from '../infra/db/billRepo.ts';
import type { CategoryRepo } from '../infra/db/categoryRepo.ts';

export interface MailDeps {
  bills: BillRepo;
  categories: CategoryRepo;
}

export interface MailFetchSummary {
  ok: boolean;
  /** 未启用 / 未配置 / 依赖缺失 / 连接失败时给出原因 */
  reason?: string;
  sinceDate: string;
  /** 自家汇总邮件（回到同一邮箱）被跳过的封数 */
  skippedOwn: number;
  /** 其中属于"应用通知转发"的封数（支付宝/银行 App/拼多多等） */
  notices: number;
  fetched: number;
  imported: number;
  duplicate: number;
  unmatched: number;
  failed: number;
  details: Array<{
    subject: string;
    status: NotificationImportResult['status'];
    reason?: string;
    amountText?: string;
    merchant?: string | null;
    occurredAt?: string;
  }>;
}

export interface FetchMailArgs {
  client: MailClient;
  deps: MailDeps;
  settings: AppSettings;
  /** IMAP 授权码（从密钥文件读取，不进配置） */
  password: string;
  now?: Date;
  /** 单次最多取几封 */
  maxMessages?: number;
  /** 只预览不写库 */
  dryRun?: boolean;
}

export async function fetchAndImportMail(args: FetchMailArgs): Promise<MailFetchSummary> {
  const now = args.now ?? new Date();
  const mail = args.settings.mail;
  const sinceDate = addDays(todayLocal(args.settings.push.timezone, now.getTime()), -Math.max(1, mail.lookbackDays));

  const empty: MailFetchSummary = {
    ok: false,
    sinceDate,
    skippedOwn: 0,
    notices: 0,
    fetched: 0,
    imported: 0,
    duplicate: 0,
    unmatched: 0,
    failed: 0,
    details: [],
  };

  if (!mail.enabled) return { ...empty, reason: '未启用邮件抓取（设置里打开「自动抓取消费通知邮件」）' };
  if (!mail.configured) return { ...empty, reason: '邮件抓取缺少服务器或账号配置' };
  if (args.password.trim() === '') return { ...empty, reason: '缺少邮箱授权码（设置里填写，只存本机密钥文件）' };

  let messages;
  try {
    messages = await args.client.fetchSince({
      host: mail.host,
      port: mail.port,
      secure: mail.port !== 143,
      user: mail.user,
      password: args.password,
      mailbox: mail.mailbox,
      sinceDate,
      senderFilter: mail.senderFilter,
      maxMessages: args.maxMessages ?? 200,
    });
  } catch (error) {
    if (error instanceof MailClientUnavailableError) return { ...empty, reason: error.message };
    return { ...empty, reason: `连接邮箱失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const summary: MailFetchSummary = { ...empty, ok: true, fetched: messages.length };

  for (const message of messages) {
    let email;
    try {
      email = parseEml(message.source);
    } catch (error) {
      summary.failed += 1;
      summary.details.push({
        subject: `(uid ${message.uid} 解析失败)`,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    // ⚠️ 绝不能把自己的汇总邮件当成账单：它会回到同一个邮箱，正文里还带着金额
    if (isOwnDigest(email.subject)) {
      summary.skippedOwn += 1;
      continue;
    }

    // 先分流：SmsForwarder 的「应用通知转发」与银行短信转发是两种格式，解析路径不同
    const noticeBody = email.textBody ?? '';
    const notice = looksLikeAppNotice(email.subject, noticeBody)
      ? parseAppNotice({ subject: email.subject, body: noticeBody, settings: args.settings, now })
      : null;

    if (notice !== null) {
      summary.notices += 1;
      if (!notice.recognized) {
        // 认不出金额也**不丢**：如实报告，原文保留在邮件里可回溯（插件侧不要过滤，就是为了这一刻）
        summary.unmatched += 1;
        summary.details.push({
          subject: email.subject,
          status: 'unmatched',
          reason: `应用通知（${notice.channel}）未识别出金额：${notice.content.slice(0, 60)}`,
        });
        continue;
      }
      const amountText = (notice.amountMinor! / 100).toFixed(2);
      if (args.dryRun) {
        summary.imported += 1;
        summary.details.push({
          subject: email.subject,
          status: 'imported',
          reason: `预览模式，未写入（${notice.channel}）`,
          amountText,
          merchant: notice.channel,
          occurredAt: notice.occurredAt ?? undefined,
        });
        continue;
      }
      const imported = importNotificationText(
        { bills: args.deps.bills, categories: args.deps.categories },
        { text: notice.content, subject: `${notice.channel} ${notice.title}`, settings: args.settings, now },
      );
      if (imported.status === 'imported') summary.imported += 1;
      else if (imported.status === 'duplicate') summary.duplicate += 1;
      else summary.unmatched += 1;
      summary.details.push({
        subject: email.subject,
        status: imported.status,
        reason: imported.status === 'duplicate' ? '这笔已记过账' : undefined,
        amountText,
        merchant: notice.channel,
        occurredAt: notice.occurredAt ?? undefined,
      });
      continue;
    }

    if (args.dryRun) {
      // 预览模式必须**完全不碰数据库**：只做解析，不做去重查询、不写库。
      const preview = previewNotification({
        subject: email.subject,
        body: email.textBody,
        settings: args.settings,
        now,
      });
      if (preview.matched) {
        summary.imported += 1;
        summary.details.push({
          subject: email.subject,
          status: 'imported',
          reason: '预览模式，未写入',
          amountText: preview.fields?.amountText,
          merchant: preview.fields?.merchant ?? null,
          occurredAt: preview.fields?.occurredAt,
        });
      } else {
        summary.unmatched += 1;
      }
      continue;
    }

    const result = importNotificationEmail(
      { bills: args.deps.bills, categories: args.deps.categories },
      { email, settings: args.settings, now },
    );
    switch (result.status) {
      case 'imported':
        summary.imported += 1;
        break;
      case 'duplicate':
        summary.duplicate += 1;
        break;
      case 'unmatched':
        summary.unmatched += 1;
        break;
      default:
        summary.failed += 1;
    }
    // 只记录"有信息量"的条目，避免 detail 里塞满没用的营销邮件
    if (result.status !== 'duplicate' && result.status !== 'unmatched') {
      summary.details.push({
        subject: email.subject,
        status: result.status,
        reason: result.reason,
        amountText: result.parsed?.fields?.amountText,
        merchant: result.parsed?.fields?.merchant ?? null,
        occurredAt: result.parsed?.fields?.occurredAt,
      });
    }
  }

  return summary;
}

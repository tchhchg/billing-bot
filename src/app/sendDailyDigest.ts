/**
 * 每日汇总邮件：把「账单信息 + 建议」合成一封，发到已绑定邮箱。
 *
 * 三条硬规则（按用户确认的口径）：
 *   1. 只随日报发**一封**（不做逐条实时轰炸）；
 *   2. 发送失败**不丢内容**：进"待发队列"，下次日报时自动重试补发；
 *   3. 失败必须**显式可见**：界面上出告警、邮件正文里也写明上次失败原因。
 */
import { deriveSmtpHost, type EmailTransport } from '../channels/email.ts';
import type { AdviceItem, AdviceItemRepo } from '../infra/db/adviceItemRepo.ts';
import type { AppSettings } from './settings.ts';

export interface DigestDeps {
  items: AdviceItemRepo;
  /** 可注入：测试用假实现，生产用真实 SMTP */
  transport: EmailTransport;
}

export interface DigestArgs {
  settings: AppSettings;
  /** 邮箱授权码（密钥文件里的 mail.password） */
  password: string;
  localDate: string;
  /** 日报正文（完整版，含商户名） */
  reportText: string;
  /** 当日新增账单明细行（可选） */
  billLines?: string[];
  now?: Date;
}

export interface DigestResult {
  ok: boolean;
  reason?: string;
  subject?: string;
  /** 本次成功发出的条目数（含补发） */
  sentCount: number;
  /** 队列里被重试的旧失败条目数 */
  retriedCount: number;
}

const KIND_LABEL: Record<AdviceItem['kind'], string> = { bill: '账单信息', advice: '建议' };

export function buildDigestText(args: {
  localDate: string;
  reportText: string;
  billLines: readonly string[];
  queue: readonly AdviceItem[];
  retriedCount: number;
}): string {
  const lines: string[] = [`账单日报 · ${args.localDate}`, '', '【日报】', args.reportText.trim() || '（本次没有生成内容）'];

  if (args.billLines.length > 0) {
    lines.push('', `【今日新增账单】共 ${args.billLines.length} 笔`);
    for (const line of args.billLines) lines.push(`· ${line}`);
  }

  if (args.queue.length > 0) {
    const supplementNote = args.retriedCount > 0 ? `，其中 ${args.retriedCount} 条为上次发送失败后的补发` : '';
    lines.push('', `【账单信息与建议】共 ${args.queue.length} 条${supplementNote}`);
    for (const item of args.queue) {
      const marks = [KIND_LABEL[item.kind]];
      if (item.needsConfirm) marks.push('归属待确认');
      if (item.status === 'failed') marks.push('上次发送失败');
      lines.push(`· [${marks.join(' / ')}] ${item.title}`);
      const body = item.body.trim();
      if (body !== '' && body !== item.title) {
        for (const row of body.split(/\r?\n/).slice(0, 12)) lines.push(`    ${row}`);
      }
    }
  }

  const failed = args.queue.filter((item) => item.status === 'failed');
  if (failed.length > 0) {
    lines.push('', '⚠️ 提示：本封邮件是对上次发送失败的补发，若本次仍失败会在界面里继续告警。');
  }

  lines.push('', '—— 本邮件由 billing-bot 在你自己的电脑上生成，数据仅存本机。');
  return `${lines.join('\n')}\n`;
}

function secureMode(port: number): 'tls' | 'starttls' | 'plain' {
  if (port === 587) return 'starttls';
  if (port === 25 || port === 1025) return 'plain';
  return 'tls';
}

export async function sendDailyDigest(deps: DigestDeps, args: DigestArgs): Promise<DigestResult> {
  const mail = args.settings.mail;

  if (!mail.digestEnabled) return { ok: false, reason: '未开启「每天随日报发一封汇总邮件」', sentCount: 0, retriedCount: 0 };
  if (!mail.configured) return { ok: false, reason: '邮件未配置完整（缺 IMAP 服务器或邮箱账号）', sentCount: 0, retriedCount: 0 };
  if (args.password.trim() === '') return { ok: false, reason: '缺少邮箱授权码', sentCount: 0, retriedCount: 0 };
  const host = mail.smtpHost !== '' ? mail.smtpHost : deriveSmtpHost(mail.host);
  if (host === '') return { ok: false, reason: '无法确定 SMTP 发信服务器', sentCount: 0, retriedCount: 0 };

  const to = mail.notifyTo.trim() !== '' ? mail.notifyTo.trim() : mail.user;
  if (to === '') return { ok: false, reason: '没有收件人（邮箱账号为空且未填收件人）', sentCount: 0, retriedCount: 0 };

  // 队列 = 待发 + 上次失败（失败的要补发，这正是"恢复后补发"）
  const queue = deps.items.listQueued();
  const retriedCount = queue.filter((item) => item.status === 'failed').length;
  const subject = `账单日报 · ${args.localDate}`;
  const text = buildDigestText({
    localDate: args.localDate,
    reportText: args.reportText,
    billLines: args.billLines ?? [],
    queue,
    retriedCount,
  });

  const now = args.now ?? new Date();
  try {
    await deps.transport.send({
      host,
      port: mail.smtpPort,
      secure: secureMode(mail.smtpPort),
      user: mail.user,
      password: args.password,
      from: mail.user,
      to,
      subject,
      text,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // 失败：条目留在队列里并标记原因，界面上显式告警
    deps.items.markFailed(
      queue.map((item) => item.itemId),
      detail,
      now.toISOString(),
    );
    return { ok: false, reason: `发送失败：${detail}`, subject, sentCount: 0, retriedCount };
  }

  deps.items.markSent(
    queue.map((item) => item.itemId),
    now.toISOString(),
  );
  return { ok: true, subject, sentCount: queue.length, retriedCount };
}

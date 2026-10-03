/**
 * 「条目」归档：凡是收到的账单信息、以及想要提出的建议，都先落到一个统一落点，
 * 再随日报汇总发到已绑定邮箱。
 *
 * 归类规则（按用户确认的口径）：
 *   · 能解析出金额+时间 → 当「账单信息」，并真的入账（bill 表）
 *   · 解析不出来       → 当「建议」处理，**标注"待确认"**（不静默丢弃、不反复追问）
 *   · 明确指定 kind    → 按指定处理；指定为账单但解析不出来 → 仍然存档 + 标待确认
 */
import { randomUUID } from 'node:crypto';
import { todayLocal } from '../domain/analysis/period.ts';
import { importNotificationText, previewNotification, type NotificationImportResult } from './importNotifications.ts';
import type { AdviceItem, AdviceItemRepo, ItemKind, ItemSource } from '../infra/db/adviceItemRepo.ts';
import type { AppSettings } from './settings.ts';
import type { BillRepo } from '../infra/db/billRepo.ts';
import type { CategoryRepo } from '../infra/db/categoryRepo.ts';

export interface RecordItemDeps {
  items: AdviceItemRepo;
  bills: BillRepo;
  categories: CategoryRepo;
}

export interface RecordItemArgs {
  text: string;
  /** auto（默认，自动判断）| bill | advice */
  kind?: 'auto' | ItemKind;
  source?: ItemSource;
  title?: string;
  settings: AppSettings;
  now?: Date;
}

export interface RecordItemResult {
  ok: boolean;
  kind: ItemKind;
  needsConfirm: boolean;
  itemId: string | null;
  message: string;
  bill?: NotificationImportResult;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? text;
  return line.trim();
}

export function recordItem(deps: RecordItemDeps, args: RecordItemArgs): RecordItemResult {
  const text = args.text.trim();
  const now = args.now ?? new Date();
  const localDate = todayLocal(args.settings.push.timezone, now.getTime());

  if (text === '') {
    return { ok: false, kind: 'advice', needsConfirm: false, itemId: null, message: '内容为空，没有可归档的东西' };
  }

  const requested = args.kind ?? 'auto';
  let kind: ItemKind = requested === 'bill' ? 'bill' : 'advice';
  let needsConfirm = false;
  let bill: NotificationImportResult | undefined;

  if (requested === 'auto') {
    // 先当"消费通知"试解析：能有金额+时间，就是账单信息
    const preview = previewNotification({ subject: args.title ?? '', body: text, settings: args.settings, now });
    if (preview.matched) {
      kind = 'bill';
    } else {
      // 判断不出归属 → 按约定当建议处理，并标注待确认
      kind = 'advice';
      needsConfirm = true;
    }
  }

  if (kind === 'bill') {
    bill = importNotificationText(
      { bills: deps.bills, categories: deps.categories },
      { text, subject: args.title, settings: args.settings, now },
    );
    if (bill.status !== 'imported' && bill.status !== 'duplicate') {
      // 指定/判定为账单信息，却解析不出金额或时间：仍然存档，标待确认（不丢内容）
      needsConfirm = true;
    }
  }

  const iso = now.toISOString();
  const item: AdviceItem = {
    itemId: randomUUID(),
    kind,
    title: (args.title?.trim() || firstLine(text)).slice(0, 120),
    body: text,
    source: args.source ?? 'agent',
    localDate,
    needsConfirm,
    status: 'pending',
    sentAt: null,
    sendError: null,
    billId: bill?.billId ?? null,
    createdAt: iso,
    updatedAt: iso,
  };
  deps.items.insert(item);

  const kindText = kind === 'bill' ? '账单信息' : '建议';
  const parts = [`已归类为「${kindText}」`];
  if (bill) {
    parts.push(
      bill.status === 'imported'
        ? '并已记入账单'
        : bill.status === 'duplicate'
          ? '（这笔已记过账，未重复入账）'
          : `但未能解析成金额/时间（${bill.reason ?? '原因未知'}）`,
    );
  }
  if (needsConfirm) parts.push('已标注「待确认」');
  parts.push('将随下一条日报汇总发到邮箱');

  return { ok: true, kind, needsConfirm, itemId: item.itemId, message: parts.join('，'), bill };
}

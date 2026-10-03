/**
 * inbox 投递箱：你只管把账单文件丢进目录，识别/去重/入库/归档全自动。
 *
 * 为什么不直接连支付宝/微信拉数据：个人拿不到它们的开放接口，且导出文件的解压密码
 * 推送到另一个 App 里，链路本身就要求"人参与一次"。所以现实的最优解是：
 * 把"人工参与"压缩成"把附件拖进一个文件夹"，其余全部自动化。
 *
 * 目录结构（默认在数据目录下）：
 *   inbox/          待处理（你把文件丢这里）
 *   inbox/done/     处理成功（按时间戳改名归档，便于回溯）
 *   inbox/failed/   处理失败（原文件保留，方便重试）
 *   inbox.log       每次扫描的结果（JSONL，可读可审计）
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { importBillFile, type ImportReport } from './importBills.ts';
import { importNotificationFile, importNotificationText } from './importNotifications.ts';
import type { AppSettings } from './settings.ts';
import type { BillRepo } from '../infra/db/billRepo.ts';
import type { CategoryRepo } from '../infra/db/categoryRepo.ts';
import type { ImportRepo } from '../infra/db/importRepo.ts';
import { localDateOf } from '../domain/analysis/period.ts';

export const SUPPORTED_EXTENSIONS = ['.csv', '.txt'] as const;
/** 邮件通知：唯一的"无人值守"来源（不需要导出、不需要解压密码） */
export const EMAIL_EXTENSION = '.eml';

export interface InboxDeps {
  bills: BillRepo;
  categories: CategoryRepo;
  imports: ImportRepo;
  settings: () => AppSettings;
}

export interface InboxOptions {
  /** 投递箱目录；不传则用 <dataDir>/inbox */
  dir: string;
  /** 单次最多处理几个文件，防止一次丢几千个把界面卡住 */
  maxFiles?: number;
  /** 处理完是否归档（默认 true） */
  archive?: boolean;
  /** 只扫描、不写库（预览用） */
  dryRun?: boolean;
  now?: () => Date;
}

export type InboxFileStatus = 'imported' | 'already-imported' | 'skipped' | 'failed';

export interface InboxFileResult {
  fileName: string;
  status: InboxFileStatus;
  reason?: string;
  report?: ImportReport;
  movedTo?: string;
}

export interface InboxScanResult {
  scannedAt: string;
  inboxDir: string;
  /** 目录里发现的文件总数（可能大于本次处理数） */
  found: number;
  processed: number;
  imported: number;
  alreadyImported: number;
  skipped: number;
  failed: number;
  results: InboxFileResult[];
  /** 今天是否已经导入过账单（含之前批次），用于日报里的"该导账单了"提醒 */
  importedToday: boolean;
}

function ensureDirs(dir: string): { inbox: string; done: string; failed: string } {
  const done = join(dir, 'done');
  const failed = join(dir, 'failed');
  for (const d of [dir, done, failed]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  return { inbox: dir, done, failed };
}

/** 带时间戳的归档名，避免同名文件互相覆盖 */
function archiveName(now: Date, fileName: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `${stamp}-${basename(fileName)}`;
}

function move(from: string, toDir: string, name: string): string | null {
  try {
    const target = join(toDir, name);
    renameSync(from, target);
    return target;
  } catch {
    return null;
  }
}

function appendLog(dir: string, line: Record<string, unknown>): void {
  try {
    appendFileSync(join(dir, 'inbox.log'), `${JSON.stringify(line)}\n`, 'utf8');
  } catch {
    // 日志写不了不影响导入本身
  }
}

/** 今天是否已经有导入批次（用本机时区判断"今天"） */
export function hasImportedToday(deps: Pick<InboxDeps, 'imports'>, timeZone: string, nowMs: number): boolean {
  const today = localDateOf(nowMs, timeZone);
  return deps.imports
    .listBatches(50)
    .some((batch) => localDateOf(Date.parse(batch.createdAt), timeZone) === today);
}

export function scanInbox(deps: InboxDeps, options: InboxOptions): InboxScanResult {
  const now = options.now ?? ((): Date => new Date());
  const nowDate = now();
  const settings = deps.settings();
  const dirs = ensureDirs(options.dir);
  const archive = options.archive ?? true;
  const maxFiles = options.maxFiles ?? 20;

  let entries: string[] = [];
  try {
    entries = readdirSync(dirs.inbox).filter((name) => {
      const full = join(dirs.inbox, name);
      try {
        return statSync(full).isFile();
      } catch {
        return false;
      }
    });
  } catch (error) {
    return {
      scannedAt: nowDate.toISOString(),
      inboxDir: options.dir,
      found: 0,
      processed: 0,
      imported: 0,
      alreadyImported: 0,
      skipped: 0,
      failed: 1,
      results: [
        {
          fileName: '(目录不可读)',
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
      importedToday: hasImportedToday(deps, settings.push.timezone, nowDate.getTime()),
    };
  }

  // 忽略我们自己的辅助文件与子目录
  const candidates = entries.filter((name) => !name.startsWith('.') && name !== 'inbox.log').sort();
  const batch = candidates.slice(0, maxFiles);

  const results: InboxFileResult[] = [];
  let imported = 0;
  let alreadyImported = 0;
  let skipped = 0;
  let failed = 0;

  for (const fileName of batch) {
    const full = join(dirs.inbox, fileName);
    const ext = extname(fileName).toLowerCase();

    if (ext === '.zip') {
      skipped += 1;
      results.push({
        fileName,
        status: 'skipped',
        reason: '这是压缩包。请先解压出 CSV 再放进来（解压密码在支付宝/微信 App 的消息里，不在邮件里）',
      });
      continue;
    }
    if (ext === EMAIL_EXTENSION) {
      if (options.dryRun) {
        results.push({ fileName, status: 'skipped', reason: '预览模式，未实际导入' });
        continue;
      }
      try {
        const outcome = importNotificationFile(
          { bills: deps.bills, categories: deps.categories },
          { fileName, content: readFileSync(full), settings, now: nowDate },
        );
        if (outcome.status === 'imported') {
          imported += 1;
          const moved = archive ? move(full, dirs.done, archiveName(nowDate, fileName)) : null;
          const p = outcome.parsed?.fields;
          results.push({
            fileName,
            status: 'imported',
            reason: `识别为消费通知：${p ? `${p.amountText} 元 · ${p.merchant ?? '未识别商户'} · ${p.direction === 'income' ? '收入' : '支出'}` : ''}（置信度 ${outcome.parsed?.confidence ?? 0}）`,
            movedTo: moved ?? undefined,
          });
        } else if (outcome.status === 'duplicate') {
          alreadyImported += 1;
          const moved = archive ? move(full, dirs.done, archiveName(nowDate, fileName)) : null;
          results.push({ fileName, status: 'already-imported', reason: outcome.reason, movedTo: moved ?? undefined });
        } else {
          // 解析不出金额或不是交易通知：**留在原地**，让用户能自己看一眼再决定
          skipped += 1;
          results.push({ fileName, status: 'skipped', reason: `未识别：${outcome.reason ?? '未知原因'}` });
        }
      } catch (error) {
        failed += 1;
        const moved = archive ? move(full, dirs.failed, archiveName(nowDate, fileName)) : null;
        results.push({
          fileName,
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
          movedTo: moved ?? undefined,
        });
      }
      continue;
    }
    if (!SUPPORTED_EXTENSIONS.includes(ext as (typeof SUPPORTED_EXTENSIONS)[number])) {
      skipped += 1;
      results.push({ fileName, status: 'skipped', reason: `不支持的文件类型：${ext || '(无扩展名)'}，只认 CSV/TXT/EML` });
      continue;
    }

    if (options.dryRun) {
      results.push({ fileName, status: 'skipped', reason: '预览模式，未实际导入' });
      continue;
    }

    // .txt 智能分流：先按"消费通知正文"试（它的判定很严格：必须同时有交易关键词和金额），
    // 不成立再按 CSV 解析。这样用户把通知正文存成 txt 丢进来也能用。
    if (ext === '.txt') {
      try {
        const text = readFileSync(full, 'utf8');
        const asNotice = importNotificationText(
          { bills: deps.bills, categories: deps.categories },
          { text, settings, now: nowDate },
        );
        if (asNotice.status === 'imported') {
          imported += 1;
          const moved = archive ? move(full, dirs.done, archiveName(nowDate, fileName)) : null;
          const p = asNotice.parsed?.fields;
          results.push({
            fileName,
            status: 'imported',
            reason: `按通知正文识别：${p ? `${p.amountText} 元 · ${p.merchant ?? '未识别商户'}` : ''}（置信度 ${asNotice.parsed?.confidence ?? 0}）`,
            movedTo: moved ?? undefined,
          });
          continue;
        }
        if (asNotice.status === 'duplicate') {
          alreadyImported += 1;
          const moved = archive ? move(full, dirs.done, archiveName(nowDate, fileName)) : null;
          results.push({ fileName, status: 'already-imported', reason: asNotice.reason, movedTo: moved ?? undefined });
          continue;
        }
        // 不是通知 → 落到下面的 CSV 分支继续处理
      } catch {
        // 读不了就交给下面按单字节处理，让它自然报错
      }
    }

    try {
      const content = readFileSync(full);
      const report = importBillFile(
        { bills: deps.bills, categories: deps.categories, imports: deps.imports },
        {
          fileName,
          content,
          baseCurrency: settings.money.baseCurrency,
          timeZone: settings.push.timezone,
          analysis: settings.domain.analysis,
          now: nowDate,
        },
      );

      if (report.alreadyImported) {
        alreadyImported += 1;
        const moved = archive ? move(full, dirs.done, archiveName(nowDate, fileName)) : null;
        results.push({
          fileName,
          status: 'already-imported',
          reason: '这个文件之前已经导入过（文件指纹相同）',
          report,
          movedTo: moved ?? undefined,
        });
      } else if (report.okCount === 0 && report.failedCount > 0) {
        failed += 1;
        const moved = archive ? move(full, dirs.failed, archiveName(nowDate, fileName)) : null;
        results.push({
          fileName,
          status: 'failed',
          reason: `${report.failedCount} 行无法解析，已移到 failed/`,
          report,
          movedTo: moved ?? undefined,
        });
      } else {
        imported += 1;
        const moved = archive ? move(full, dirs.done, archiveName(nowDate, fileName)) : null;
        results.push({
          fileName,
          status: 'imported',
          reason: `成功 ${report.okCount} 条，重复 ${report.dupCount}，跳过 ${report.skippedCount}，失败 ${report.failedCount}`,
          report,
          movedTo: moved ?? undefined,
        });
      }
    } catch (error) {
      failed += 1;
      const moved = archive ? move(full, dirs.failed, archiveName(nowDate, fileName)) : null;
      results.push({
        fileName,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        movedTo: moved ?? undefined,
      });
    }
  }

  const result: InboxScanResult = {
    scannedAt: nowDate.toISOString(),
    inboxDir: options.dir,
    found: candidates.length,
    processed: batch.length,
    imported,
    alreadyImported,
    skipped,
    failed,
    results,
    importedToday: imported > 0 || hasImportedToday(deps, settings.push.timezone, nowDate.getTime()),
  };

  if (!options.dryRun && batch.length > 0) {
    appendLog(dirs.inbox, {
      at: result.scannedAt,
      found: result.found,
      processed: result.processed,
      imported,
      alreadyImported,
      skipped,
      failed,
      files: results.map((r) => ({ file: r.fileName, status: r.status, reason: r.reason })),
    });
  }

  return result;
}

/** 列出投递箱里待处理的文件（界面展示用，不触发导入） */
export function listInboxFiles(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => !name.startsWith('.') && name !== 'inbox.log')
      .filter((name) => {
        try {
          return statSync(join(dir, name)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** 日报里那句提醒用的话术 */
export function importReminderLine(inboxDir: string): string {
  return `今天还没有导入账单（把导出的 CSV 丢进 ${inboxDir} 即可自动导入）`;
}

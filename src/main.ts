/**
 * 程序入口：组装配置、数据库、通道、调度与本地界面。
 *
 * 命令行：
 *   node src/main.ts                 # 启动常驻服务（本地界面 + 每日调度）
 *   node src/main.ts --import-inbox  # 只扫一次投递箱然后退出
 *   node src/main.ts --fetch-mail    # 只抓一次邮箱然后退出（加 --dry-run 只看不写）
 *   node src/main.ts --run-daily     # 只跑一次今天的分析然后退出（给计划任务用）
 *   node src/main.ts --catchup 2     # 补跑最近 2 天
 *   node src/main.ts --no-server     # 只要调度器，不开本地界面
 *   node src/main.ts --no-scheduler  # 只要本地界面
 */
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bill } from './domain/types.ts';
import { validateBill } from './domain/bill.ts';
import { toMinor, formatMinor } from './domain/money.ts';
import { parseBillTimestamp, addDays, todayLocal } from './domain/analysis/period.ts';
import { PRESET_CATEGORIES } from './domain/category.ts';
import { createConfigStore, resolveDataDir, type ConfigStore } from './infra/config/store.ts';
import { defaultConfigDraft, getByPath } from './infra/config/schema.ts';
import { openDatabase, type Db } from './infra/db/database.ts';
import { createBillRepo, type BillRepo } from './infra/db/billRepo.ts';
import { createCategoryRepo, type CategoryRepo } from './infra/db/categoryRepo.ts';
import { createRunRepo, type RunRepo } from './infra/db/runRepo.ts';
import { createFxRepo, type FxRepo } from './infra/db/fxRepo.ts';
import { createFeedbackRepo, type FeedbackRepo } from './infra/db/feedbackRepo.ts';
import { createImportRepo, type ImportRepo } from './infra/db/importRepo.ts';
import { createAuditRepo, type AuditRepo } from './infra/db/auditRepo.ts';
import { createLlmRepo, type LlmRepo } from './infra/db/llmRepo.ts';
import { createLocalDailyCenterAdapter } from './channels/localCenter.ts';
import { createFeishuChannel } from './channels/feishu/index.ts';
import type { ChannelAdapter } from './channels/adapter.ts';
import { runDailyAnalysis, catchUp, type DailyDeps, type RunDailyOutcome } from './app/runDailyAnalysis.ts';
import { importBillFile } from './app/importBills.ts';
import { importNotificationText } from './app/importNotifications.ts';
import { fetchAndImportMail, type MailFetchSummary } from './app/fetchMail.ts';
import { createImapClient } from './infra/mail/imapClient.ts';
import { createAdviceItemRepo, type AdviceItemRepo, type AdviceItem } from './infra/db/adviceItemRepo.ts';
import { createSmtpTransport } from './channels/email.ts';
import { recordItem, type RecordItemResult } from './app/recordItem.ts';
import { sendDailyDigest, type DigestResult } from './app/sendDailyDigest.ts';
import { cardDisplayText } from './domain/advice/render.ts';
import {
  hasImportedToday,
  importReminderLine,
  listInboxFiles,
  scanInbox,
  type InboxDeps,
  type InboxScanResult,
} from './app/inbox.ts';
import { toAppSettings, type AppSettings } from './app/settings.ts';
import { createScheduler, type Scheduler } from './infra/scheduler/scheduler.ts';
import { generateToken, startHttpServer, type RunningServer } from './server/http.ts';
import { refreshRates, createPublicFxProvider } from './infra/fx/publicProvider.ts';

export const SECRET_FEISHU_APP_SECRET = 'host.feishuAppSecret';
export const SECRET_MAIL_PASSWORD = 'mail.password';

export interface AppHandle {
  dataDir: string;
  db: Db;
  store: ConfigStore;
  repos: {
    bills: BillRepo;
    categories: CategoryRepo;
    runs: RunRepo;
    fx: FxRepo;
    feedback: FeedbackRepo;
    imports: ImportRepo;
    audit: AuditRepo;
    llm: LlmRepo;
  };
  settings(): AppSettings;
  channels(): ChannelAdapter[];
  runDaily(args?: { date?: string; force?: boolean }): Promise<RunDailyOutcome>;
  catchUp(maxDays: number): Promise<RunDailyOutcome[]>;
  /** 扫描投递箱并导入 */
  importInbox(): InboxScanResult;
  /** 归档一条「账单信息 / 建议」条目 */
  recordItem(input: { text: string; kind?: 'auto' | 'bill' | 'advice'; title?: string; source?: 'agent' | 'manual' }): RecordItemResult;
  /** 条目列表（逐条可查） */
  listItems(limit?: number): AdviceItem[];
  /** 条目统计（待发/失败/待确认），界面据此告警 */
  itemCounts(): ReturnType<AdviceItemRepo['counts']>;
  /** 最近一次汇总邮件结果 */
  lastDigest(): DigestResult | null;
  /** 连邮箱抓取消费通知并记账 */
  fetchMail(options?: { dryRun?: boolean }): Promise<MailFetchSummary>;
  /** 投递箱目录（界面上要显示给用户） */
  inboxDir: string;
  scheduler: Scheduler | null;
  server: RunningServer | null;
  close(): Promise<void>;
}

export interface CreateAppOptions {
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  port?: number;
  withServer?: boolean;
  withScheduler?: boolean;
  token?: string;
  log?: (message: string) => void;
}

export async function createApp(options: CreateAppOptions = {}): Promise<AppHandle> {
  const log = options.log ?? ((message: string): void => console.log(message));
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? resolveDataDir(env);
  const store = createConfigStore(dataDir);
  const db = openDatabase(join(dataDir, 'billing.db'));

  const repos = {
    bills: createBillRepo(db),
    categories: createCategoryRepo(db),
    runs: createRunRepo(db),
    fx: createFxRepo(db),
    feedback: createFeedbackRepo(db),
    imports: createImportRepo(db),
    audit: createAuditRepo(db),
    llm: createLlmRepo(db),
    items: createAdviceItemRepo(db),
  };

  repos.categories.seedPreset(PRESET_CATEGORIES, new Date().toISOString());

  let cachedRaw = '';
  let cachedSettings: AppSettings | null = null;
  const settings = (): AppSettings => {
    const draft = store.load()?.draft ?? defaultConfigDraft();
    const raw = JSON.stringify(draft);
    if (raw !== cachedRaw || cachedSettings === null) {
      cachedSettings = toAppSettings(draft);
      cachedRaw = raw;
    }
    return cachedSettings;
  };

  /**
   * 固定的本地访问令牌：留空则生成一次并写进配置。
   * 为什么必须固定：把界面嵌到别处（如 DSH 左侧栏）时，URL 里的令牌不能每次重启就变。
   * 注意：只有在配置已存在时才写盘——否则"目录里凭空多出 config.json"会让首次引导被跳过。
   */
  const resolveServerToken = (): string => {
    if (options.token !== undefined && options.token !== '') return options.token;
    const draft = store.load()?.draft ?? defaultConfigDraft();
    const existing = String(getByPath(draft, 'server.token') ?? '');
    if (existing !== '') return existing;
    const fresh = generateToken();
    if (store.exists()) {
      store.patch([{ key: 'server.token', value: fresh }]);
      log('[billing-bot] 已生成本地访问令牌并写入配置（设置页可查看）');
    }
    return fresh;
  };

  const resolveServerPort = (): number => {
    if (options.port !== undefined) return options.port;
    const draft = store.load()?.draft ?? defaultConfigDraft();
    const configured = Number(getByPath(draft, 'server.port') ?? 0);
    return Number.isInteger(configured) && configured > 0 ? configured : 0;
  };

  const channels = (): ChannelAdapter[] => {    const current = settings();
    const list: ChannelAdapter[] = [];
    const appSecret = store.getSecret(SECRET_FEISHU_APP_SECRET) ?? '';
    if (current.host.im === 'feishu' && current.host.appId !== '' && appSecret !== '' && current.host.receiveId !== '') {
      list.push(
        createFeishuChannel({
          appId: current.host.appId,
          appSecret,
          receiveId: current.host.receiveId,
          fetchImpl: options.fetchImpl,
        }),
      );
    } else if (current.push.channels.includes('im_card')) {
      list.push(createFeishuChannel({ appId: '', appSecret: '', receiveId: '' }));
    }
    list.push(createLocalDailyCenterAdapter());
    return list;
  };

  const dailyDeps = (): DailyDeps => ({
    bills: repos.bills,
    categories: repos.categories,
    runs: repos.runs,
    feedback: repos.feedback,
    fx: repos.fx,
    channels: channels(),
    log: (m: string): void => log(m),
  });

  const inboxDir = join(dataDir, 'inbox');
  const inboxDeps = (): InboxDeps => ({
    bills: repos.bills,
    categories: repos.categories,
    imports: repos.imports,
    settings,
  });

  const importInbox = (): InboxScanResult => {
    const result = scanInbox(inboxDeps(), { dir: inboxDir });
    if (result.found > 0) {
      log(
        `[inbox] 发现 ${result.found} 个文件：导入 ${result.imported}，已导过 ${result.alreadyImported}，跳过 ${result.skipped}，失败 ${result.failed}`,
      );
    }
    return result;
  };

  /** 连邮箱抓消费通知（无人值守路径）；未启用时立刻返回原因，不做任何网络请求 */
  const fetchMail = async (options2: { dryRun?: boolean } = {}): Promise<MailFetchSummary> => {
    const current = settings();
    const summary = await fetchAndImportMail({
      client: createImapClient(),
      deps: { bills: repos.bills, categories: repos.categories },
      settings: current,
      password: store.getSecret(SECRET_MAIL_PASSWORD) ?? '',
      dryRun: options2.dryRun,
    });
    if (summary.ok) {
      log(
        `[mail] 取回 ${summary.fetched} 封（${summary.sinceDate} 起）：入账 ${summary.imported}，已记过 ${summary.duplicate}，非通知 ${summary.unmatched}，失败 ${summary.failed}`,
      );
    } else if (summary.reason) {
      log(`[mail] 未抓取：${summary.reason}`);
    }
    return summary;
  };

  /** 最近一次汇总邮件的结果：界面据此显式告警（失败必须看得见） */
  const digestResults = new Map<string, DigestResult>();

  const runDaily = async (args: { date?: string; force?: boolean } = {}): Promise<RunDailyOutcome> => {
    const current = settings();
    // 先收投递箱：把用户丢进来的账单文件导入，再基于最新数据做分析
    const inbox = args.date === undefined ? importInbox() : null;

    // 再抓邮箱：消费通知是唯一"无人值守"的来源（未启用时不做任何网络请求）
    if (args.date === undefined && current.mail.enabled) {
      await fetchMail();
    }

    // 多币种且配置了公共汇率源时，先刷新汇率（失败则用本机缓存，保持离线降级）
    if (current.money.multiCurrency && getByPath(current.draft, 'money.fxSource') === 'public_api') {
      const quotes = collectForeignCurrencies(repos.bills);
      if (quotes.length > 0) {
        const result = await refreshRates({
          fxRepo: repos.fx,
          provider: createPublicFxProvider({ fetchImpl: options.fetchImpl }),
          base: current.money.baseCurrency,
          quotes,
          date: args.date ?? todayLocal(current.push.timezone),
        });
        if (!result.ok) log(`[fx] 汇率刷新失败，使用本机缓存：${result.error ?? ''}`);
        if (result.missingQuotes.length > 0) log(`[fx] 仍缺汇率的币种：${result.missingQuotes.join('、')}`);
      }
    }

    // 今天还没导过账单 → 在日报里顺带提一句（把"人忘记导"这件事也解决掉）
    const importedToday = inbox?.importedToday ?? hasImportedToday(inboxDeps(), current.push.timezone, Date.now());
    const extraSummaryLines = importedToday ? [] : [importReminderLine(inboxDir)];

    const outcome = await runDailyAnalysis(dailyDeps(), current, { ...args, extraSummaryLines });

    // 日报之后：把「账单信息 + 建议」汇总成一封邮件发到已绑定邮箱。
    // 失败**不丢内容**——条目留在待发队列，下次日报自动补发，并在界面上显式告警。
    // 跳过（当天已推过且数据没变）时没有新报告——除非还有待发条目，否则不必打扰
    const hasReport = outcome.card !== undefined;
    const queued = repos.items.listQueued().length;
    if (current.mail.digestEnabled && (hasReport || queued > 0)) {
      const categoryNameById = new Map(repos.categories.list().map((c) => [c.categoryId, c.name]));
      const billLines = repos.bills.listByLocalDay(outcome.localDate, current.push.timezone).map((b) => {
        const when = b.occurredAt.slice(11, 16);
        const direction = b.direction === 'income' ? '收入' : '支出';
        const category = b.categoryId !== null ? (categoryNameById.get(b.categoryId) ?? b.categoryId) : '未分类';
        return `${when}  ${direction}  ${formatMinor(b.amountMinor, b.currency)}  ${b.merchant ?? '—'}  ${category}`;
      });
      const digest = await sendDailyDigest(
        { items: repos.items, transport: createSmtpTransport() },
        {
          settings: current,
          password: store.getSecret(SECRET_MAIL_PASSWORD) ?? '',
          localDate: outcome.localDate,
          reportText: outcome.card ? cardDisplayText(outcome.card) : '',
          billLines,
        },
      );
      digestResults.set(outcome.localDate, digest);
      log(
        digest.ok
          ? `[mail] 汇总邮件已发送（${digest.sentCount} 条${digest.retriedCount > 0 ? `，含补发 ${digest.retriedCount} 条` : ''}）`
          : `[mail] 汇总邮件未发送：${digest.reason ?? '未知原因'}`,
      );
    }

    return outcome;
  };

  const scheduler =
    options.withScheduler === false
      ? null
      : createScheduler({
          timeZone: settings().push.timezone,
          time: settings().push.time,
          quietHours: settings().push.quietHours,
          onRun: async (date: string): Promise<string> => {
            const outcome = await runDaily({ date });
            return `${outcome.localDate} ${outcome.status}`;
          },
          onCatchUp: async ({ maxDays }): Promise<void> => {
            await catchUp(dailyDeps(), settings(), { maxDays });
          },
          log,
        });

  const server =
    options.withServer === false
      ? null
      : await startHttpServer(
          {
            token: resolveServerToken(),
            bind: '127.0.0.1',
            configStore: store,
            settings,
            listBills: (filter) =>
              repos.bills.query({
                timeZone: settings().push.timezone,
                fromDate: filter.fromDate,
                toDate: filter.toDate,
                keyword: filter.keyword,
                categoryId: filter.categoryId === '' ? undefined : filter.categoryId,
                limit: 500,
              }),
            listCategories: () => repos.categories.list(),
            counts: () => {
              const all = repos.bills.query({ timeZone: settings().push.timezone, limit: 100000 });
              return {
                bills: repos.bills.count(),
                // 「待补分类」必须是**能清零**的口径：支出里还没归类的笔数。
                // 早先数的是 status==='pending_review'，而收入类账单永远不会被归类，
                // 于是这个数字永远降不到 0 —— 指标在骗人。
                pendingReview: all.filter((b) => b.direction === 'expense' && b.categoryId === null).length,
                runs: repos.runs.listRecent(1000).length,
              };
            },
            latestRun: () => repos.runs.listRecent(1)[0] ?? null,
            listRuns: (limit) => repos.runs.listRecent(limit),
            createBill: (input) => createBillFromForm(repos, settings(), input),
            updateBill: (input) => updateBillFromForm(repos, settings(), input),
            bulkCategorize: (billIds, categoryId) => {
              const now = new Date().toISOString();
              let ok = 0;
              let conflict = 0;
              for (const id of billIds) {
                const current = repos.bills.getById(id);
                if (!current) continue;
                // 归类即确认：分配了分类就等于人工核对过了，把 pending_review 清掉。
                // 否则「待补分类」这个数字永远不会下降（曾经的实际 bug）。
                const confirm = categoryId !== null && current.status === 'pending_review';
                const changed = repos.bills.update(
                  { ...current, categoryId, status: confirm ? 'normal' : current.status, updatedAt: now },
                  current.version,
                );
                if (changed) {
                  ok += 1;
                  repos.audit.append(
                    {
                      billId: id,
                      action: 'update',
                      beforeJson: JSON.stringify({ categoryId: current.categoryId, status: current.status }),
                      afterJson: JSON.stringify({ categoryId, status: confirm ? 'normal' : current.status }),
                    },
                    now,
                  );
                } else {
                  conflict += 1;
                }
              }
              const parts = [`已归类 ${ok} 条`];
              if (conflict > 0) parts.push(`${conflict} 条因并发修改被跳过`);
              if (billIds.length === 0) parts[0] = '没有勾选任何账单';
              return { ok: ok > 0, message: parts.join('，') };
            },
            getBill: (billId) => repos.bills.getById(billId),
            restoreBill: (billId) => {
              const ok = repos.bills.restore(billId);
              if (ok) repos.audit.append({ billId, action: 'restore' }, new Date().toISOString());
              return { ok, message: ok ? '已恢复' : '账单不存在或未被删除' };
            },
            deleteBill: (billId) => {
              const ok = repos.bills.softDelete(billId, new Date().toISOString());
              if (ok) repos.audit.append({ billId, action: 'delete' }, new Date().toISOString());
              return { ok, message: ok ? '已删除（可恢复）' : '账单不存在' };
            },
            importFile: (args) =>
              importBillFile(
                { bills: repos.bills, categories: repos.categories, imports: repos.imports },
                {
                  fileName: args.name,
                  content: args.body,
                  sourceKind: args.kind as never,
                  mappingName: args.mappingName,
                  baseCurrency: settings().money.baseCurrency,
                  timeZone: settings().push.timezone,
                  analysis: settings().domain.analysis,
                },
              ),
            runDailyNow: async () => runDaily({ force: true }),
            inboxDir,
            listInboxFiles: () => listInboxFiles(inboxDir),
            scanInbox: () => importInbox(),
            pasteNotification: (input) =>
              importNotificationText(
                { bills: repos.bills, categories: repos.categories },
                { text: input.text, subject: input.subject, settings: settings() },
              ),
            mailStatus: () => {
              const m = settings().mail;
              return {
                enabled: m.enabled,
                configured: m.configured,
                host: m.host,
                user: m.user,
                mailbox: m.mailbox,
                lookbackDays: m.lookbackDays,
                hasPassword: (store.getSecret(SECRET_MAIL_PASSWORD) ?? '') !== '',
              };
            },
            fetchMail: (input) => fetchMail(input),
            listItems: (limit) => repos.items.listRecent(limit ?? 200),
            itemCounts: () => repos.items.counts(),
            recordItem: (input) =>
              recordItem(
                { items: repos.items, bills: repos.bills, categories: repos.categories },
                {
                  text: input.text,
                  kind: input.kind,
                  source: input.source ?? 'manual',
                  settings: settings(),
                },
              ),
            lastDigest: () => [...digestResults.values()].at(-1) ?? null,
            nextDueAt: () => scheduler?.state().nextDueAt ?? null,
            now: () => new Date(),
          },
          resolveServerPort(),
        );

  return {
    dataDir,
    db,
    store,
    repos,
    settings,
    channels,
    runDaily,
    catchUp: (maxDays: number) => catchUp(dailyDeps(), settings(), { maxDays }),
    importInbox,
    fetchMail,
    inboxDir,
    recordItem: (input) =>
      recordItem(
        { items: repos.items, bills: repos.bills, categories: repos.categories },
        { text: input.text, kind: input.kind, title: input.title, source: input.source ?? 'agent', settings: settings() },
      ),
    listItems: (limit = 200) => repos.items.listRecent(limit),
    itemCounts: () => repos.items.counts(),
    lastDigest: () => [...digestResults.values()].at(-1) ?? null,
    scheduler,
    server,
    async close(): Promise<void> {
      scheduler?.stop();
      await server?.close();
      db.close();
    },
  };
}

/** 表单 → 账单：金额与时间在这里解析，其余校验交给领域层 */
export function createBillFromForm(
  repos: { bills: BillRepo; categories: CategoryRepo; audit: AuditRepo },
  settings: AppSettings,
  input: Record<string, unknown>,
): { ok: boolean; message: string } {
  return writeBillFromForm(repos, settings, input, null);
}

/** 编辑既有账单：带乐观锁，版本不符则拒绝并提示重新打开 */
export function updateBillFromForm(
  repos: { bills: BillRepo; categories: CategoryRepo; audit: AuditRepo },
  settings: AppSettings,
  input: Record<string, unknown>,
): { ok: boolean; message: string } {
  const billId = String(input['billId'] ?? '');
  const existing = repos.bills.getById(billId);
  if (!existing) return { ok: false, message: '账单不存在' };
  const expectedVersion = Number(input['version'] ?? Number.NaN);
  if (!Number.isInteger(expectedVersion)) return { ok: false, message: '缺少版本号，请重新打开编辑页' };
  if (existing.version !== expectedVersion) {
    return { ok: false, message: '这条账单已被修改过，请重新打开编辑页再改（避免覆盖别人的改动）' };
  }
  return writeBillFromForm(repos, settings, input, existing);
}

function writeBillFromForm(
  repos: { bills: BillRepo; categories: CategoryRepo; audit: AuditRepo },
  settings: AppSettings,
  input: Record<string, unknown>,
  existing: Bill | null,
): { ok: boolean; message: string } {
  const currency = String(input['currency'] ?? settings.money.baseCurrency).toUpperCase();
  const amount = Number(String(input['amount'] ?? '').replace(/[¥￥,\s]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: '金额必须是大于 0 的数字' };

  const occurredAt = parseBillTimestamp(String(input['occurredAt'] ?? ''), settings.push.timezone);
  if (!occurredAt) return { ok: false, message: '时间无法解析' };

  const now = new Date().toISOString();
  const candidate = {
    billId: existing?.billId ?? crypto.randomUUID(),
    amountMinor: toMinor(amount, currency),
    currency,
    direction: (String(input['direction'] ?? 'expense') as Bill['direction']) ?? 'expense',
    categoryId: input['categoryId'] ? String(input['categoryId']) : null,
    occurredAt,
    merchant: input['merchant'] ? String(input['merchant']) : null,
    note: input['note'] ? String(input['note']) : null,
    source: existing?.source ?? ('manual' as const),
    sourceRef: existing?.sourceRef ?? null,
    refundOf: existing?.refundOf ?? null,
    status: 'normal' as const,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    deletedAt: existing?.deletedAt ?? null,
  };

  const result = validateBill(candidate, {
    analysis: settings.domain.analysis,
    now,
    knownCategoryIds: repos.categories.list().map((c) => c.categoryId),
  });
  if (!result.ok || !result.bill) {
    return { ok: false, message: result.hardIssues.map((i) => i.message).join('；') || '校验未通过' };
  }

  if (existing) {
    const changed = repos.bills.update(result.bill, existing.version);
    if (!changed) return { ok: false, message: '保存时检测到并发修改，请重新打开编辑页' };
    repos.audit.append(
      { billId: result.bill.billId, action: 'update', beforeJson: JSON.stringify(existing), afterJson: JSON.stringify(result.bill) },
      now,
    );
    return { ok: true, message: '已保存' };
  }

  repos.bills.insert(result.bill);
  repos.audit.append({ billId: result.bill.billId, action: 'create', afterJson: JSON.stringify(result.bill) }, now);
  return { ok: true, message: '已保存' };
}

/** 从现有账单里收集出现过的外币币种（汇率只需要这些） */
function collectForeignCurrencies(bills: BillRepo): string[] {
  const rows = bills.query({ timeZone: 'UTC', limit: 100000 });
  const quotes = new Set<string>();
  for (const bill of rows) quotes.add(bill.currency);
  return [...quotes];
}

// ---------------------------------------------------------------- CLI
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const has = (flag: string): boolean => argv.includes(flag);
  const valueOf = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const app = await createApp({
    withServer: !has('--no-server'),
    withScheduler: !has('--no-scheduler'),
    port: valueOf('--port') ? Number(valueOf('--port')) : undefined,
  });

  console.log(`[billing-bot] 数据目录：${app.dataDir}`);
  console.log(`[billing-bot] 投递箱：${app.inboxDir}（把账单 CSV 丢进去即可自动导入）`);
  if (!app.store.exists()) {
    console.log('[billing-bot] 尚未完成首次引导，请在浏览器里打开下面的地址完成设置：');
  }
  if (app.server) console.log(`[billing-bot] 本地界面：${app.server.url}`);

  if (has('--import-inbox')) {    const result = app.importInbox();
    console.log(
      `[billing-bot] 投递箱：发现 ${result.found} 个文件 → 导入 ${result.imported}，已导过 ${result.alreadyImported}，跳过 ${result.skipped}，失败 ${result.failed}`,
    );
    for (const item of result.results) {
      console.log(`  · ${item.fileName}：${item.status}${item.reason ? ` — ${item.reason}` : ''}`);
    }
  }

  if (has('--fetch-mail')) {
    const summary = await app.fetchMail({ dryRun: has('--dry-run') });
    console.log(`[billing-bot] 邮件抓取：${summary.ok ? '成功' : '未执行'}${summary.reason ? ` — ${summary.reason}` : ''}`);
    console.log(
      `  自 ${summary.sinceDate} 起取回 ${summary.fetched} 封 → 入账 ${summary.imported}，已记过 ${summary.duplicate}，非通知 ${summary.unmatched}，失败 ${summary.failed}`,
    );
    for (const d of summary.details) {
      console.log(
        `  · ${d.subject}：${d.status}${d.amountText ? ` ${d.amountText} 元` : ''}${d.merchant ? ` · ${d.merchant}` : ''}${
          d.reason ? ` — ${d.reason}` : ''
        }`,
      );
    }
  }

  if (has('--add-item')) {
    const text = valueOf('--add-item') ?? '';
    const result = app.recordItem({ text, kind: 'auto', source: 'agent' });
    console.log(`[billing-bot] 条目归档：${result.message}`);
    console.log(`  归类=${result.kind}  待确认=${result.needsConfirm}  id=${result.itemId ?? '—'}`);
    await app.close();
    return;
  }

  if (has('--run-daily')) {
    // 默认**尊重幂等**：同一天已推送过就跳过。
    // 只有显式加 --force 才强制重推——这样"计划任务 + 常驻服务"同时开着也不会各推一条。
    const force = has('--force');
    const explicitDate = valueOf('--date');

    // 关机/休眠错过 21:00 的情况：先补跑昨天。
    // 只在"昨天确实有账单"时补——否则全新安装的第一条消息会是"昨天没有记录"，那是噪音。
    if (!explicitDate) {
      const tz = app.settings().push.timezone;
      const yesterday = addDays(todayLocal(tz), -1);
      const hadBills = app.repos.bills.listByLocalDay(yesterday, tz).length > 0;
      if (hadBills) {
        for (const outcome of await app.catchUp(1)) {
          if (outcome.status !== 'skipped_already_run') {
            console.log(`[billing-bot] 补跑 ${outcome.localDate} → ${outcome.status}`);
          }
        }
      }
    }

    const outcome = await app.runDaily({ force, date: explicitDate });
    console.log(
      `[billing-bot] ${outcome.status} ${outcome.localDate}${outcome.note ? ` ${outcome.note}` : ''}` +
        (force ? '（--force 已强制重算）' : ''),
    );
  } else if (has('--catchup')) {
    const days = Number(valueOf('--catchup') ?? '1');
    const outcomes = await app.catchUp(Number.isFinite(days) ? days : 1);
    console.log(`[billing-bot] 补跑 ${outcomes.length} 天：${outcomes.map((o) => `${o.localDate}=${o.status}`).join(', ')}`);
  }

  if (has('--run-daily') || has('--catchup') || has('--import-inbox') || has('--fetch-mail') || has('--add-item')) {
    await app.close();
    return;
  }

  app.scheduler?.start();

  const shutdown = async (): Promise<void> => {
    console.log('[billing-bot] 正在退出…');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

const isDirectRun =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (isDirectRun) {
  void main().catch((error: unknown) => {
    console.error('[billing-bot] 启动失败：', error);
    process.exit(1);
  });
}

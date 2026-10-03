/**
 * 本地 HTTP 服务（node:http，零依赖）。
 *
 * 安全模型：只监听回环地址 + 一次性令牌（首次用 ?token= 换 HttpOnly Cookie），
 * 目的是防止本机其它进程顺手读你的账单数据。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Bill } from '../domain/types.ts';
import type { Category } from '../domain/category.ts';
import type { ConfigStore } from '../infra/config/store.ts';
import { CONFIG_FIELDS, defaultConfigDraft } from '../infra/config/schema.ts';
import { buildWizardSteps, safeDefaultDraft, submitAnswers } from '../app/onboarding.ts';
import { parseBudgetItems } from '../app/budgetText.ts';
import type { AppSettings } from '../app/settings.ts';
import type { ImportReport } from '../app/importBills.ts';
import type { InboxScanResult } from '../app/inbox.ts';
import type { NotificationImportResult } from '../app/importNotifications.ts';
import type { MailFetchSummary } from '../app/fetchMail.ts';
import type { AdviceItem } from '../infra/db/adviceItemRepo.ts';
import type { RecordItemResult } from '../app/recordItem.ts';
import type { RunDailyOutcome } from '../app/runDailyAnalysis.ts';
import {
  billEditPage,
  billsPage,
  dailyPage,
  dashboardPage,
  esc,
  importPage,
  inboxPage,
  itemsPage,
  layout,
  onboardingPage,
  rulesPage,
  settingsPage,
} from './pages.ts';

export interface ServerDeps {
  token: string;
  bind: string;
  configStore: ConfigStore;
  settings(): AppSettings;
  listBills(filter: { fromDate?: string; toDate?: string; keyword?: string; categoryId?: string | null }): Bill[];
  listCategories(): Category[];
  counts(): { bills: number; pendingReview: number; runs: number };
  latestRun(): RunRecordView | null;
  listRuns(limit: number): RunRecordView[];
  createBill(input: Record<string, unknown>): { ok: boolean; message: string };
  updateBill(input: Record<string, unknown>): { ok: boolean; message: string };
  bulkCategorize(billIds: string[], categoryId: string | null): { ok: boolean; message: string };
  getBill(billId: string): Bill | null;
  restoreBill(billId: string): { ok: boolean; message: string };
  deleteBill(billId: string): { ok: boolean; message: string };
  importFile(args: { name: string; body: Uint8Array; kind?: string; mappingName?: string }): ImportReport;
  inboxDir: string;
  listInboxFiles(): string[];
  scanInbox(): InboxScanResult;
  pasteNotification(input: { text: string; subject?: string }): NotificationImportResult;
  /** 条目：账单信息与建议的统一落点 */
  listItems(limit?: number): AdviceItem[];
  itemCounts(): { total: number; pending: number; failed: number; sent: number; needsConfirm: number };
  recordItem(input: { text: string; kind?: 'auto' | 'bill' | 'advice'; source?: 'agent' | 'manual' }): RecordItemResult;
  lastDigest(): { ok: boolean; reason?: string; subject?: string; sentCount: number; retriedCount: number } | null;
  mailStatus(): {
    enabled: boolean;
    configured: boolean;
    host: string;
    user: string;
    mailbox: string;
    lookbackDays: number;
    hasPassword: boolean;
  };
  fetchMail(options: { dryRun?: boolean }): Promise<MailFetchSummary>;
  runDailyNow(): Promise<RunDailyOutcome>;
  nextDueAt(): number | null;
  now(): Date;
}

export interface RunRecordView {
  localDate: string;
  revision: number;
  pushedAt: string | null;
  channel: string | null;
  pushStatus: string | null;
  metricsJson: string;
  advicesJson: string;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

async function readBody(req: IncomingMessage, limitBytes = 32 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limitBytes) throw new Error('请求体过大');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: string, contentType = 'text/html; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

export function createRequestHandler(deps: ServerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const withToken = (path: string): string => `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(deps.token)}`;

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    try {
      if (path === '/api/health') {
        send(res, 200, JSON.stringify({ ok: true, ruleset: '1.0.0' }), 'application/json');
        return;
      }

      const cookieToken = url.searchParams.get('token') ?? parseCookies(req.headers.cookie)['bb_token'];
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (cookieToken !== deps.token && bearer !== deps.token) {
        send(
          res,
          403,
          layout('需要访问令牌', '<div class="card"><h1>需要访问令牌</h1><p>请在启动日志里找到带 token 的地址再打开。</p></div>', {
            token: '',
          }),
        );
        return;
      }
      if (url.searchParams.get('token') === deps.token) {
        res.setHeader('Set-Cookie', `bb_token=${encodeURIComponent(deps.token)}; HttpOnly; SameSite=Strict; Path=/`);
      }

      // ---------------------------------------------------------- 首页
      if (path === '/' && req.method === 'GET') {
        const settings = deps.settings();
        const latest = deps.latestRun();
        const summary = [
          { label: 'IM 通道', value: settings.host.im === 'none' ? '未启用（仅本地）' : settings.host.im },
          { label: '推送渠道', value: settings.push.channels.join('、') },
          { label: '推送时间', value: `${settings.push.time}（${settings.push.timezone}）` },
          { label: '基础币种', value: settings.money.baseCurrency + (settings.money.multiCurrency ? '（多币种已启用）' : '') },
          { label: '退款口径', value: settings.domain.analysis.refundPolicy },
          { label: '云端模型', value: settings.llm.enabled ? `已启用（${settings.llm.redaction}）` : '关闭' },
        ];
        send(
          res,
          200,
          layout(
            '概览',
            dashboardPage({
              token: deps.token,
              settingsSummary: summary,
              latest,
              counts: deps.counts(),
              nextDueAt: deps.nextDueAt(),
              items: deps.itemCounts(),
              digest: {
                enabled: settings.mail.digestEnabled,
                to: settings.mail.notifyTo.trim() !== '' ? settings.mail.notifyTo : settings.mail.user,
                ok: deps.lastDigest()?.ok ?? null,
                reason: deps.lastDigest()?.reason,
              },
            }),
            { token: deps.token },
          ),
        );
        return;
      }

      // ---------------------------------------------------------- 引导
      if (path === '/onboarding' && req.method === 'GET') {
        const loaded = deps.configStore.load();
        send(
          res,
          200,
          layout(
            '首次引导',
            onboardingPage({
              token: deps.token,
              steps: buildWizardSteps(),
              draft: loaded?.draft ?? defaultConfigDraft(),
              hasSecret: (key) => deps.configStore.getSecret(key) !== null,
            }),
            { token: deps.token },
          ),
        );
        return;
      }
      if (path === '/onboarding' && req.method === 'POST') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        if (form.get('skip') === 'true') {
          deps.configStore.save(safeDefaultDraft());
          redirect(res, withToken('/'));
          return;
        }
        persistSecrets(deps, form);
        const answers = collectAnswers(form, deps.settings().money.baseCurrency);
        const result = submitAnswers(answers);
        if (!result.ok) {
          send(
            res,
            400,
            layout(
              '首次引导',
              onboardingPage({
                token: deps.token,
                steps: buildWizardSteps(),
                draft: result.draft,
                issues: result.issues,
                hasSecret: (key) => deps.configStore.getSecret(key) !== null,
              }),
              { token: deps.token, banner: '有配置项没填对，请修正后重试' },
            ),
          );
          return;
        }
        deps.configStore.save(result.draft);
        redirect(res, withToken('/'));
        return;
      }

      // ---------------------------------------------------------- 设置
      if (path === '/settings' && req.method === 'GET') {
        const loaded = deps.configStore.load();
        send(
          res,
          200,
          layout(
            '设置',
            settingsPage({
              token: deps.token,
              draft: loaded?.draft ?? defaultConfigDraft(),
              hasSecret: (key) => deps.configStore.getSecret(key) !== null,
            }),
            { token: deps.token },
          ),
        );
        return;
      }
      if (path === '/settings' && req.method === 'POST') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        persistSecrets(deps, form);
        const current = deps.configStore.load()?.draft ?? defaultConfigDraft();
        const answers = collectAnswers(form, deps.settings().money.baseCurrency);
        const result = submitAnswers(answers, current);
        if (!result.ok) {
          send(
            res,
            400,
            layout(
              '设置',
              settingsPage({
                token: deps.token,
                draft: result.draft,
                issues: result.issues,
                hasSecret: (key) => deps.configStore.getSecret(key) !== null,
              }),
              { token: deps.token, banner: '有配置项没填对，请修正后重试' },
            ),
          );
          return;
        }
        deps.configStore.save(result.draft);
        redirect(res, withToken('/settings'));
        return;
      }

      if (path === '/rules' && req.method === 'GET') {
        send(res, 200, layout('规则', rulesPage(), { token: deps.token }));
        return;
      }

      // ---------------------------------------------------------- 账单
      if (path === '/bills' && req.method === 'GET') {
        const rawCategory = url.searchParams.get('categoryId') ?? undefined;
        const filter = {
          fromDate: url.searchParams.get('fromDate') ?? undefined,
          toDate: url.searchParams.get('toDate') ?? undefined,
          keyword: url.searchParams.get('keyword') ?? undefined,
          // __none__ 是界面上的"只看未分类"
          categoryId: rawCategory === '__none__' ? null : rawCategory,
        };
        const bills = deps.listBills(filter);
        send(
          res,
          200,
          layout(
            '账单',
            billsPage({
              token: deps.token,
              bills,
              categories: deps.listCategories(),
              filter: {
                fromDate: filter.fromDate ?? '',
                toDate: filter.toDate ?? '',
                keyword: filter.keyword ?? '',
                categoryId: rawCategory ?? '',
              },
              notice: url.searchParams.get('notice') ?? undefined,
            }),
            { token: deps.token },
          ),
        );
        return;
      }
      if (path === '/bills' && req.method === 'POST') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        const result = deps.createBill(Object.fromEntries(form.entries()));
        redirect(
          res,
          withToken(result.ok ? '/bills' : `/bills?notice=${encodeURIComponent(result.message)}`),
        );
        return;
      }
      if (path === '/bills/edit' && req.method === 'GET') {
        const billId = url.searchParams.get('id') ?? '';
        const bill = deps.getBill(billId);
        if (!bill) {
          send(res, 404, layout('未找到', '<div class="card"><h1>账单不存在</h1></div>', { token: deps.token }));
          return;
        }
        send(
          res,
          200,
          layout(
            '编辑账单',
            billEditPage({ token: deps.token, bill, categories: deps.listCategories(), error: url.searchParams.get('error') ?? undefined }),
            { token: deps.token },
          ),
        );
        return;
      }
      if (path === '/bills/edit' && req.method === 'POST') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        const result = deps.updateBill(Object.fromEntries(form.entries()));
        const billId = String(form.get('billId') ?? '');
        redirect(
          res,
          result.ok
            ? withToken('/bills')
            : withToken(`/bills/edit?id=${encodeURIComponent(billId)}&error=${encodeURIComponent(result.message)}`),
        );
        return;
      }
      if (path === '/bills/bulk-category' && req.method === 'POST') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        const ids = form.getAll('ids');
        const categoryId = form.get('categoryId');
        const result = deps.bulkCategorize(ids, categoryId === null || categoryId === '' ? null : categoryId);
        redirect(res, withToken(`/bills?notice=${encodeURIComponent(result.message)}`));
        return;
      }
      if (path === '/bills/restore' && req.method === 'POST') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        deps.restoreBill(String(form.get('billId') ?? ''));
        redirect(res, withToken('/bills'));
        return;
      }
      if (path === '/bills/delete' && req.method === 'POST') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        deps.deleteBill(String(form.get('billId') ?? ''));
        redirect(res, withToken('/bills'));
        return;
      }

      // ---------------------------------------------------------- 投递箱
      if (path === '/inbox' && req.method === 'GET') {
        send(
          res,
          200,
          layout(
            '投递箱',
            inboxPage({
              token: deps.token,
              inboxDir: deps.inboxDir,
              pending: deps.listInboxFiles(),
              result: null,
              mailStatus: deps.mailStatus(),
            }),
            { token: deps.token },
          ),
        );
        return;
      }
      if (path === '/inbox/fetch-mail' && req.method === 'POST') {
        const mailResult = await deps.fetchMail({});
        send(
          res,
          200,
          layout(
            '投递箱',
            inboxPage({
              token: deps.token,
              inboxDir: deps.inboxDir,
              pending: deps.listInboxFiles(),
              result: null,
              mailStatus: deps.mailStatus(),
              mailResult,
            }),
            { token: deps.token },
          ),
        );
        return;
      }
      if (path === '/inbox/scan' && req.method === 'POST') {
        const result = deps.scanInbox();
        send(
          res,
          200,
          layout(
            '投递箱',
            inboxPage({ token: deps.token, inboxDir: deps.inboxDir, pending: deps.listInboxFiles(), result }),
            { token: deps.token },
          ),
        );
        return;
      }
      if (path === '/inbox/paste' && req.method === 'POST') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        const text = form.get('text') ?? '';
        const subject = form.get('subject') ?? undefined;
        const paste = text.trim() === '' ? null : deps.pasteNotification({ text, subject });
        send(
          res,
          200,
          layout(
            '投递箱',
            inboxPage({
              token: deps.token,
              inboxDir: deps.inboxDir,
              pending: deps.listInboxFiles(),
              result: null,
              paste,
              pasteText: text,
            }),
            { token: deps.token },
          ),
        );
        return;
      }

      // ---------------------------------------------------------- 日报
      // ---------------------------------------------------------- 条目
      if (path === '/items' && req.method === 'GET') {
        send(
          res,
          200,
          layout('条目', itemsPage({ token: deps.token, items: deps.listItems(), counts: deps.itemCounts() }), {
            token: deps.token,
          }),
        );
        return;
      }
      if (path === '/items' && req.method === 'POST') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        const rawKind = String(form.get('kind') ?? 'auto');
        const result = deps.recordItem({
          text: String(form.get('text') ?? ''),
          kind: rawKind === 'bill' || rawKind === 'advice' ? rawKind : 'auto',
          source: 'manual',
        });
        send(
          res,
          200,
          layout(
            '条目',
            itemsPage({ token: deps.token, items: deps.listItems(), counts: deps.itemCounts(), result }),
            { token: deps.token },
          ),
        );
        return;
      }

      if (path === '/daily' && req.method === 'GET') {
        const runs = deps.listRuns(30);
        send(res, 200, layout('日报中心', dailyPage({ token: deps.token, runs, baseCurrency: deps.settings().money.baseCurrency }), { token: deps.token }));
        return;
      }
      if (path === '/daily/run' && req.method === 'POST') {
        const outcome = await deps.runDailyNow();
        send(
          res,
          200,
          layout('已生成', `<div class="card"><h1>${esc(outcome.status)}</h1><p>日期 ${esc(outcome.localDate)}</p><p class="mut">${esc(
            outcome.note ?? '',
          )}</p><div class="acts"><a href="${esc(withToken('/daily'))}">去日报中心</a></div></div>`, { token: deps.token }),
        );
        return;
      }

      // ---------------------------------------------------------- 导入
      if (path === '/import' && req.method === 'GET') {
        send(res, 200, layout('导入', importPage({ token: deps.token, report: null }), { token: deps.token }));
        return;
      }
      if (path === '/import' && req.method === 'POST') {
        const body = await readBody(req);
        const report = deps.importFile({
          name: url.searchParams.get('name') ?? 'upload.csv',
          body,
          kind: url.searchParams.get('kind') ?? undefined,
          mappingName: url.searchParams.get('mappingName') ?? undefined,
        });
        send(res, 200, layout('导入结果', importPage({ token: deps.token, report }), { token: deps.token }));
        return;
      }

      send(res, 404, layout('未找到', '<div class="card"><h1>404</h1></div>', { token: deps.token }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(res, 500, layout('出错了', `<div class="card"><h1>出错了</h1><pre>${esc(message)}</pre></div>`, { token: deps.token }));
    }
  };
}

/** 密钥不进配置文件：表单里填了就写进本机密钥文件（空值表示保持原值） */
function persistSecrets(deps: ServerDeps, form: URLSearchParams): void {
  for (const field of CONFIG_FIELDS) {
    if (field.type !== 'secret') continue;
    const raw = form.get(field.key);
    if (raw !== null && raw.trim() !== '') deps.configStore.setSecret(field.key, raw.trim());
  }
}

/** 表单 → 配置答案（所有可配置项都走这里，保证"新增配置项自动被询问/可改"） */
export function collectAnswers(form: URLSearchParams, baseCurrency: string): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const field of CONFIG_FIELDS) {
    switch (field.type) {
      case 'bool': {
        const raw = form.get(field.key);
        if (raw !== null) answers[field.key] = raw === 'true' || raw === 'on';
        break;
      }
      case 'int': {
        const raw = form.get(field.key);
        if (raw !== null && raw !== '') answers[field.key] = Number(raw);
        break;
      }
      case 'multi-enum': {
        const values = form.getAll(field.key);
        if (values.length > 0) answers[field.key] = values;
        break;
      }
      case 'time-range': {
        const from = form.get(`${field.key}_from`);
        const to = form.get(`${field.key}_to`);
        if (from && to) answers[field.key] = [from, to];
        break;
      }
      case 'list': {
        const raw = form.get(field.key) ?? '';
        if (field.key === 'budget.items') {
          answers[field.key] = parseBudgetItems(raw, baseCurrency).items;
        } else {
          answers[field.key] = raw
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s !== '');
        }
        break;
      }
      case 'secret':
        // 真正的值由 persistSecrets 写进密钥文件；配置 JSON 里不保留该字段，
        // 页面上用"已配置/未配置"占位符表达状态。
        break;
      default: {
        const raw = form.get(field.key);
        if (raw !== null) answers[field.key] = raw;
      }
    }
  }
  return answers;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export async function startHttpServer(deps: ServerDeps, port = 0): Promise<RunningServer> {
  const handler = createRequestHandler(deps);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(port, deps.bind, resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  return {
    url: `http://${deps.bind}:${actualPort}/?token=${encodeURIComponent(deps.token)}`,
    port: actualPort,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

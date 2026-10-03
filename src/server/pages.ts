/** 本地界面的 HTML 生成（服务端渲染，零前端依赖）。所有动态内容一律转义。 */
import type { Bill, DayMetrics } from '../domain/types.ts';
import type { Category } from '../domain/category.ts';
import type { ConfigField } from '../infra/config/schema.ts';
import { CONFIG_FIELDS, getByPath } from '../infra/config/schema.ts';
import type { WizardStep } from '../app/onboarding.ts';
import { categoryName } from '../domain/category.ts';
import { currencyDigits, formatMinor, fromMinor } from '../domain/money.ts';
import { RULES, RULESET_VERSION } from '../domain/rules/ruleset.ts';
import type { ImportReport } from '../app/importBills.ts';
import type { InboxScanResult } from '../app/inbox.ts';
import type { NotificationImportResult } from '../app/importNotifications.ts';
import type { MailFetchSummary } from '../app/fetchMail.ts';
import type { AdviceItem } from '../infra/db/adviceItemRepo.ts';
import type { RecordItemResult } from '../app/recordItem.ts';

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
/* ── 设计令牌：全站唯一的"数值来源"，改这里就等于全站改版 ───────────────── */
:root{
  color-scheme:light dark;
  --fg:#18181b; --fg-2:#52525b; --fg-3:#8e8e98;
  --bg:#f5f5f7; --surface:#fff; --surface-2:#fafafa; --surface-3:#f0f0f3;
  --line:#e4e4e8; --line-2:#eeeef1;
  --brand:#2f6fed; --brand-fg:#fff; --brand-soft:#e9f0fe;
  --ok:#15803d; --ok-soft:#e9f7ee;
  --warn:#b45309; --warn-soft:#fdf4e5;
  --danger:#b42318; --danger-soft:#fdeceb;
  --r-xs:6px; --r-sm:8px; --r:10px; --r-lg:14px;
  --shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.05);
  --shadow-lift:0 4px 12px rgba(16,24,40,.08);
  --mono:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,"Courier New",monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --fg:#ecedef; --fg-2:#a8a8b3; --fg-3:#7c7c87;
    --bg:#0d0f12; --surface:#171a1f; --surface-2:#1b1e24; --surface-3:#22262d;
    --line:#2a2f37; --line-2:#23272e;
    --brand:#7aa2f7; --brand-fg:#0c1017; --brand-soft:#1b2437;
    --ok:#4ade80; --ok-soft:#16281d;
    --warn:#fbbf24; --warn-soft:#2a2114;
    --danger:#f87171; --danger-soft:#2c1a1a;
    --shadow:0 1px 2px rgba(0,0,0,.35);
    --shadow-lift:0 6px 18px rgba(0,0,0,.45);
  }
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;background:var(--bg);color:var(--fg);
  font:14.5px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
  font-variant-numeric:tabular-nums;
}
/* ── 顶栏：胶囊导航，当前页高亮 ────────────────────────────────────────── */
header{
  position:sticky;top:0;z-index:10;
  display:flex;gap:6px;align-items:center;flex-wrap:wrap;
  padding:10px 18px;background:var(--surface);
  background:color-mix(in srgb,var(--surface) 88%,transparent);
  backdrop-filter:blur(10px);border-bottom:1px solid var(--line);
}
.brand{
  display:inline-flex;align-items:center;gap:7px;margin-right:8px;
  color:var(--fg);text-decoration:none;font-weight:650;letter-spacing:-.01em;
}
.brand::before{content:"";width:9px;height:9px;border-radius:3px;background:var(--brand)}
.brand.on{color:var(--brand)}
.nav{
  padding:5px 11px;border-radius:999px;color:var(--fg-2);
  text-decoration:none;font-size:13.5px;font-weight:550;transition:background .15s,color .15s;
}
.nav:hover{background:var(--surface-3);color:var(--fg)}
.nav.on{background:var(--brand-soft);color:var(--brand)}
.meta{margin-left:auto;color:var(--fg-3);font-size:12px;white-space:nowrap}
main{max-width:1080px;margin:0 auto;padding:20px 18px 40px}
/* ── 卡片：明确的层次（底 + 边 + 微阴影），不再糊成一片 ─────────────── */
.card{
  background:var(--surface);border:1px solid var(--line);border-radius:var(--r-lg);
  padding:20px;margin-bottom:14px;box-shadow:var(--shadow);
}
.card>h1:first-child,.card>h2:first-child{margin-top:0}
h1{font-size:20px;line-height:1.35;margin:0 0 10px;font-weight:650;letter-spacing:-.01em}
h2{font-size:15px;line-height:1.4;margin:0 0 12px;font-weight:600;color:var(--fg)}
h2.classify{color:var(--fg-3);font-size:12px;font-weight:600;letter-spacing:.06em;margin-bottom:10px}
p{margin:0 0 10px}
p:last-child{margin-bottom:0}
.mut{color:var(--fg-3);font-size:12.5px}
.warn{color:var(--warn)}
a{color:var(--brand)}
/* ── 关键数字：放大 + 等宽，一眼可比 ─────────────────────────────────── */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:4px 0 16px}
.stat{background:var(--surface-2);border:1px solid var(--line-2);border-radius:var(--r);padding:12px 14px}
.stat .k{color:var(--fg-3);font-size:12px;margin-bottom:2px}
.stat .v{font-size:24px;font-weight:650;line-height:1.2;letter-spacing:-.02em}
.stat .v small{font-size:12px;font-weight:500;color:var(--fg-3);margin-left:3px}
/* ── 表格：细分割线、表头弱化、行 hover ───────────────────────────────── */
table{width:100%;border-collapse:separate;border-spacing:0;font-size:13.5px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line-2);vertical-align:middle}
th{color:var(--fg-3);font-weight:600;font-size:12px;background:transparent;white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
tbody tr{transition:background .12s}
tbody tr:hover{background:var(--surface-2)}
.num,td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
/* 配置表的"标签/值"两列：标签收窄到内容宽，值紧随其后（原来的 38% 会在宽屏留下大片空白） */
table.kv th{width:1%;white-space:nowrap;padding-right:28px;color:var(--fg-2);font-weight:500;font-size:13.5px;background:transparent}
table.kv td{font-weight:550}
/* ── 徽标 ─────────────────────────────────────────────────────────────── */
.pill{display:inline-block;padding:2px 9px;border-radius:999px;background:var(--surface-3);color:var(--fg-2);font-size:12px;margin-left:6px;white-space:nowrap}
.badge{display:inline-block;padding:2px 8px;border-radius:var(--r-xs);font-size:12px;font-weight:550}
.badge.ok{background:var(--ok-soft);color:var(--ok)}
.badge.warn{background:var(--warn-soft);color:var(--warn)}
.badge.danger{background:var(--danger-soft);color:var(--danger)}
/* ── 表单 ─────────────────────────────────────────────────────────────── */
input,select,textarea{
  background:var(--surface);color:var(--fg);border:1px solid var(--line);
  border-radius:var(--r-sm);padding:8px 10px;font:inherit;width:100%;
  transition:border-color .15s,box-shadow .15s;
}
input:focus,select:focus,textarea:focus{
  outline:none;border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft);
}
textarea{min-height:110px;resize:vertical;font-family:var(--mono);font-size:12.5px;line-height:1.6}
label{display:block;font-weight:600;font-size:13px;margin-bottom:5px;color:var(--fg-2)}
.field{margin-bottom:16px}
.field .help{color:var(--fg-3);font-size:12px;margin-top:5px;line-height:1.55}
input[type=checkbox]{width:auto;accent-color:var(--brand)}
/* ── 按钮：主/次分明（次要按钮不再伪装成链接）───────────────────────── */
button{
  background:var(--brand);color:var(--brand-fg);border:1px solid transparent;
  border-radius:var(--r-sm);padding:8px 14px;font:inherit;font-size:13.5px;font-weight:600;
  cursor:pointer;transition:filter .15s,background .15s;
}
button:hover{filter:brightness(1.07)}
button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
button.ghost{background:var(--surface);color:var(--fg);border-color:var(--line);font-weight:550}
button.ghost:hover{background:var(--surface-3);filter:none}
button.link{background:none;border:0;color:var(--brand);padding:0;font-weight:550;text-decoration:underline;text-underline-offset:2px}
button.danger{background:var(--danger)}
.acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px}
.acts form{display:contents}
/* ── 栅格与空状态 ─────────────────────────────────────────────────────── */
.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:760px){.row{grid-template-columns:1fr}}
.empty{
  border:1px dashed var(--line);border-radius:var(--r);padding:26px 18px;text-align:center;
  color:var(--fg-3);font-size:13px;background:var(--surface-2);
}
pre{
  background:var(--surface-2);border:1px solid var(--line-2);padding:10px 12px;
  border-radius:var(--r-sm);overflow:auto;font-size:12px;font-family:var(--mono);line-height:1.6;
}
hr{border:0;border-top:1px solid var(--line-2);margin:16px 0}
`;

/** 顶部导航项。当前页由 title 反推：标题里含哪个导航词，就高亮哪个。 */
const NAV_ITEMS: Array<{ label: string; path: string }> = [
  { label: '日报', path: '/daily' },
  { label: '账单', path: '/bills' },
  { label: '条目', path: '/items' },
  { label: '导入', path: '/import' },
  { label: '投递箱', path: '/inbox' },
  { label: '设置', path: '/settings' },
];

export function layout(title: string, body: string, options: { token: string; banner?: string }): string {
  const token = esc(options.token);
  const activeIndex = NAV_ITEMS.findIndex((item) => title.includes(item.label));
  const nav = NAV_ITEMS.map(
    (item, index) =>
      `<a class="nav${index === activeIndex ? ' on' : ''}" href="${item.path}?token=${token}">${esc(item.label)}</a>`,
  ).join('');
  const banner = options.banner ? `<div class="card"><span class="warn">${esc(options.banner)}</span></div>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · billing-bot</title><style>${STYLE}</style></head><body>
<header>
  <a class="brand${activeIndex === -1 ? ' on' : ''}" href="/?token=${token}">billing-bot</a>
  ${nav}
  <span class="meta">规则集 ${esc(RULESET_VERSION)} · 数据仅存本机</span>
</header>
<main>${banner}${body}</main>
</body></html>`;
}

function moneyText(minor: number | null, currency: string): string {
  if (minor === null) return '—';
  return formatMinor(minor, currency);
}

/** 配置分组的人话标题。裸键名（host/push/…）对用户没有意义，不该出现在界面上。 */
const GROUP_LABELS: Record<string, string> = {
  host: '推送通道',
  push: '推送与时间',
  money: '金额与币种',
  budget: '预算',
  analysis: '分析口径',
  llm: '云端模型',
  mail: '邮件自动抓取',
  server: '本地界面',
  data: '数据保留',
  categories: '分类',
};

function groupLabel(group: string): string {
  return GROUP_LABELS[group] ?? group;
}

/** 运行状态的人话标签（界面上不出现内部枚举字符串）。 */
function pushStatusText(status: string | null): string {
  switch (status) {
    case 'pushed':
      return '已推送';
    case 'skipped_already_run':
      return '已跳过（当天已推过）';
    case 'revised':
      return '已重发修正版';
    case 'failed':
      return '推送失败';
    case null:
      return '—';
    default:
      return status;
  }
}

/** 导入/抓取结果的人话标签。 */
const IMPORT_STATUS_LABELS: Record<string, string> = {
  imported: '已入账',
  duplicate: '重复',
  skipped: '已跳过',
  unmatched: '非账单',
  suspected: '疑似重复',
  failed: '失败',
};

function importStatusText(status: string): string {
  return IMPORT_STATUS_LABELS[status] ?? status;
}

// ---------------------------------------------------------------- 首页
export function dashboardPage(args: {
  token: string;
  settingsSummary: Array<{ label: string; value: string }>;
  latest: { localDate: string; pushedAt: string | null; channel: string | null } | null;
  counts: { bills: number; pendingReview: number; runs: number };
  nextDueAt: number | null;
  /** 条目与汇总邮件状态：用于"发送失败必须看得见" */
  items?: { pending: number; failed: number; needsConfirm: number; sent: number } | null;
  digest?: { enabled: boolean; to: string; ok: boolean | null; reason?: string } | null;
}): string {
  const rows = args.settingsSummary
    .map((s) => `<tr><th>${esc(s.label)}</th><td>${esc(s.value)}</td></tr>`)
    .join('');
  const latest = args.latest
    ? `<p>最近一次日报 <b>${esc(args.latest.localDate)}</b> · ${esc(args.latest.channel ?? '未推送')} · <span class="mut">${
        args.latest.pushedAt ? esc(new Date(args.latest.pushedAt).toLocaleString()) : '尚未推送'
      }</span></p>`
    : '<p class="mut">还没有生成过日报。</p>';
  const next = args.nextDueAt
    ? `<p class="mut">下次计划执行：${esc(new Date(args.nextDueAt).toLocaleString())}</p>`
    : '';
  return `<div class="card">
  <h1>概览</h1>
  <div class="stats">
    <div class="stat"><div class="k">账单</div><div class="v">${args.counts.bills}<small>条</small></div></div>
    <div class="stat"><div class="k">待补分类</div><div class="v">${args.counts.pendingReview}<small>条</small></div></div>
    <div class="stat"><div class="k">已生成日报</div><div class="v">${args.counts.runs}<small>次</small></div></div>
  </div>
  ${latest}${next}
  ${digestCard(args)}
  <div class="acts">
    <form method="post" action="/daily/run?token=${esc(args.token)}"><button>立即生成今天的日报</button></form>
    <form method="get" action="/import?token=${esc(args.token)}"><button class="ghost">导入账单文件</button></form>
    <form method="get" action="/items?token=${esc(args.token)}"><button class="ghost">查看条目</button></form>
  </div>
</div>
<div class="card"><h2 class="classify">当前配置</h2><table class="kv">${rows}</table>
<p class="mut">所有配置项都能随时修改，且对每个使用者都会在首次启动时被询问一次。</p></div>`;
}

// ---------------------------------------------------------------- 引导向导
function fieldInput(field: ConfigField, value: unknown, token: string, hasSecret?: (key: string) => boolean): string {
  void token;
  const name = field.key;
  const id = esc(name);
  const help = `<div class="mut">${esc(field.help)}</div>`;
  const label = `<label for="${id}">${esc(field.label)}${field.required ? '' : '（可留空）'}</label>`;

  switch (field.type) {
    case 'bool':
      return `<div class="field">${label}<select id="${id}" name="${name}">
        <option value="true"${value === true ? ' selected' : ''}>开启</option>
        <option value="false"${value === false ? ' selected' : ''}>关闭</option>
      </select>${help}</div>`;
    case 'int':
      return `<div class="field">${label}<input id="${id}" name="${name}" type="number" value="${esc(value)}"
        ${field.min !== undefined ? `min="${field.min}"` : ''} ${field.max !== undefined ? `max="${field.max}"` : ''}>${help}</div>`;
    case 'enum':
      return `<div class="field">${label}<select id="${id}" name="${name}">${(field.options ?? [])
        .map((o) => `<option value="${esc(o.value)}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`)
        .join('')}</select>${help}</div>`;
    case 'multi-enum': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return `<div class="field">${label}${(field.options ?? [])
        .map(
          (o) =>
            `<label style="font-weight:400"><input type="checkbox" style="width:auto" name="${name}" value="${esc(o.value)}"${
              selected.includes(o.value) ? ' checked' : ''
            }> ${esc(o.label)}</label>`,
        )
        .join('')}${help}</div>`;
    }
    case 'time-range': {
      const range = Array.isArray(value) ? (value as string[]) : ['22:30', '07:30'];
      return `<div class="field">${label}<div class="row">
        <input name="${name}_from" type="time" value="${esc(range[0])}">
        <input name="${name}_to" type="time" value="${esc(range[1])}"></div>${help}</div>`;
    }
    case 'time':
      return `<div class="field">${label}<input id="${id}" name="${name}" type="time" value="${esc(value)}">${help}</div>`;
    case 'secret':
      return `<div class="field">${label}<input id="${id}" name="${name}" type="password" placeholder="${
        hasSecret?.(field.key) ? '已配置（留空则保持不变）' : '未配置'
      }">${help}</div>`;
    case 'list': {
      const list = Array.isArray(value) ? (value as string[]) : [];
      return `<div class="field">${label}<textarea id="${id}" name="${name}" rows="3" placeholder="每行一项">${esc(
        list.join('\n'),
      )}</textarea>${help}</div>`;
    }
    default:
      return `<div class="field">${label}<input id="${id}" name="${name}" value="${esc(value)}">${help}</div>`;
  }
}

export function onboardingPage(args: {
  token: string;
  steps: WizardStep[];
  draft: Record<string, unknown>;
  issues?: Array<{ key: string; message: string }>;
  hasSecret?: (key: string) => boolean;
}): string {
  const issues = args.issues?.length
    ? `<div class="card warn">${args.issues.map((i) => `<div>${esc(i.message)}</div>`).join('')}</div>`
    : '';
  const steps = args.steps
    .map(
      (step) => `<div class="card"><h2>${esc(step.title)}</h2><p class="mut">${esc(step.description)}</p>
      ${step.fields.map((f) => fieldInput(f, getByPath(args.draft, f.key), args.token, args.hasSecret)).join('')}</div>`,
    )
    .join('');
  return `<h1>首次使用引导</h1>
  <p class="mut">这些设置只影响这台电脑上的你；每一项之后都能在「设置」里随时修改。</p>
  ${issues}
  <form method="post" action="/onboarding?token=${esc(args.token)}">
    ${steps}
    <div class="card"><div class="acts"><button>保存并开始使用</button></div>
    <p class="mut">跳过也可以：跳过时使用安全默认（只手动录入、不推送、不联网）。</p></div>
  </form>`;
}

// ---------------------------------------------------------------- 设置页
export function settingsPage(args: {
  token: string;
  draft: Record<string, unknown>;
  issues?: Array<{ key: string; message: string }>;
  hasSecret?: (key: string) => boolean;
}): string {
  const groups = new Map<string, ConfigField[]>();
  for (const field of CONFIG_FIELDS) {
    const list = groups.get(field.group) ?? [];
    list.push(field);
    groups.set(field.group, list);
  }
  const sections = [...groups.entries()]
    .map(
      ([group, fields]) => `<div class="card"><h2 class="classify">${esc(groupLabel(group))}</h2>
      ${fields.map((f) => fieldInput(f, getByPath(args.draft, f.key), args.token, args.hasSecret)).join('')}</div>`,
    )
    .join('');
  const issues = args.issues?.length
    ? `<div class="card warn">${args.issues.map((i) => `<div>${esc(i.message)}</div>`).join('')}</div>`
    : '';
  return `<h1>设置</h1>${issues}
  <form method="post" action="/settings?token=${esc(args.token)}">${sections}
  <div class="card"><div class="acts"><button>保存</button></div></div></form>`;
}

// ---------------------------------------------------------------- 账单页
function billFormFields(bill: Bill | null, categories: Category[], token: string): string {
  const options = (selected: string | null): string =>
    categories
      .map((c) => `<option value="${esc(c.categoryId)}"${c.categoryId === selected ? ' selected' : ''}>${esc(c.name)}</option>`)
      .join('');
  const localValue = bill ? bill.occurredAt.slice(0, 16) : '';
  return `
    <div><label>金额</label><input name="amount" required value="${
      bill ? esc(fromMinor(bill.amountMinor, bill.currency).toFixed(currencyDigits(bill.currency))) : ''
    }" placeholder="例如 38.50"></div>
    <div><label>币种</label><input name="currency" value="${esc(bill?.currency ?? 'CNY')}" maxlength="3"></div>
    <div><label>发生时间</label><input name="occurredAt" type="datetime-local" required value="${esc(localValue)}"></div>
    <div><label>收支</label><select name="direction">${(['expense', 'income', 'transfer'] as const)
      .map((d) => `<option value="${d}"${(bill?.direction ?? 'expense') === d ? ' selected' : ''}>${
        d === 'expense' ? '支出' : d === 'income' ? '收入' : '转账'
      }</option>`)
      .join('')}</select></div>
    <div><label>分类</label><select name="categoryId"><option value="">未分类</option>${options(bill?.categoryId ?? null)}</select></div>
    <div><label>商户</label><input name="merchant" value="${esc(bill?.merchant ?? '')}"></div>
    <div><label>备注</label><input name="note" value="${esc(bill?.note ?? '')}"></div>
    <input type="hidden" name="billId" value="${esc(bill?.billId ?? '')}">
    <input type="hidden" name="version" value="${esc(bill?.version ?? 0)}">
    <input type="hidden" name="token" value="${esc(token)}">`;
}

export function billEditPage(args: {
  token: string;
  bill: Bill;
  categories: Category[];
  error?: string;
}): string {
  const deleted = args.bill.deletedAt !== null;
  return `<div class="card"><h1>编辑账单</h1>
  ${args.error ? `<p class="warn">${esc(args.error)}</p>` : ''}
  ${deleted ? '<p class="warn">这条账单已被删除（软删）。恢复后才会重新参与统计。</p>' : ''}
  <form method="post" action="/bills/edit?token=${esc(args.token)}" class="row">${billFormFields(args.bill, args.categories, args.token)}
    <div style="align-self:end"><button>保存</button></div>
  </form>
  <div class="acts">
    <form method="get" action="/bills?token=${esc(args.token)}"><button class="ghost">返回</button></form>
    ${
      deleted
        ? `<form method="post" action="/bills/restore?token=${esc(args.token)}">
             <input type="hidden" name="billId" value="${esc(args.bill.billId)}">
             <button class="ghost">恢复这条账单</button></form>`
        : ''
    }
  </div>
  <p class="mut">保存时会做乐观锁校验：如果这条账单在别处被改过，会提示你重新打开，不会静默覆盖。</p>
  </div>`;
}

export function billsPage(args: {
  token: string;
  bills: Bill[];
  categories: Category[];
  filter: { fromDate: string; toDate: string; keyword: string; categoryId: string };
  notice?: string;
}): string {
  const rows = args.bills
    .map(
      (b) => `<tr>
      <td><input type="checkbox" style="width:auto" name="ids" value="${esc(b.billId)}" form="bulk"></td>
      <td>${esc(b.occurredAt.slice(0, 16).replace('T', ' '))}</td>
      <td>${esc(categoryName(args.categories, b.categoryId))}${
        b.status === 'pending_review' ? '<span class="pill warn">待补充</span>' : ''
      }</td>
      <td>${esc(b.merchant ?? '')}</td>
      <td>${esc(b.direction === 'expense' ? '支出' : b.direction === 'income' ? '收入' : '转账')}</td>
      <td class="num">${esc(formatMinor(b.amountMinor, b.currency))}</td>
      <td>${esc(b.source)}</td>
      <td>
        <a href="/bills/edit?token=${esc(args.token)}&id=${esc(b.billId)}">编辑</a>
        <form method="post" action="/bills/delete?token=${esc(args.token)}" style="display:inline">
          <input type="hidden" name="billId" value="${esc(b.billId)}">
          <button class="ghost">删除</button>
        </form>
      </td>
    </tr>`,
    )
    .join('');

  const categoryOptions = args.categories
    .map((c) => `<option value="${esc(c.categoryId)}">${esc(c.name)}</option>`)
    .join('');

  return `<div class="card"><h1>账单</h1>
  ${args.notice ? `<p class="warn">${esc(args.notice)}</p>` : ''}
  <form method="get" action="/bills?token=${esc(args.token)}" class="row">
    <div><label>从</label><input type="date" name="fromDate" value="${esc(args.filter.fromDate)}"></div>
    <div><label>到</label><input type="date" name="toDate" value="${esc(args.filter.toDate)}"></div>
    <div><label>分类</label><select name="categoryId"><option value="">全部</option>
      <option value="__none__"${args.filter.categoryId === '__none__' ? ' selected' : ''}>只看未分类</option>
      ${categoryOptions}</select></div>
    <div><label>关键词</label><input name="keyword" value="${esc(args.filter.keyword)}"></div>
    <div style="align-self:end"><button>筛选</button></div>
  </form>
  <p class="mut">提示：只筛「未分类」时，可以勾选多行后一次性归类，不用逐条点。</p>
  </div>

  <div class="card"><h2>新增一笔</h2>
  <form method="post" action="/bills?token=${esc(args.token)}" class="row">${billFormFields(null, args.categories, args.token)}
    <div style="align-self:end"><button>保存</button></div>
  </form>
  <p class="mut">时间按你设置的时区解释；金额可写小数，内部按最小货币单位整数存储。</p></div>

  <div class="card"><h2>共 ${args.bills.length} 条</h2>
  <form method="post" action="/bills/bulk-category?token=${esc(args.token)}" id="bulk">
    <div class="row" style="margin-bottom:10px">
      <div><label>把勾选的账单归类到</label><select name="categoryId">${categoryOptions}</select></div>
      <div style="align-self:end"><button>批量归类</button></div>
    </div>
  </form>
  <table><thead><tr><th></th><th>时间</th><th>分类</th><th>商户</th><th>方向</th><th class="num">金额</th><th>来源</th><th>操作</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="8" class="mut">没有符合条件的账单。</td></tr>'}</tbody></table></div>`;
}

// ---------------------------------------------------------------- 日报中心
export function dailyPage(args: {
  token: string;
  runs: Array<{ localDate: string; revision: number; pushedAt: string | null; channel: string | null; pushStatus: string | null; metricsJson: string; advicesJson: string }>;
  baseCurrency: string;
}): string {
  const cards = args.runs
    .map((run) => {
      let summary = '';
      try {
        const metrics = JSON.parse(run.metricsJson) as DayMetrics;
        summary = `净支出 ${moneyText(metrics.netConvertedTotalMinor, metrics.baseCurrency ?? args.baseCurrency)} · ${
          metrics.expenseCount
        } 笔${metrics.fxMissingCount > 0 ? ` · ${metrics.fxMissingCount} 笔缺汇率` : ''}${
          metrics.negativeNet ? ' · <span class="warn">当日净额为负（退款冲减）</span>' : ''
        }`;
      } catch {
        summary = '<span class="mut">快照解析失败</span>';
      }
      let advices = '';
      try {
        const list = JSON.parse(run.advicesJson) as Array<{ ruleId: string; severity: string; title: string }>;
        advices = list.length
          ? `<ul>${list.map((a) => `<li>[${esc(a.ruleId)}] ${esc(a.title)}</li>`).join('')}</ul>`
          : '<p class="mut">当日没有需要提醒的内容。</p>';
      } catch {
        advices = '';
      }
      return `<div class="card"><h2>${esc(run.localDate)} 
        <span class="pill">rev ${run.revision}</span>
        <span class="pill">${esc(run.channel ?? '未推送')}</span></h2>
        <p>${summary}</p>${advices}
        <p class="mut">${run.pushedAt ? `推送于 ${esc(new Date(run.pushedAt).toLocaleString())}` : '尚未推送'} · ${esc(pushStatusText(run.pushStatus))}</p>
      </div>`;
    })
    .join('');
  return `<div class="card"><h1>日报中心</h1>
  <p class="mut">这里保存每次生成时的快照：即使之后改了账单，历史日报也不会被悄悄改写。</p>
  <div class="acts"><form method="post" action="/daily/run?token=${esc(args.token)}"><button>重新生成今天的日报</button></form></div>
  </div>${cards || '<div class="card mut">还没有日报。</div>'}`;
}

// ---------------------------------------------------------------- 导入页
export function importPage(args: { token: string; report: ImportReport | null; preview?: unknown }): string {
  const report = args.report
    ? `<div class="card"><h2>导入结果 · ${esc(args.report.sourceLabel)}</h2>
      <p>成功 <b>${args.report.okCount}</b> · 重复 ${args.report.dupCount} · 跳过 ${args.report.skippedCount} · 失败 ${args.report.failedCount} · 疑似重复 ${args.report.suspectedCount}</p>
      <p class="mut">编码 ${esc(args.report.encoding)} · 表头行 ${args.report.headerRow + 1} · 文件指纹 ${esc(
        args.report.fileSha256.slice(0, 12),
      )}${args.report.alreadyImported ? ' · <b>该文件此前已导入过</b>' : ''}</p>
      <table><thead><tr><th>行</th><th>结果</th><th>商户</th><th>金额</th><th>说明</th></tr></thead><tbody>
      ${args.report.rows
        .slice(0, 100)
        .map(
          (r) =>
            `<tr><td>${r.rowNumber}</td><td>${esc(importStatusText(r.status))}</td><td>${esc(
              r.merchant ?? '',
            )}</td><td class="num">${esc(r.amountText ?? '')}</td><td class="mut">${esc(r.reason ?? '')}</td></tr>`,
        )
        .join('')}
      </tbody></table>
      <details><summary class="mut">本次使用的列映射</summary><pre>${esc(JSON.stringify(args.report.mapping, null, 2))}</pre></details>
      </div>`
    : '';

  return `<div class="card"><h1>导入账单文件</h1>
  <p class="mut">选择支付宝 / 微信 / 银行导出的 CSV 原文件。编码会自动识别（GBK / UTF-8 / BOM）；表头前的说明行会自动跳过。</p>
  <form id="f">
    <div class="field"><label>文件</label><input type="file" id="file" accept=".csv,.txt"></div>
    <div class="row">
      <div><label>来源（留空自动识别）</label><select id="kind">
        <option value="">自动识别</option><option value="alipay">支付宝</option>
        <option value="wechat">微信支付</option><option value="bank">银行卡</option><option value="generic">通用 CSV</option>
      </select></div>
      <div><label>已保存的映射模板名（可选）</label><input id="mappingName"></div>
    </div>
    <div class="acts"><button type="button" id="go">开始导入</button></div>
  </form>
  <pre id="out" style="display:none"></pre>
  <script>
  document.getElementById('go').addEventListener('click', async () => {
    const file = document.getElementById('file').files[0];
    if (!file) { alert('请先选择文件'); return; }
    const kind = document.getElementById('kind').value;
    const mappingName = document.getElementById('mappingName').value;
    const qs = new URLSearchParams({ token: ${JSON.stringify(args.token)}, name: file.name });
    if (kind) qs.set('kind', kind);
    if (mappingName) qs.set('mappingName', mappingName);
    const res = await fetch('/import?' + qs.toString(), { method: 'POST', body: file });
    document.getElementById('out').style.display = 'block';
    document.getElementById('out').textContent = '已提交，正在刷新…';
    if (res.ok) location.reload(); else document.getElementById('out').textContent = await res.text();
  });
  </script>
  <p class="mut">重复导入同一文件会被文件指纹拦截；同一笔交易重复出现在不同导出区间，也会按交易单号去重。</p>
  </div>${report}`;
}

// ---------------------------------------------------------------- 投递箱
export function inboxPage(args: {
  token: string;
  inboxDir: string;
  pending: string[];
  result: InboxScanResult | null;
  paste?: NotificationImportResult | null;
  pasteText?: string;
  mailStatus?: { enabled: boolean; configured: boolean; host: string; user: string; mailbox: string; lookbackDays: number; hasPassword: boolean };
  mailResult?: MailFetchSummary | null;
}): string {
  const pendingList = args.pending.length
    ? `<ul>${args.pending.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
    : '<p class="mut">目录里没有待处理的文件。</p>';

  const statusText: Record<string, string> = {
    imported: '✅ 已导入',
    'already-imported': '↩️ 之前已导过',
    skipped: '⏭️ 跳过',
    failed: '❌ 失败',
  };
  const resultTable = args.result
    ? `<div class="card"><h2>本次扫描结果</h2>
      <p>发现 <b>${args.result.found}</b> 个 · 导入 <b>${args.result.imported}</b> · 已导过 ${
        args.result.alreadyImported
      } · 跳过 ${args.result.skipped} · 失败 ${args.result.failed}</p>
      <table><thead><tr><th>文件</th><th>结果</th><th>说明</th></tr></thead><tbody>
      ${args.result.results
        .map(
          (r) =>
            `<tr><td>${esc(r.fileName)}</td><td>${esc(statusText[r.status] ?? r.status)}</td><td>${esc(
              r.reason ?? '',
            )}</td></tr>`,
        )
        .join('')}
      </tbody></table></div>`
    : '';

  const paste = args.paste;
  const pasteResult = paste
    ? paste.status === 'imported'
      ? `<p>✅ 已入账：<b>${esc(String(paste.parsed?.fields?.amountText ?? ''))} 元</b> · ${esc(
          paste.parsed?.fields?.merchant ?? '未识别商户',
        )} · ${paste.parsed?.fields?.direction === 'income' ? '收入' : '支出'} · ${esc(
          String(paste.parsed?.fields?.occurredAt.slice(0, 16).replace('T', ' ')),
        )}（置信度 ${esc(String(paste.parsed?.confidence ?? 0))}）</p>`
      : paste.status === 'duplicate'
        ? '<p>↩️ 这段内容之前已经记过账了，未重复入账。</p>'
        : `<p class="warn">未识别：${esc(paste.reason ?? '未知原因')}</p>
           <p class="mut">把这段原文发给我，我可以为你的银行补一条模板。</p>`
    : '';

  const mail = args.mailStatus;
  const mailSection = mail
    ? `<div class="card"><h2>邮件自动抓取（IMAP）</h2>
      ${
        !mail.enabled
          ? '<p class="mut">未启用。去 <a href="/settings?token=' +
            esc(args.token) +
            '">设置</a> → mail → 打开「自动抓取消费通知邮件」。</p>'
          : !mail.configured || !mail.hasPassword
            ? `<p class="warn">已启用但配置不完整：${
                mail.configured ? '' : '缺少 IMAP 服务器或邮箱账号；'
              }${mail.hasPassword ? '' : '缺少邮箱授权码（不是登录密码）'}</p>`
            : `<p>已配置：<b>${esc(mail.user)}</b> @ ${esc(mail.host)} · 文件夹 ${esc(
                mail.mailbox,
              )} · 回看 ${mail.lookbackDays} 天</p>
               <p class="mut">每次生成日报前会自动抓一次。不会改动你的邮箱（不标已读、不移动、不删除），重复扫描也不会重复记账。</p>`
      }
      <div class="acts"><form method="post" action="/inbox/fetch-mail?token=${esc(args.token)}"><button>立即抓取邮件</button></form></div>
      ${
        args.mailResult
          ? args.mailResult.ok
            ? `<p>自 ${esc(args.mailResult.sinceDate)} 起取回 <b>${args.mailResult.fetched}</b> 封 → 入账 <b>${
                args.mailResult.imported
              }</b>，已记过 ${args.mailResult.duplicate}，非通知 ${args.mailResult.unmatched}，失败 ${args.mailResult.failed}</p>
               ${
                 args.mailResult.details.length > 0
                   ? `<table><thead><tr><th>邮件主题</th><th>结果</th><th>金额</th><th>商户</th></tr></thead><tbody>${args.mailResult.details
                       .map(
                         (d) =>
                           `<tr><td>${esc(d.subject)}</td><td>${esc(d.status)}</td><td>${esc(
                             d.amountText ?? '',
                           )}</td><td>${esc(d.merchant ?? '')}</td></tr>`,
                       )
                       .join('')}</tbody></table>`
                   : '<p class="mut">没有需要记账的邮件。</p>'
               }`
            : `<p class="warn">未执行：${esc(args.mailResult.reason ?? '未知原因')}</p>`
          : ''
      }
      </div>`
    : '';

  return `<div class="card"><h1>投递箱</h1>
  <p>把账单文件（支付宝/微信/银行导出的 CSV，或邮件的 .eml）丢进下面这个目录，剩下的全自动：</p>
  <pre>${esc(args.inboxDir)}</pre>
  <p class="mut">每次生成日报前会自动扫一次；处理成功的文件会归档到 <code>done/</code>，失败的留在 <code>failed/</code> 方便重试。</p>
  <div class="acts"><form method="post" action="/inbox/scan?token=${esc(args.token)}"><button>立即扫描并导入</button></form></div>
  <div class="acts"><form method="get" action="/import?token=${esc(args.token)}"><button class="ghost">改用上传方式导入</button></form></div>
  </div>

  <div class="card"><h2>粘贴通知正文（最快的方式）</h2>
  <p class="mut">把银行/信用卡的消费通知直接复制过来——<b>短信、App 推送、邮件正文都可以</b>，不用导出文件。
  需含金额与"消费/支出/扣款/入账"这类字样，否则不会被当成交易。</p>
  <form method="post" action="/inbox/paste?token=${esc(args.token)}">
    <div class="field"><label>标题（可选）</label><input name="subject" placeholder="例如 信用卡消费提醒"></div>
    <div class="field"><label>通知正文</label>
      <textarea name="text" rows="4" placeholder="例如：您尾号1234的信用卡于10月03日21:05消费人民币68.00元，商户：某数码店。">${esc(
        args.pasteText ?? '',
      )}</textarea></div>
    <div class="acts"><button>解析并入账</button></div>
  </form>
  ${pasteResult}
  </div>

  ${mailSection}

  <div class="card"><h2>待处理文件（${args.pending.length}）</h2>${pendingList}
  <p class="mut">压缩包（.zip）不会自动解压——解压密码在支付宝/微信 App 的消息里，不在邮件里，所以需要你先解压出 CSV。
  <code>.txt</code> 会自动判断是通知正文还是 CSV。</p></div>
  ${resultTable}`;
}

export function rulesPage(): string {  return `<div class="card"><h1>建议规则</h1><table><thead><tr><th>编号</th><th>名称</th><th>级别</th><th>说明</th></tr></thead><tbody>
  ${RULES.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.title)}</td><td>${esc(r.severity)}</td><td>${esc(r.description)}</td></tr>`).join('')}
  </tbody></table><p class="mut">所有阈值都可在配置中调整；数据不足时规则会自动跳过，而不是硬给结论。</p></div>`;
}

// ---------------------------------------------------------------- 条目（账单信息与建议）
const ITEM_STATUS_BADGE: Record<string, { cls: string; text: string }> = {
  pending: { cls: '', text: '待发' },
  sent: { cls: 'ok', text: '已发' },
  failed: { cls: 'danger', text: '发送失败' },
};

/** 概览页的汇总邮件状态块：失败必须显式可见；未开启时只是一句提示。 */
function digestCard(args: {
  token: string;
  items?: { pending: number; failed: number; needsConfirm: number; sent: number } | null;
  digest?: { enabled: boolean; to: string; ok: boolean | null; reason?: string } | null;
}): string {
  const items = args.items ?? null;
  const digest = args.digest ?? null;
  const counts = items
    ? `<p>条目：待发 <b>${items.pending}</b> · 发送失败 <b>${items.failed}</b> · 待确认 <b>${items.needsConfirm}</b> · 已发 <b>${items.sent}</b></p>`
    : '';
  if (digest === null || !digest.enabled) {
    return `<p class="mut">每日汇总邮件未开启——账单信息与建议只会留在本机，不会发到邮箱。去 <a href="/settings?token=${esc(args.token)}">设置</a> 打开「每天随日报发一封汇总邮件」。</p>${counts}`;
  }
  const status =
    digest.ok === null
      ? '<p class="mut">本次运行还没发过汇总邮件。</p>'
      : digest.ok
        ? '<p>最近一次汇总邮件：<span class="badge ok">已发送</span></p>'
        : `<p><span class="badge danger">发送失败</span> <span class="warn">${esc(digest.reason ?? '原因未知')}</span></p><p class="mut">内容没有丢：条目仍在待发队列里，下次生成日报会自动补发。</p>`;
  return `<h2 class="classify">汇总邮件</h2><p>收件人 <b>${esc(digest.to || '（未填）')}</b></p>${status}${counts}`;
}

export function itemsPage(args: {
  token: string;
  items: AdviceItem[];
  counts: { total: number; pending: number; failed: number; sent: number; needsConfirm: number };
  result?: RecordItemResult | null;
}): string {
  const notice = args.result
    ? `<div class="card"><span class="${args.result.ok ? '' : 'warn'}">${esc(args.result.message)}</span></div>`
    : '';
  const rows =
    args.items.length === 0
      ? ''
      : args.items
          .map((item) => {
            const status = ITEM_STATUS_BADGE[item.status] ?? { cls: '', text: item.status };
            const badges = [
              `<span class="pill">${item.kind === 'bill' ? '账单信息' : '建议'}</span>`,
              `<span class="badge ${status.cls}">${esc(status.text)}</span>`,
            ];
            if (item.needsConfirm) badges.push('<span class="badge warn">待确认</span>');
            const sent = item.sentAt ? `<div class="mut">发送于 ${esc(new Date(item.sentAt).toLocaleString())}</div>` : '';
            const error = item.sendError ? `<div class="warn mut">${esc(item.sendError)}</div>` : '';
            const bill =
              item.billId !== null
                ? `<div class="mut">已关联账单 <a href="/bills/edit?id=${encodeURIComponent(item.billId)}&token=${esc(args.token)}">${esc(item.billId.slice(0, 8))}…</a></div>`
                : '';
            return `<div class="card">
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b>${esc(item.title)}</b>${badges.join('')}</div>
  <div class="mut">${esc(item.localDate)} · 来源 ${esc(item.source)}</div>
  <pre>${esc(item.body)}</pre>${bill}${sent}${error}</div>`;
          })
          .join('');

  return `<h1>条目</h1>
<p class="mut">这里逐条存放「账单信息」与「建议」——每条都能看到是否已发到邮箱；发送失败的会留在队列里自动补发。</p>
<div class="card"><h2 class="classify">新增条目</h2>
  <form method="post" action="/items?token=${esc(args.token)}">
    <div class="field"><label>内容</label>
      <textarea name="text" placeholder="粘贴一条账单通知，或写下一条建议……"></textarea>
      <div class="help">能识别出金额+时间就归档为「账单信息」并顺便入账；识别不出就按「建议」归档并标注待确认。</div>
    </div>
    <div class="field"><label>归类方式</label>
      <select name="kind">
        <option value="auto">自动判断（推荐）</option>
        <option value="bill">一定当账单信息</option>
        <option value="advice">一定当建议</option>
      </select>
    </div>
    <div class="acts"><button>归档</button></div>
  </form>
</div>
<div class="card"><h2 class="classify">统计</h2>
  <p>共 <b>${args.counts.total}</b> 条 · 待发 <b>${args.counts.pending}</b> · 发送失败 <b>${args.counts.failed}</b> · 待确认 <b>${args.counts.needsConfirm}</b> · 已发 <b>${args.counts.sent}</b></p>
</div>
${notice}
${rows || '<div class="empty">还没有任何条目。收到的账单信息与提出的建议都会出现在这里。</div>'}`;
}

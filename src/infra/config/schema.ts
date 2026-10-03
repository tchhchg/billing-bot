/**
 * 应用配置 Schema（每用户可配置铁律的落地）。
 *
 * 首次引导向导与设置页都**由这张表驱动**，而不是写死页面。
 * 新增一个配置项只需在这里加一条，向导与校验自动跟上。
 */
import type { Config } from '../../domain/types.ts';

export type FieldType =
  | 'enum'
  | 'multi-enum'
  | 'time'
  | 'time-range'
  | 'tz'
  | 'int'
  | 'bool'
  | 'string'
  | 'list'
  | 'secret';

export interface FieldOption {
  value: string;
  label: string;
}

export interface ConfigField {
  key: string;
  label: string;
  group: 'host' | 'push' | 'money' | 'budget' | 'analysis' | 'llm' | 'mail' | 'server' | 'data' | 'categories';
  type: FieldType;
  required: boolean;
  default: unknown;
  help: string;
  options?: FieldOption[];
  min?: number;
  max?: number;
}

export const CONFIG_SCHEMA_VERSION = 1;

/**
 * 卡片推送渠道。
 *
 * ⚠️ 只列**真正实现了适配器**的渠道：pickAdapters 对没有适配器的 id 是静默丢弃的，
 * 列一个没实现的选项 = 用户勾了却什么都不会发生，且没有任何报错。
 * 邮件不走这里——它是「每日汇总邮件」，在 mail 分组里单独配置。
 */
const CHANNELS: FieldOption[] = [
  { value: 'im_card', label: 'IM 机器人卡片（飞书）' },
  { value: 'local_daily_center', label: '本地日报中心' },
];

export const CONFIG_FIELDS: readonly ConfigField[] = [
  {
    key: 'host.im',
    label: 'IM 通道',
    group: 'host',
    type: 'enum',
    required: true,
    default: 'feishu',
    options: [
      { value: 'feishu', label: '飞书' },
      { value: 'dingtalk', label: '钉钉（暂未实现）' },
      { value: 'none', label: '不用 IM，只看本地日报' },
    ],
    help: '决定日报推送到哪里。选“不用 IM”则只在本地看。',
  },
  {
    key: 'host.feishuAppId',
    label: '飞书应用 App ID',
    group: 'host',
    type: 'string',
    required: false,
    default: '',
    help: '飞书开放平台 → 开发者后台 → 你的自建应用 → 凭证与基础信息。',
  },
  {
    key: 'host.feishuAppSecret',
    label: '飞书应用 App Secret',
    group: 'host',
    type: 'secret',
    required: false,
    default: '',
    help: '只存在本机的密钥文件里（不进配置文件、不进日志）。留空表示保持原值。',
  },
  {
    key: 'push.channels',
    label: '推送渠道（可多选）',
    group: 'push',
    type: 'multi-enum',
    required: true,
    default: ['local_daily_center'],
    options: CHANNELS,
    help: '任一渠道失败会自动降级到“本地日报中心”，不会丢内容。',
  },
  {
    key: 'push.time',
    label: '每日推送时间',
    group: 'push',
    type: 'time',
    required: true,
    default: '21:00',
    help: '按你所在时区的本地时间。随时可改，改完立即重排，不用重启。',
  },
  {
    key: 'push.timezone',
    label: '时区',
    group: 'push',
    type: 'tz',
    required: true,
    default: 'Asia/Shanghai',
    help: '决定“今天”的边界。跨时区出差时这里要跟着改。',
  },
  {
    key: 'push.quietHours',
    label: '免打扰时段',
    group: 'push',
    type: 'time-range',
    required: true,
    default: ['22:30', '07:30'],
    help: '这段时间内到点的日报会顺延到结束后发送。',
  },
  {
    key: 'push.maxDailyAdvice',
    label: '每日建议条数上限',
    group: 'push',
    type: 'int',
    required: true,
    default: 3,
    min: 1,
    max: 10,
    help: '超出上限的建议会被合并/丢弃，优先保留更重要的。',
  },
  {
    key: 'push.imRecipient',
    label: '机器人消息接收人',
    group: 'push',
    type: 'string',
    required: false,
    default: '',
    help: '飞书里的 open_id 或 chat_id（把机器人拉进群后可从群设置取）。留空则只发本地日报。',
  },
  {
    key: 'push.noDataNotice',
    label: '无账单日也提醒',
    group: 'push',
    type: 'bool',
    required: true,
    default: true,
    help: '某天没有任何记录时，是发一条"是否补记"的提示，还是完全静默。',
  },
  {
    key: 'money.baseCurrency',
    label: '基础币种',
    group: 'money',
    type: 'enum',
    required: true,
    default: 'CNY',
    options: [
      { value: 'CNY', label: '人民币 CNY' },
      { value: 'USD', label: '美元 USD' },
      { value: 'EUR', label: '欧元 EUR' },
      { value: 'JPY', label: '日元 JPY' },
      { value: 'HKD', label: '港币 HKD' },
      { value: 'GBP', label: '英镑 GBP' },
    ],
    help: '统计与折算的基准币种。',
  },
  {
    key: 'money.multiCurrency',
    label: '启用多币种',
    group: 'money',
    type: 'bool',
    required: true,
    default: false,
    help: '开启后外币账单会按汇率折算；关闭时外币条目单列且不计入合计。',
  },
  {
    key: 'money.fxSource',
    label: '汇率来源',
    group: 'money',
    type: 'enum',
    required: true,
    default: 'public_api',
    options: [
      { value: 'public_api', label: '公共汇率 API（自动，仅传币种与日期）' },
      { value: 'manual', label: '手工维护汇率表（完全离线）' },
    ],
    help: '选公共 API 时只发送币种代码与日期，不含金额与商户。',
  },
  {
    key: 'money.fxPolicy',
    label: '折算汇率取值',
    group: 'money',
    type: 'enum',
    required: true,
    default: 'on_date',
    options: [
      { value: 'on_date', label: '按交易发生日汇率（推荐）' },
      { value: 'latest', label: '按最新可用汇率' },
    ],
    help: '历史统计建议用发生日汇率，否则旧的记录会随汇率波动而变化。',
  },
  {
    key: 'budget.enabled',
    label: '启用预算',
    group: 'budget',
    type: 'bool',
    required: true,
    default: false,
    help: '关闭后“预算进度”类提醒自动禁用。',
  },
  {
    key: 'budget.period',
    label: '预算周期',
    group: 'budget',
    type: 'enum',
    required: true,
    default: 'month',
    options: [
      { value: 'month', label: '自然月' },
      { value: 'week', label: '自然周（周一起）' },
    ],
    help: '决定预算重置的时间点。',
  },
  {
    key: 'budget.items',
    label: '预算额度',
    group: 'budget',
    type: 'list',
    required: false,
    default: [],
    help: '总额预算与分类预算。总额条目的分类留空。',
  },
  {
    key: 'analysis.refundPolicy',
    label: '退款计算口径',
    group: 'analysis',
    type: 'enum',
    required: true,
    default: 'B',
    options: [
      { value: 'A', label: 'A 冲减原消费日（历史日报会被改写）' },
      { value: 'B', label: 'B 冲减退款当日（推荐，历史日报不改写）' },
      { value: 'C', label: 'C 退款不计入' },
    ],
    help: '切换口径不会追溯重算历史日报，只影响此后的统计。',
  },
  {
    key: 'analysis.fixedExpenseWhitelist',
    label: '固定支出白名单',
    group: 'analysis',
    type: 'list',
    required: false,
    default: [],
    help: '如“房租”“房贷”。这些条目仍计入总额，但不参与超支告警，避免每天误报。',
  },
  {
    key: 'analysis.baselineWindow',
    label: '对比基线',
    group: 'analysis',
    type: 'multi-enum',
    required: true,
    default: ['same_weekday', 'p7', 'p28'],
    options: [
      { value: 'same_weekday', label: '同星期几' },
      { value: 'p7', label: '近 7 日日均' },
      { value: 'p28', label: '近 28 日日均' },
    ],
    help: '按顺序取第一个可用基线；样本不足时进入冷启动，不出对比类建议。',
  },
  {
    key: 'analysis.coldStartMinDays',
    label: '冷启动最小天数',
    group: 'analysis',
    type: 'int',
    required: true,
    default: 3,
    min: 1,
    max: 30,
    help: '有效数据少于这个天数时，只出绝对阈值类提醒，不做同比分析。',
  },
  {
    key: 'analysis.recurringAmortize',
    label: '周期账单按周期摊销',
    group: 'analysis',
    type: 'bool',
    required: true,
    default: false,
    help: '关闭时按扣款日一次性计入（推荐）；开启后年费会摊到每个月。',
  },
  {
    key: 'mail.enabled',
    label: '自动抓取消费通知邮件（IMAP）',
    group: 'mail',
    type: 'bool',
    required: true,
    default: false,
    help: '开启后每次生成日报前会连你的邮箱，把消费通知自动记账——这是唯一不用手动操作的来源。',
  },
  {
    key: 'mail.imapHost',
    label: 'IMAP 服务器',
    group: 'mail',
    type: 'string',
    required: false,
    default: '',
    help: '常用：QQ邮箱 imap.qq.com｜163 imap.163.com｜Gmail imap.gmail.com｜Outlook outlook.office365.com｜iCloud imap.mail.me.com',
  },
  {
    key: 'mail.imapPort',
    label: 'IMAP 端口',
    group: 'mail',
    type: 'int',
    required: true,
    default: 993,
    min: 1,
    max: 65535,
    help: '993 是标准 SSL 端口，一般不用改。',
  },
  {
    key: 'mail.user',
    label: '邮箱账号',
    group: 'mail',
    type: 'string',
    required: false,
    default: '',
    help: '完整邮箱地址，例如 you@qq.com。',
  },
  {
    key: 'mail.password',
    label: '邮箱授权码（不是登录密码）',
    group: 'mail',
    type: 'secret',
    required: false,
    default: '',
    help: 'QQ/163/126 必须用「IMAP 授权码」；Gmail 要用「应用专用密码」。只存本机密钥文件。',
  },
  {
    key: 'mail.mailbox',
    label: '要扫描的文件夹',
    group: 'mail',
    type: 'string',
    required: true,
    default: 'INBOX',
    help: '默认收件箱。若你把通知归类到了某个文件夹，填那个文件夹的名字。',
  },
  {
    key: 'mail.senderFilter',
    label: '只处理发件人含此关键词的邮件（可选）',
    group: 'mail',
    type: 'string',
    required: false,
    default: '',
    help: '短信转发场景填转发邮箱的地址（通常就是你自己的邮箱），这样只在服务端取转发来的短信，不会把整箱邮件拉下来。留空则扫描窗口内所有邮件。',
  },
  {
    key: 'mail.smtpHost',
    label: 'SMTP 发信服务器（可留空自动推导）',
    group: 'mail',
    type: 'string',
    required: false,
    default: '',
    help: '留空则按 IMAP 服务器推导（imap.qq.com → smtp.qq.com，QQ/163/Gmail 都是这个命名习惯）。',
  },
  {
    key: 'mail.smtpPort',
    label: 'SMTP 端口',
    group: 'mail',
    type: 'int',
    required: true,
    default: 465,
    min: 1,
    max: 65535,
    help: '465 = 直连 TLS（QQ/163/Gmail）；587 = STARTTLS（Outlook）。',
  },
  {
    key: 'mail.digestEnabled',
    label: '每天随日报发一封汇总邮件',
    group: 'mail',
    type: 'bool',
    required: true,
    default: false,
    help: '开启后，每次生成日报都会把「账单信息 + 建议」汇总成一封邮件发出；发送失败会进待发队列并重试。',
  },
  {
    key: 'mail.notifyTo',
    label: '汇总邮件收件人（留空=发给自己）',
    group: 'mail',
    type: 'string',
    required: false,
    default: '',
    help: '留空就发到上面那个邮箱账号（自己发给自己）。',
  },
  {
    key: 'mail.lookbackDays',
    label: '往回扫描天数',
    group: 'mail',
    type: 'int',
    required: true,
    default: 7,
    min: 1,
    max: 180,
    help: '每次只看最近这些天的邮件；重复的不会重复记账，所以放宽一点更保险。',
  },
  {
    key: 'server.port',
    label: '本地界面端口',
    group: 'server',
    type: 'int',
    required: true,
    default: 8790,
    min: 1024,
    max: 65535,
    help: '固定端口，方便把它嵌到别的界面里（例如 DSH 左侧栏的插件条目）。改完重启生效。',
  },
  {
    key: 'server.token',
    label: '本地访问令牌',
    group: 'server',
    type: 'string',
    required: false,
    default: '',
    help: '留空则首次启动自动生成并保存，之后保持不变（这样嵌出去的链接不会每次重启就失效）。',
  },
  {
    key: 'analysis.futureDateToleranceDays',
    label: '未来日期容差（天）',
    group: 'analysis',
    type: 'int',
    required: true,
    default: 1,
    min: 0,
    max: 7,
    help: '超过这个天数的未来日期会被拒绝入库，防止误填年份。',
  },
  {
    key: 'llm.enabled',
    label: '允许云端模型润色文案',
    group: 'llm',
    type: 'bool',
    required: true,
    default: false,
    help: '关闭时使用本地模板，功能不降级，仅文案不如模型自然。',
  },
  {
    key: 'llm.provider',
    label: '模型服务',
    group: 'llm',
    type: 'enum',
    required: false,
    default: 'openai-compatible',
    options: [
      { value: 'openai-compatible', label: 'OpenAI 兼容端点' },
      { value: 'none', label: '不使用' },
    ],
    help: '端点地址与密钥在设置页填写，密钥只存本机。',
  },
  {
    key: 'llm.redaction',
    label: '出网脱敏级别',
    group: 'llm',
    type: 'enum',
    required: true,
    default: 'category_only',
    options: [
      { value: 'category_only', label: '仅分类名 + 金额档位（推荐）' },
      { value: 'amount_bucket', label: '仅金额档位' },
    ],
    help: '无论选哪档，商户名、备注、账户、精确金额都不会出网。',
  },
  {
    key: 'data.retentionMonths',
    label: '数据保留期（月）',
    group: 'data',
    type: 'int',
    required: true,
    default: 0,
    min: 0,
    max: 600,
    help: '0 表示永久保留。数据只在本机，删除不可恢复。',
  },
  {
    key: 'categories.preset',
    label: '分类体系',
    group: 'categories',
    type: 'enum',
    required: true,
    default: 'personal_default',
    options: [
      { value: 'personal_default', label: '通用个人版（餐饮/交通/居住/购物/医疗/娱乐/人情/其他）' },
      { value: 'minimal', label: '极简（只保留一级分类）' },
    ],
    help: '初始化后可随时增删改自己的分类。',
  },
];

/** 由字段表推导的默认配置（向导只改这里，不改代码） */
export function defaultConfigDraft(): Record<string, unknown> {
  const draft: Record<string, unknown> = { schemaVersion: CONFIG_SCHEMA_VERSION };
  for (const field of CONFIG_FIELDS) {
    setByPath(draft, field.key, field.default);
  }
  return draft;
}

export function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i] as string;
    const next = node[part];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      node[part] = {};
    }
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1] as string] = value;
}

export function getByPath(source: unknown, path: string): unknown {
  let node: unknown = source;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

export interface ConfigIssue {
  key: string;
  code: 'required' | 'type' | 'range' | 'option' | 'timezone' | 'time';
  message: string;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 校验一份配置草稿（向导提交前、加载旧配置后都要跑） */
export function validateConfigDraft(draft: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (typeof draft !== 'object' || draft === null) {
    return [{ key: '', code: 'type', message: '配置必须是一个对象' }];
  }
  for (const field of CONFIG_FIELDS) {
    const value = getByPath(draft, field.key);
    const missing = value === undefined || value === null || value === '';
    if (missing) {
      if (field.required) issues.push({ key: field.key, code: 'required', message: `${field.label}必填` });
      continue;
    }
    switch (field.type) {
      case 'int': {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          issues.push({ key: field.key, code: 'type', message: `${field.label}必须是整数` });
          break;
        }
        if (field.min !== undefined && value < field.min) {
          issues.push({ key: field.key, code: 'range', message: `${field.label}不能小于 ${field.min}` });
        }
        if (field.max !== undefined && value > field.max) {
          issues.push({ key: field.key, code: 'range', message: `${field.label}不能大于 ${field.max}` });
        }
        break;
      }
      case 'bool': {
        if (typeof value !== 'boolean') issues.push({ key: field.key, code: 'type', message: `${field.label}必须是布尔值` });
        break;
      }
      case 'enum': {
        const allowed = (field.options ?? []).map((o) => o.value);
        if (typeof value !== 'string' || (allowed.length > 0 && !allowed.includes(value))) {
          issues.push({ key: field.key, code: 'option', message: `${field.label}取值非法：${String(value)}` });
        }
        break;
      }
      case 'multi-enum': {
        const allowed = (field.options ?? []).map((o) => o.value);
        if (!Array.isArray(value) || value.length === 0) {
          issues.push({ key: field.key, code: 'type', message: `${field.label}至少选择一项` });
          break;
        }
        for (const item of value) {
          if (typeof item !== 'string' || (allowed.length > 0 && !allowed.includes(item))) {
            issues.push({ key: field.key, code: 'option', message: `${field.label}含非法取值：${String(item)}` });
          }
        }
        break;
      }
      case 'time': {
        if (typeof value !== 'string' || !TIME_RE.test(value)) {
          issues.push({ key: field.key, code: 'time', message: `${field.label}格式应为 HH:MM` });
        }
        break;
      }
      case 'time-range': {
        if (!Array.isArray(value) || value.length !== 2 || value.some((v) => typeof v !== 'string' || !TIME_RE.test(v))) {
          issues.push({ key: field.key, code: 'time', message: `${field.label}应为 [开始, 结束] 两个 HH:MM` });
        }
        break;
      }
      case 'tz': {
        if (typeof value !== 'string' || !isValidTimeZone(value)) {
          issues.push({ key: field.key, code: 'timezone', message: `${field.label}不是有效的 IANA 时区：${String(value)}` });
        }
        break;
      }
      case 'list': {
        if (!Array.isArray(value)) issues.push({ key: field.key, code: 'type', message: `${field.label}必须是列表` });
        break;
      }
      default: {
        if (typeof value !== 'string') issues.push({ key: field.key, code: 'type', message: `${field.label}必须是文本` });
      }
    }
  }
  return issues;
}

/** 草稿 → 领域层 Config（domain/ 只认自己那一小撮字段） */
export function toDomainConfig(draft: unknown): Config {
  const v = <T>(key: string, fallback: T): T => {
    const value = getByPath(draft, key);
    return (value === undefined || value === null ? fallback : value) as T;
  };
  return {
    money: {
      baseCurrency: v('money.baseCurrency', 'CNY'),
      multiCurrency: v('money.multiCurrency', false),
      fxPolicy: v('money.fxPolicy', 'on_date'),
    },
    budget: {
      enabled: v('budget.enabled', false),
      period: v('budget.period', 'month'),
      items: v('budget.items', [] as Config['budget']['items']),
    },
    analysis: {
      refundPolicy: v('analysis.refundPolicy', 'B'),
      baselineWindow: v('analysis.baselineWindow', ['same_weekday', 'p7', 'p28'] as Config['analysis']['baselineWindow']),
      coldStartMinDays: v('analysis.coldStartMinDays', 3),
      recurringAmortize: v('analysis.recurringAmortize', false),
      fixedExpenseWhitelist: v('analysis.fixedExpenseWhitelist', [] as string[]),
      futureDateToleranceDays: v('analysis.futureDateToleranceDays', 1),
    },
    push: {
      channels: v('push.channels', ['local_daily_center'] as string[]),
      time: v('push.time', '21:00'),
      timezone: v('push.timezone', 'Asia/Shanghai'),
      maxDailyAdvice: v('push.maxDailyAdvice', 3),
    },
  };
}

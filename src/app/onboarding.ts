/**
 * 首次引导向导（每个下载者都要走一遍）。
 *
 * 步骤不是写死的页面，而是从 CONFIG_FIELDS 推导出来的；
 * 因此"不许把作者的个人设置当默认行为"这条铁律是**结构性成立**的：
 * 想加一个配置项，就必须在 Schema 里登记，向导会自动询问。
 */
import {
  CONFIG_FIELDS,
  defaultConfigDraft,
  setByPath,
  validateConfigDraft,
  type ConfigField,
  type ConfigIssue,
} from '../infra/config/schema.ts';

export interface WizardStep {
  id: string;
  title: string;
  description: string;
  fields: ConfigField[];
}

const STEP_ORDER: Array<{ id: string; title: string; description: string; groups: string[] }> = [
  {
    id: 'channel',
    title: '① 消息通道',
    description: '日报要发到哪里？选“不用 IM”则只在本地查看，之后随时可以再配。',
    groups: ['host'],
  },
  {
    id: 'push',
    title: '② 推送与免打扰',
    description: '渠道、时间、时区都可以随时改，改完立即生效，不用重启。',
    groups: ['push'],
  },
  {
    id: 'money',
    title: '③ 币种与汇率',
    description: '只在有外币账单时才需要打开多币种。',
    groups: ['money'],
  },
  {
    id: 'budget',
    title: '④ 预算',
    description: '不设预算也能用，只是收不到“预算进度”类提醒。',
    groups: ['budget'],
  },
  {
    id: 'analysis',
    title: '⑤ 统计口径',
    description: '这几个选项直接决定日报里的数字怎么算，建议先看一遍说明。',
    groups: ['analysis'],
  },
  {
    id: 'llm',
    title: '⑥ 云端模型',
    description: '只影响文案是否自然；关闭后功能不降级，仍可离线使用。',
    groups: ['llm'],
  },
  {
    id: 'categories',
    title: '⑦ 分类体系',
    description: '先选一套预置分类，之后可以随时增删改。',
    groups: ['categories'],
  },
  {
    id: 'mail',
    title: '⑧ 邮件自动抓取（可选）',
    description:
      '填好后每次生成日报前会自动连你的邮箱，把消费通知记成账单——这是唯一不用手动操作的来源。不填就跳过，随时可以再开。',
    groups: ['mail'],
  },
  {
    id: 'server',
    title: '⑨ 本地界面',
    description: '固定端口与访问令牌——如果你要把账单界面嵌到别的程序里（比如 DSH 左侧栏），这两项要固定下来。',
    groups: ['server'],
  },
  {
    id: 'data',
    title: '⑩ 数据保留',
    description: '数据只存在这台电脑上，卸载即删除。',
    groups: ['data'],
  },
];

export function buildWizardSteps(): WizardStep[] {
  return STEP_ORDER.map((step) => ({
    id: step.id,
    title: step.title,
    description: step.description,
    fields: CONFIG_FIELDS.filter((f) => step.groups.includes(f.group)),
  }));
}

export interface SubmitResult {
  ok: boolean;
  draft: Record<string, unknown>;
  issues: ConfigIssue[];
}

/**
 * 提交向导答案：以默认值为底，覆盖用户答案，再整体校验。
 * base 允许传入已存在的配置（"重新走一遍向导"场景，不丢已填内容）。
 */
export function submitAnswers(
  answers: Record<string, unknown>,
  base: Record<string, unknown> = defaultConfigDraft(),
): SubmitResult {
  const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  for (const [key, value] of Object.entries(answers)) {
    setByPath(draft, key, value);
  }
  const issues = validateConfigDraft(draft);
  return { ok: issues.length === 0, draft, issues };
}

/** 跳过向导时的安全默认：只手动录入、不推送、不联网 */
export function safeDefaultDraft(): Record<string, unknown> {
  const draft = defaultConfigDraft();
  setByPath(draft, 'host.im', 'none');
  setByPath(draft, 'push.channels', ['local_daily_center']);
  setByPath(draft, 'money.multiCurrency', false);
  setByPath(draft, 'budget.enabled', false);
  setByPath(draft, 'llm.enabled', false);
  return draft;
}

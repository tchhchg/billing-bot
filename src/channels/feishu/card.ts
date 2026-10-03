/**
 * RenderedCard → 飞书交互式卡片 JSON。
 *
 * 隐私约束在这里再次落实：卡片只放聚合数字、分类名与建议标题，
 * 默认**不含商户名与备注**（商户信息留在 evidence 里，只给本地 UI 看）。
 */
import type { AdviceAction } from '../../domain/types.ts';
import type { RenderedCard } from '../../domain/advice/render.ts';

export interface FeishuCardOptions {
  /** 标题右侧的配色：超出基线用 orange，正常用 blue */
  template?: 'blue' | 'orange' | 'red' | 'green' | 'grey';
  /** 附加在按钮 value 里的日期 */
  date: string;
  /** 按钮回调动作上限，避免卡片过长 */
  maxButtons?: number;
}

function severityTemplate(card: RenderedCard): FeishuCardOptions['template'] {
  if (card.advices.some((a) => a.severity === 'warn')) return 'orange';
  if (card.advices.length === 0) return 'blue';
  return 'grey';
}

function toActionValue(action: AdviceAction, date: string): Record<string, string | number> {
  const value: Record<string, string | number> = { act: action.type, date };
  for (const [k, v] of Object.entries(action.payload ?? {})) value[k] = v;
  return value;
}

export function cardFromRendered(card: RenderedCard, options: FeishuCardOptions): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [];

  if (card.summaryLines.length > 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: card.summaryLines.map((l) => `**${l}**`).join('\n') },
    });
  }
  if (card.categoryLines.length > 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: card.categoryLines.join('\n') },
    });
  }

  if (card.adviceLines.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: card.adviceLines.join('\n') },
    });
  }

  const actions: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const max = options.maxButtons ?? 4;
  for (const advice of card.advices) {
    for (const action of advice.actions) {
      const key = `${action.type}:${advice.ruleId}`;
      if (seen.has(key) || actions.length >= max) continue;
      seen.add(key);
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: action.label },
        type: action.type === 'mark_inaccurate' ? 'default' : 'primary',
        value: { ...toActionValue(action, options.date), ruleId: advice.ruleId, adviceId: advice.adviceId },
      });
    }
  }
  if (actions.length > 0) elements.push({ tag: 'action', actions });

  if (card.disclaimers.length > 0) {
    elements.push({
      tag: 'note',
      elements: card.disclaimers.map((text) => ({ tag: 'plain_text', content: text })),
    });
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: card.title },
      template: options.template ?? severityTemplate(card),
    },
    elements,
  };
}

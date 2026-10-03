/**
 * 卡片回调解析（纯函数，便于单测与替换传输层）。
 *
 * 飞书长连接模式下，回调事件到达后必须在 3 秒内响应，否则会超时重推。
 * 因此这里的约定是：**先立即回执，再异步处理**；本模块只做解析与回执构造。
 */
import type { FeedbackAction } from '../../infra/db/feedbackRepo.ts';

export interface CardActionEvent {
  kind: 'card_action';
  eventId: string;
  openId: string | null;
  messageId: string | null;
  /** 按钮 value 里的动作 */
  act: string;
  ruleId: string | null;
  adviceId: string | null;
  date: string | null;
  rawValue: Record<string, unknown>;
  /** 用户点「不准」时在飞书弹出的表单里选的原因 */
  formReason: string | null;
}

export interface UnknownEvent {
  kind: 'unknown';
  eventType: string;
}

export type ParsedCallback = CardActionEvent | UnknownEvent;

const KNOWN_ACTS = new Set(['view_detail', 'snooze', 'mark_inaccurate', 'record_added', 'open_budget']);

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 解析飞书回调原始 payload。
 * 飞书不同版本把数据放在 event / action 下，这里两种都认。
 */
export function parseCallback(payload: unknown): ParsedCallback {
  const root = (payload ?? {}) as Record<string, unknown>;
  const header = (root['header'] ?? {}) as Record<string, unknown>;
  const event = (root['event'] ?? {}) as Record<string, unknown>;
  const eventType = str(header['event_type']) ?? str(root['type']) ?? '';

  const action = (event['action'] ?? root['action'] ?? {}) as Record<string, unknown>;
  const value = (action['value'] ?? {}) as Record<string, unknown>;
  const act = str(value['act']);

  if (eventType !== '' && eventType !== 'card.action.trigger' && act === null) {
    return { kind: 'unknown', eventType };
  }
  if (act === null || !KNOWN_ACTS.has(act)) {
    return { kind: 'unknown', eventType: eventType || '(missing)' };
  }

  const operator = (event['operator'] ?? root['operator'] ?? {}) as Record<string, unknown>;
  const context = (event['context'] ?? root['context'] ?? {}) as Record<string, unknown>;
  const formValue = (action['form_value'] ?? {}) as Record<string, unknown>;

  return {
    kind: 'card_action',
    eventId: str(header['event_id']) ?? '',
    openId: str(operator['open_id']),
    messageId: str(context['open_message_id']) ?? str(event['open_message_id']),
    act,
    ruleId: str(value['ruleId']),
    adviceId: str(value['adviceId']),
    date: str(value['date']),
    rawValue: value,
    formReason: str(formValue['reason']),
  };
}

export interface CallbackOutcome {
  /** 3 秒内必须返回的东西 */
  immediate: { toast: { type: 'info' | 'success' | 'error'; content: string }; cardUpdate?: Record<string, unknown> };
  /** 需要落库的反馈（无则为 null，例如"查看明细"） */
  feedback: { action: FeedbackAction; reason?: string | null; note?: string | null } | null;
  /** 需要在本地 UI 打开的页面 */
  navigate: string | null;
}

const ACCURATE_REASONS = new Set(['数据不完整', '分类错误', '不是我关心的', '其他']);

/** 把一次点击翻译成「前端回执 + 反馈记录 + 跳转」 */
export function handleCardAction(event: CardActionEvent, options: { cooldownDays?: number } = {}): CallbackOutcome {
  switch (event.act) {
    case 'view_detail':
      return {
        immediate: { toast: { type: 'info', content: '已为你打开本地明细页' } },
        feedback: { action: 'viewed' },
        navigate: `/bills?date=${event.date ?? ''}`,
      };

    case 'snooze':
      return {
        immediate: { toast: { type: 'success', content: `已稍后提醒（${options.cooldownDays ?? 3} 天）` } },
        feedback: { action: 'snoozed', note: String(options.cooldownDays ?? 3) },
        navigate: null,
      };

    case 'mark_inaccurate': {
      const reason = event.formReason;
      const valid = reason !== null && ACCURATE_REASONS.has(reason) ? reason : '其他';
      return {
        immediate: { toast: { type: 'success', content: '已记录，会调整这类提醒' } },
        feedback: { action: 'inaccurate', reason: valid },
        navigate: null,
      };
    }

    case 'record_added':
      return {
        immediate: { toast: { type: 'info', content: '已打开补记页面' } },
        feedback: { action: 'record_added' },
        navigate: `/bills/new?date=${event.date ?? ''}`,
      };

    case 'open_budget':
      return {
        immediate: { toast: { type: 'info', content: '已打开预算页' } },
        feedback: { action: 'viewed' },
        navigate: '/budget',
      };

    default:
      return {
        immediate: { toast: { type: 'error', content: '这个操作暂不支持' } },
        feedback: null,
        navigate: null,
      };
  }
}

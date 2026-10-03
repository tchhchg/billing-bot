/** 飞书通道适配器：把渲染结果变成卡片发出去；缺凭证或发送失败时如实返回失败，由上层降级。 */
import type { ChannelAdapter, ChannelPayload, SendResult } from '../adapter.ts';
import { createFeishuClient, type FeishuClient } from './client.ts';
import { cardFromRendered } from './card.ts';

export type ReceiveIdType = 'open_id' | 'chat_id' | 'user_id' | 'email';

/**
 * 从 ID 形态推断投递类型。
 * 这是个真实踩过的坑：群 ID（oc_ 开头）当 open_id 发会报 99992351，
 * 且错误信息只说"ID 无效"，很容易误判成权限问题。
 */
export function inferReceiveIdType(id: string): ReceiveIdType {
  const value = id.trim();
  if (value.startsWith('oc_')) return 'chat_id';
  if (value.startsWith('ou_')) return 'open_id';
  if (value.includes('@')) return 'email';
  return 'open_id';
}

export interface FeishuChannelOptions {
  appId: string;
  appSecret: string;
  receiveId: string;
  /** 不传则按 receiveId 的形态自动推断 */
  receiveIdType?: ReceiveIdType;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  client?: FeishuClient;
}

export function createFeishuChannel(options: FeishuChannelOptions): ChannelAdapter {
  const configured =
    options.appId.trim() !== '' && options.appSecret.trim() !== '' && options.receiveId.trim() !== '';
  const receiveIdType = options.receiveIdType ?? inferReceiveIdType(options.receiveId);
  const client =
    options.client ??
    (configured
      ? createFeishuClient({
          appId: options.appId,
          appSecret: options.appSecret,
          baseUrl: options.baseUrl,
          fetchImpl: options.fetchImpl,
        })
      : null);

  return {
    id: 'im_card',

    capabilities: () => ({ interactive: true, maxBlocks: 20, supportsCallbacks: true }),

    async send(payload: ChannelPayload): Promise<SendResult> {
      if (!configured || !client) {
        return {
          channel: 'im_card',
          ok: false,
          detail: '未配置飞书应用凭证或接收人，已跳过 IM 推送',
        };
      }
      const card = cardFromRendered(payload.card, { date: payload.localDate });
      const result = await client.sendCard({
        receiveId: options.receiveId,
        receiveIdType,
        card,
      });
      return {
        channel: 'im_card',
        ok: result.ok,
        detail: result.ok
          ? `已发送（${receiveIdType}=${options.receiveId.slice(0, 8)}… message_id=${result.messageId ?? '未知'}）`
          : `${result.error ?? '发送失败'}（接收类型 ${receiveIdType}）`,
      };
    },
  };
}

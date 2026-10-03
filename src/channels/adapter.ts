/**
 * 推送通道端口。领域层不认识通道，通道也不认识领域层——
 * 中间只传 RenderedCard（渲染结果）。
 */
import type { RenderedCard } from '../domain/advice/render.ts';

export interface ChannelPayload {
  localDate: string;
  card: RenderedCard;
  adviceIds: string[];
  /** 修正版（推送后数据发生变更） */
  revision: number;
}

export interface SendResult {
  channel: string;
  ok: boolean;
  detail?: string;
  latencyMs?: number;
  /** 该渠道失败后是否已降级 */
  degraded?: boolean;
}

export interface ChannelAdapter {
  readonly id: string;
  send(payload: ChannelPayload): Promise<SendResult>;
  capabilities(): { interactive: boolean; maxBlocks: number; supportsCallbacks: boolean };
}

/**
 * 按配置顺序依次尝试，第一个成功即返回；
 * 全部失败时返回最后一组结果（调用方据此标记 failed 并保留本地内容）。
 */
export async function tryChannelsInOrder(
  adapters: readonly ChannelAdapter[],
  payload: ChannelPayload,
): Promise<SendResult[]> {
  const results: SendResult[] = [];
  for (const adapter of adapters) {
    const started = Date.now();
    let result: SendResult;
    try {
      result = await adapter.send(payload);
    } catch (error) {
      result = { channel: adapter.id, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    result.latencyMs = Date.now() - started;
    results.push(result);
    if (result.ok) return results;
  }
  return results;
}

export function pickAdapters(ids: readonly string[], available: readonly ChannelAdapter[]): ChannelAdapter[] {
  const map = new Map(available.map((a) => [a.id, a]));
  const picked: ChannelAdapter[] = [];
  for (const id of ids) {
    const adapter = map.get(id);
    if (adapter) picked.push(adapter);
  }
  // 本地日报中心永远兜底，保证内容不丢
  const local = map.get('local_daily_center');
  if (local && !picked.some((a) => a.id === 'local_daily_center')) picked.push(local);
  return picked;
}

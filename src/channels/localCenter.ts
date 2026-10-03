/**
 * 「本地日报中心」通道：卡片内容本来就随 daily_run 快照落库了，
 * 这里只是确认可用，并保证它永远是最后的兜底通道——
 * 因此"所有通道都失败"时内容也不会丢。
 */
import type { ChannelAdapter, ChannelPayload, SendResult } from './adapter.ts';

export function createLocalDailyCenterAdapter(): ChannelAdapter {
  return {
    id: 'local_daily_center',
    capabilities: () => ({ interactive: true, maxBlocks: Number.MAX_SAFE_INTEGER, supportsCallbacks: false }),
    async send(payload: ChannelPayload): Promise<SendResult> {
      return {
        channel: 'local_daily_center',
        ok: true,
        detail: `已写入本地日报中心（${payload.localDate}，revision ${payload.revision}）`,
      };
    },
  };
}

/**
 * 配置飞书凭证（从环境变量读取，避免出现在命令行历史与日志里）。
 *
 *   BB_APP_ID=cli_xxx BB_APP_SECRET=xxx node scripts/configure-feishu.ts
 *
 * App ID 写进 config.json；App Secret 写进本机 secrets.json（0600）。
 */
import { createConfigStore, resolveDataDir } from '../src/infra/config/store.ts';
import { defaultConfigDraft, setByPath } from '../src/infra/config/schema.ts';

export const SECRET_KEY = 'host.feishuAppSecret';

const appId = process.env.BB_APP_ID ?? '';
const appSecret = process.env.BB_APP_SECRET ?? '';
const receiveId = (process.env.BB_RECEIVE_ID ?? '').trim();

const dataDir = resolveDataDir();
const store = createConfigStore(dataDir);
const existingSecret = store.getSecret(SECRET_KEY) ?? '';
const existingAppId = String(
  (store.load()?.draft as { host?: { feishuAppId?: string } } | null)?.host?.feishuAppId ?? '',
);

let effectiveAppId = appId.trim();
let effectiveSecret = appSecret.trim();
if (effectiveAppId === '') effectiveAppId = existingAppId;
if (effectiveSecret === '') effectiveSecret = existingSecret;

if (effectiveAppId === '' || effectiveSecret === '') {
  console.error('缺少 App ID 或 App Secret：首次配置请提供 BB_APP_ID 与 BB_APP_SECRET；');
  console.error('只更新接收人时，可省略 BB_APP_ID（会沿用本机已保存的值）。');
  process.exit(1);
}

const draft = store.load()?.draft ?? defaultConfigDraft();
setByPath(draft, 'host.im', 'feishu');
setByPath(draft, 'host.feishuAppId', effectiveAppId);
if (receiveId !== '') setByPath(draft, 'push.imRecipient', receiveId);

// 配了飞书就一定把 IM 卡片加进推送渠道，否则日报只会进本地日报中心
const channels = ((draft as { push?: { channels?: string[] } }).push?.channels ?? []).slice();
if (!channels.includes('im_card')) channels.unshift('im_card');
if (!channels.includes('local_daily_center')) channels.push('local_daily_center');
setByPath(draft, 'push.channels', channels);

store.save(draft);
store.setSecret(SECRET_KEY, effectiveSecret);

console.log(`[configure] 数据目录：${dataDir}`);
console.log(`[configure] App ID：${effectiveAppId.slice(0, 10)}…（已写入 config.json）`);
console.log(`[configure] App Secret：${'*'.repeat(8)}（已写入 secrets.json，长度 ${effectiveSecret.length}）`);
console.log(`[configure] 推送渠道：${channels.join('、')}`);
console.log(`[configure] 接收人：${receiveId === '' ? '未设置（待发现）' : receiveId}`);

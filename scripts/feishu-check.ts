/**
 * 飞书连通性诊断：验证凭证 → 找接收人 → 可选发一张测试卡片。
 *
 *   node scripts/feishu-check.ts              # 只验证凭证并尝试发现接收人
 *   node scripts/feishu-check.ts --send       # 额外发一张测试卡片
 *   node scripts/feishu-check.ts --send --to ou_xxx
 *
 * 只读取本机密钥文件，不打印密钥本身。
 */
import { createConfigStore, resolveDataDir } from '../src/infra/config/store.ts';
import { createFeishuClient } from '../src/channels/feishu/client.ts';

const SECRET_KEY = 'host.feishuAppSecret';
const BASE = 'https://open.feishu.cn';

const store = createConfigStore(resolveDataDir());
const draft = store.load()?.draft ?? {};
const appId = String((draft as { host?: { feishuAppId?: string } }).host?.feishuAppId ?? '');
const appSecret = store.getSecret(SECRET_KEY) ?? '';
const configuredRecipient = String((draft as { push?: { imRecipient?: string } }).push?.imRecipient ?? '');

const args = process.argv.slice(2);
const shouldSend = args.includes('--send');
const toIndex = args.indexOf('--to');
const explicitRecipient = toIndex >= 0 ? (args[toIndex + 1] ?? '') : '';

if (appId === '' || appSecret === '') {
  console.error('本机还没配置飞书凭证，请先运行 scripts/configure-feishu.ts');
  process.exit(1);
}

const client = createFeishuClient({ appId, appSecret });

/** 把飞书业务码翻译成人话 + 该做什么 */
export function explainCode(code: number | undefined, api: string): string {
  switch (code) {
    case 0:
      return '成功';
    case 99991672:
      return `缺权限（${api}）：去开发者后台开通对应 scope，然后**创建新版本并发布**。`;
    case 232034:
      return `应用在当前企业未生效（${api}）：通常是①权限改完没发布新版本，或②应用未在管理后台启用，或③应用没开「机器人」能力。`;
    case 99992351:
      return `接收人 ID 无效（${api}）：权限没问题，是 ID 不存在或不属于该企业。`;
    case 230002:
      return `接收人不存在或不在应用可用范围内（${api}）。`;
    default:
      return `${api} 返回 code=${code ?? '未知'}`;
  }
}

async function call(path: string, token: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() };
}

// ---------------------------------------------------------------- 1. 凭证
let token = '';
try {
  token = await client.getTenantAccessToken();
  console.log(`✅ 凭证有效（tenant_access_token 长度 ${token.length}，已缓存）`);
} catch (error) {
  console.error(`❌ 凭证无效：${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

// ---------------------------------------------------------------- 2. 机器人自身信息
interface BotInfo {
  activate_status?: number;
  app_name?: string;
  open_id?: string;
}

const botResponse = await call('/open-apis/bot/v3/info', token);
const bot = (botResponse.body as { code?: number; msg?: string; bot?: BotInfo }).bot;
const botCode = (botResponse.body as { code?: number }).code;
if (botCode === 0 && bot) {
  console.log(`🤖 机器人：${bot.app_name ?? '(无名)'}（activate_status=${bot.activate_status ?? '?'}，open_id=${bot.open_id ?? '?'}）`);
  console.log(`   → 在飞书里搜索「${bot.app_name ?? ''}」就能找到它，把它添加进任意群即可`);
} else {
  console.log(`ℹ️  读取机器人信息失败：${explainCode(botCode, 'bot/v3/info')}`);
}

// ---------------------------------------------------------------- 3. 发现接收人
async function discover(): Promise<{ chatId: string | null; openId: string | null }> {
  const chats = await call('/open-apis/im/v1/chats?page_size=20', token);
  const chatBody = chats.body as { code?: number; msg?: string; data?: { items?: Array<{ chat_id?: string; name?: string }> } };
  if (chatBody.code === 0) {
    const items = chatBody.data?.items ?? [];
    console.log(`ℹ️  机器人所在会话：${items.length} 个`);
    for (const item of items) console.log(`     - ${item.name ?? '(无名)'} chat_id=${item.chat_id ?? ''}`);
    if (items.length > 0) return { chatId: items[0]?.chat_id ?? null, openId: null };
  } else {
    console.log(`ℹ️  读取会话列表失败：${explainCode(chatBody.code, 'im/v1/chats')}`);
  }

  // 通讯录有两种列法，依次尝试（都需要通讯录权限 + 部门范围）
  const userPaths = [
    '/open-apis/contact/v3/users/find_by_department?department_id=0&page_size=20',
    '/open-apis/contact/v3/users?department_id=0&page_size=20',
  ];
  for (const path of userPaths) {
    const users = await call(path, token);
    const userBody = users.body as { code?: number; msg?: string; data?: { items?: Array<{ open_id?: string; name?: string }> } };
    if (userBody.code === 0) {
      const items = userBody.data?.items ?? [];
      console.log(`ℹ️  通讯录可见用户：${items.length} 个`);
      for (const item of items) console.log(`     - ${item.name ?? '(无名)'} open_id=${item.open_id ?? ''}`);
      if (items.length > 0) return { chatId: null, openId: items[0]?.open_id ?? null };
      break;
    }
    if (userBody.code !== 99991672) {
      console.log(`ℹ️  读取通讯录失败：${explainCode(userBody.code, path.split('?')[0] ?? path)}`);
      break;
    }
    if (path === userPaths[userPaths.length - 1]) {
      console.log(`ℹ️  读取通讯录失败：${explainCode(userBody.code, 'contact/v3/users')}`);
    }
  }
  return { chatId: null, openId: null };
}

/** --to 支持直接粘群链接：openChatId=oc_xxx / chat_id=oc_xxx 都能认出来 */
export function extractId(raw: string): string {
  const trimmed = raw.trim().replace(/^["'<]|["'>]$/g, '');
  const fromUrl = /(?:openChatId|chat_id|chatId|open_id|openId)=([A-Za-z0-9_-]+)/.exec(trimmed);
  if (fromUrl?.[1]) return fromUrl[1];
  return trimmed;
}

const discovered = await discover();
const explicit = extractId(explicitRecipient || configuredRecipient);
const recipient = explicit || discovered.chatId || discovered.openId || '';

/** 三种 ID 形态都能发：oc_ 开头是群、含 @ 是邮箱、其余按 open_id */
function typeOf(id: string): 'open_id' | 'chat_id' | 'email' {
  if (id.startsWith('oc_')) return 'chat_id';
  if (id.includes('@')) return 'email';
  return 'open_id';
}
const recipientType = recipient === '' ? 'open_id' : typeOf(recipient);

if (recipient === '') {
  const needed = ['im:message:send_as_bot', 'im:chat:readonly'];
  const grantUrl = `${BASE.replace('open.feishu.cn', 'open.feishu.cn')}/app/${appId}/auth?q=${needed.join(',')}&op_from=openapi&token_type=tenant`;
  console.log('');
  console.log('⚠️  凭证没问题，但还缺两样东西才能把日报发出去：');
  console.log('');
  console.log('  ① 开通权限（当前缺 im:chat:readonly，发消息还必须有 im:message:send_as_bot）');
  console.log(`     ${grantUrl}`);
  console.log('     开通后记得在「版本管理与发布」里创建一个新版本并发布，权限才会生效。');
  console.log('');
  console.log('  ② 给出接收人（二选一）：');
  console.log('     A. 在飞书里新建一个群 → 把机器人拉进群 → 再跑一次本脚本，会自动列出 chat_id');
  console.log('     B. 直接把你的 open_id / chat_id 告诉我：node scripts/feishu-check.ts --send --to ou_xxx');
  process.exit(3);
}
console.log(`✅ 接收人：${recipientType}=${recipient}`);

// ---------------------------------------------------------------- 3. 可选发卡片
if (!shouldSend) {
  console.log('（加 --send 可以发一张测试卡片）');
  process.exit(0);
}

const card = {
  config: { wide_screen_mode: true },
  header: { title: { tag: 'plain_text', content: 'billing-bot 连通性测试' }, template: 'blue' },
  elements: [
    { tag: 'div', text: { tag: 'lark_md', content: '如果你看到这张卡片，说明**推送链路已打通**。' } },
    { tag: 'note', elements: [{ tag: 'plain_text', content: '这是本地程序发出的测试消息，不含任何账单数据。' }] },
  ],
};

const result = await client.sendCard({ receiveId: recipient, receiveIdType: recipientType as 'open_id' | 'chat_id', card });
if (result.ok) {
  console.log(`✅ 测试卡片已发出：message_id=${result.messageId ?? '未知'}`);
} else {
  console.error(`❌ 发送失败：code=${result.code ?? '-'} ${result.error ?? ''}`);
  process.exit(4);
}

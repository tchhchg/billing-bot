/**
 * 飞书开放平台客户端（只用 fetch，不引 SDK）。
 *
 * 说明：这里实现的是**出站**能力（取 tenant_access_token 并发消息）。
 * 入站回调（卡片按钮）走「长连接」，需要在本地进程里集成飞书 SDK；
 * 因此回调解析被拆成纯函数（callback.ts），便于单测与替换。
 */
export interface FeishuClientOptions {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** token 提前多少毫秒视为过期 */
  tokenSkewMs?: number;
}

export interface SendCardArgs {
  receiveId: string;
  /** open_id | chat_id | user_id | email */
  receiveIdType?: 'open_id' | 'chat_id' | 'user_id' | 'email';
  card: Record<string, unknown>;
  replyToMessageId?: string;
}

export interface FeishuSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** 飞书返回的业务码 */
  code?: number;
}

export interface FeishuClient {
  getTenantAccessToken(): Promise<string>;
  sendCard(args: SendCardArgs): Promise<FeishuSendResult>;
  updateCard(args: { messageId: string; card: Record<string, unknown> }): Promise<FeishuSendResult>;
  /** 测试/诊断用：已缓存 token 的剩余有效期 */
  tokenState(): { cached: boolean; expiresAt: number };
}

interface TokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface SendResponse {
  code: number;
  msg?: string;
  data?: { message_id?: string };
}

export function createFeishuClient(options: FeishuClientOptions): FeishuClient {
  const baseUrl = (options.baseUrl ?? 'https://open.feishu.cn').replace(/\/$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const skew = options.tokenSkewMs ?? 60_000;
  let token = '';
  let expiresAt = 0;
  let inflight: Promise<string> | null = null;

  const requestToken = async (): Promise<string> => {
    const response = await doFetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: options.appId, app_secret: options.appSecret }),
    });
    const payload = (await response.json()) as TokenResponse;
    if (payload.code !== 0 || !payload.tenant_access_token) {
      throw new Error(`获取 tenant_access_token 失败：code=${payload.code} ${payload.msg ?? ''}`);
    }
    token = payload.tenant_access_token;
    expiresAt = Date.now() + (payload.expire ?? 7200) * 1000 - skew;
    return token;
  };

  const getToken = async (): Promise<string> => {
    if (token !== '' && Date.now() < expiresAt) return token;
    // 并发去重：同时到来的多条推送只请求一次 token
    inflight ??= requestToken().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const callSend = async (path: string, body: Record<string, unknown>): Promise<FeishuSendResult> => {
    try {
      const accessToken = await getToken();
      const response = await doFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as SendResponse;
      if (payload.code !== 0) {
        return { ok: false, code: payload.code, error: payload.msg ?? `飞书返回 code=${payload.code}` };
      }
      return { ok: true, messageId: payload.data?.message_id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  return {
    getTenantAccessToken: getToken,

    async sendCard(args): Promise<FeishuSendResult> {
      const receiveIdType = args.receiveIdType ?? 'open_id';
      return callSend(`/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
        receive_id: args.receiveId,
        msg_type: 'interactive',
        content: JSON.stringify(args.card),
      });
    },

    async updateCard(args): Promise<FeishuSendResult> {
      return callSend(`/open-apis/im/v1/messages/${encodeURIComponent(args.messageId)}`, {
        msg_type: 'interactive',
        content: JSON.stringify(args.card),
      });
    },

    tokenState(): { cached: boolean; expiresAt: number } {
      return { cached: token !== '' && Date.now() < expiresAt, expiresAt };
    },
  };
}

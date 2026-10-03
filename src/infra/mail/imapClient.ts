/**
 * IMAP 抓取端口 + 真实实现。
 *
 * 为什么用 imapflow 而不是手写：各家邮箱的怪癖太多——
 * 163 要求登录后先发 ID 命令、QQ/163 必须用授权码而不是登录密码、
 * Gmail 要用应用专用密码、UTF-7 邮箱名、字面量（literal）分帧……
 * 手写一个能覆盖这些的实现，风险远大于收益。
 *
 * 因此它是**可选依赖**：没装时这个模块抛出明确错误，其余功能完全不受影响。
 * 上层的用例只依赖 MailClient 这个端口，测试用假实现即可，不需要真连邮箱。
 */

export interface MailFetchRequest {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
  /** 只看这个日期（含）之后的邮件，YYYY-MM-DD */
  sinceDate: string;
  /** 只在服务端取发件人含此关键词的邮件（短信转发场景用）；空则取全部 */
  senderFilter?: string;
  /** 单次最多取几封，防止一次拉几千封 */
  maxMessages: number;
}

export interface MailMessage {
  uid: number;
  /** 原始 RFC822 内容，交给 parseEml 处理 */
  source: Uint8Array;
}

export interface MailClient {
  fetchSince(request: MailFetchRequest): Promise<MailMessage[]>;
}

export class MailClientUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailClientUnavailableError';
  }
}

/** 装了 imapflow 就返回真实客户端；没装则抛出可读错误 */
export function createImapClient(): MailClient {
  return {
    async fetchSince(request: MailFetchRequest): Promise<MailMessage[]> {
      let ImapFlowCtor: new (options: unknown) => ImapFlowLike;
      try {
        const specifier = 'imapflow';
        const mod = (await import(specifier)) as { ImapFlow?: new (options: unknown) => ImapFlowLike };
        if (!mod.ImapFlow) throw new Error('imapflow 未导出 ImapFlow');
        ImapFlowCtor = mod.ImapFlow;
      } catch (error) {
        throw new MailClientUnavailableError(
          `邮件抓取需要可选依赖 imapflow（pnpm add imapflow）。当前不可用：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const client = new ImapFlowCtor({
        host: request.host,
        port: request.port,
        secure: request.secure,
        auth: { user: request.user, pass: request.password },
        logger: false,
      });

      const messages: MailMessage[] = [];
      await client.connect();
      const lock = await client.getMailboxLock(request.mailbox);
      try {
        const since = new Date(`${request.sinceDate}T00:00:00Z`);
        const filter = (request.senderFilter ?? '').trim();
        // 有筛选就交给服务端（SEARCH FROM），避免把整箱邮件都下载下来
        const query: Record<string, unknown> = { since };
        if (filter !== '') query['from'] = filter;
        const found = await client.search(query, { uid: true });
        const uids = Array.isArray(found) ? found : [];
        const wanted = uids.slice(-request.maxMessages);
        if (wanted.length === 0) return [];
        for await (const message of client.fetch(
          wanted,
          { uid: true, source: true },
          { uid: true },
        )) {
          if (!message.source) continue;
          messages.push({ uid: message.uid, source: new Uint8Array(message.source) });
        }
      } finally {
        lock.release();
        await client.logout();
      }
      return messages;
    },
  };
}

/** 只用到的那部分 imapflow 接口（避免把它的类型带进项目） */
interface ImapFlowLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(mailbox: string): Promise<{ release(): void }>;
  search(query: unknown, options: { uid: boolean }): Promise<number[] | false>;
  fetch(
    range: readonly number[],
    query: { uid: boolean; source: boolean },
    options: { uid: boolean },
  ): AsyncIterable<{ uid: number; source?: Buffer }>;
}

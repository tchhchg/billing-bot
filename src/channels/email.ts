/**
 * 出站邮件（自己写的最小 SMTP 客户端，零依赖）。
 *
 * 为什么不用第三方库：核心卖点就是"零运行时依赖"，而我们要的只是
 * "连上、登录、发一封 UTF-8 纯文本"——`node:tls` + `node:net` 足够。
 *
 * 支持三种连接方式：
 *   tls      —— 直连 TLS（QQ/163/Gmail 的 465）
 *   starttls —— 明文连接后升级（Outlook 的 587）
 *   plain    —— 纯明文（本机中继 / 测试用）
 *
 * 正文用 base64 传输：既天然 UTF-8 安全，又**不需要做点填充**（SMTP 里
 * 以 "." 开头的行必须转义，base64 不会产生这种情况）。
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';

export interface EmailMessage {
  host: string;
  port: number;
  secure: 'tls' | 'starttls' | 'plain';
  user: string;
  password: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  timeoutMs?: number;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

/** 发送失败时抛出，调用方据此进"待发队列"并在界面上显式告警。 */
export class EmailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailSendError';
  }
}

type AnySocket = Socket | TLSSocket;

async function waitConnected(socket: AnySocket, secure: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once(secure ? 'secureConnect' : 'connect', () => resolve());
    socket.once('error', (error) => reject(error));
  });
}

/** 行读取器：把 socket 数据切成行，允许"先到先读" */
function createReader(socket: AnySocket): { read: () => Promise<string> } {
  const queue: string[] = [];
  let waiter: ((line: string) => void) | null = null;
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index + 1);
      buffer = buffer.slice(index + 1);
      if (waiter) {
        const resolve = waiter;
        waiter = null;
        resolve(line);
      } else {
        queue.push(line);
      }
      index = buffer.indexOf('\n');
    }
  });
  return {
    read: () => {
      const buffered = queue.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      return new Promise<string>((resolve) => {
        waiter = resolve;
      });
    },
  };
}

/** 读一条完整 SMTP 应答（多行应答以 "250-" 续行、"250 " 结束） */
async function readReply(read: () => Promise<string>): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  for (;;) {
    const line = await read();
    const trimmed = line.replace(/\r?\n$/, '');
    lines.push(trimmed);
    const match = /^(\d{3})([ -])/.exec(trimmed);
    if (match && match[2] === ' ') break;
    if (lines.length > 60) break;
  }
  const first = lines[0] ?? '';
  const code = Number(first.slice(0, 3));
  return { code: Number.isFinite(code) ? code : 0, text: lines.join('\n') };
}

export function buildMimeMessage(message: Pick<EmailMessage, 'from' | 'to' | 'subject' | 'text'>): string {
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    // 中文主题必须走 RFC 2047 编码，否则很多客户端会显示乱码
    `Subject: =?UTF-8?B?${Buffer.from(message.subject, 'utf8').toString('base64')}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@billing-bot.local>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(message.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

async function sendViaSmtp(message: EmailMessage): Promise<void> {
  const timeoutMs = message.timeoutMs ?? 20000;
  const secure = message.secure === 'tls';
  let socket: AnySocket = secure
    ? tlsConnect({ host: message.host, port: message.port, servername: message.host })
    : netConnect({ host: message.host, port: message.port });

  const fail = (detail: string): never => {
    try {
      socket.destroy();
    } catch {
      /* 已经断了就算了 */
    }
    throw new EmailSendError(detail);
  };

  try {
    socket.setTimeout(timeoutMs);
    await waitConnected(socket, secure);
    let read = createReader(socket).read;

    const expect = async (expected: readonly number[], what: string): Promise<void> => {
      const reply = await readReply(read);
      if (!expected.includes(reply.code)) {
        fail(`${what} 失败：服务器返回 ${reply.code || '无应答'} ${reply.text.split('\n')[0] ?? ''}`);
      }
    };

    await expect([220], '连接');

    const send = (line: string): void => {
      socket.write(`${line}\r\n`);
    };

    send('EHLO billing-bot.local');
    await expect([250], 'EHLO');

    if (message.secure === 'starttls') {
      send('STARTTLS');
      await expect([220], 'STARTTLS');
      const upgraded = tlsConnect({ socket, servername: message.host });
      await waitConnected(upgraded, true);
      socket = upgraded;
      socket.setTimeout(timeoutMs);
      read = createReader(socket).read;
      send('EHLO billing-bot.local');
      await expect([250], 'EHLO（加密后）');
    }

    // 有账号才认证（本机中继通常不需要）
    if (message.user !== '') {
      send('AUTH LOGIN');
      await expect([334], 'AUTH LOGIN');
      send(Buffer.from(message.user, 'utf8').toString('base64'));
      await expect([334], 'AUTH 用户名');
      send(Buffer.from(message.password, 'utf8').toString('base64'));
      await expect([235], 'AUTH 密码（多半是授权码/密码不对）');
    }

    send(`MAIL FROM:<${message.from}>`);
    await expect([250], 'MAIL FROM');
    send(`RCPT TO:<${message.to}>`);
    await expect([250, 251], 'RCPT TO');
    send('DATA');
    await expect([354], 'DATA');
    socket.write(`${buildMimeMessage(message)}\r\n.\r\n`);
    await expect([250], '邮件正文');

    send('QUIT');
    // QUIT 的应答不关键，失败也不影响已投递的事实
    try {
      await readReply(read);
    } catch {
      /* 忽略 */
    }
  } catch (error) {
    if (error instanceof EmailSendError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    socket.destroy();
    throw new EmailSendError(`连接邮件服务器失败：${detail}`);
  } finally {
    try {
      socket.destroy();
    } catch {
      /* 忽略 */
    }
  }
}

export function createSmtpTransport(): EmailTransport {
  return { send: (message) => sendViaSmtp(message) };
}

/** 由 IMAP 主机推 SMTP 主机：QQ/163/Gmail/iCloud 都是 imap.X ↔ smtp.X 的命名习惯 */
export function deriveSmtpHost(imapHost: string): string {
  const host = imapHost.trim();
  if (host === '') return '';
  if (host.startsWith('imap.')) return `smtp.${host.slice(5)}`;
  return host;
}

export function defaultSmtpPort(secure: 'tls' | 'starttls' | 'plain'): number {
  return secure === 'starttls' ? 587 : 465;
}

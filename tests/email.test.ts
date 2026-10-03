import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import {
  buildMimeMessage,
  createSmtpTransport,
  defaultSmtpPort,
  deriveSmtpHost,
  EmailSendError,
} from '../src/channels/email.ts';

/** 假 SMTP 服务器：记录收到的命令，按脚本应答 */
interface FakeServer {
  port: number;
  commands: string[];
  data: string;
  authUser: string | null;
  authPass: string | null;
  close: () => Promise<void>;
}

async function startFakeSmtp(options: { authFails?: boolean; greetingFail?: boolean } = {}): Promise<FakeServer> {
  const commands: string[] = [];
  const state = { data: '', authUser: null as string | null, authPass: null as string | null, stage: 'user' as 'user' | 'pass' };
  const server: Server = createServer((socket: Socket) => {
    socket.setEncoding('utf8');
    if (options.greetingFail) {
      socket.write('421 服务不可用\r\n');
      return;
    }
    socket.write('220 fake.local ESMTP\r\n');
    let buffer = '';
    let inData = false;
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\r\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else {
            state.data += `${line}\n`;
          }
          continue;
        }
        commands.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) socket.write('250-fake.local\r\n250-SIZE 10240000\r\n250 AUTH LOGIN\r\n');
        else if (upper === 'AUTH LOGIN') socket.write('334 VXNlcm5hbWU6\r\n');
        else if (state.stage === 'user' && !upper.startsWith('MAIL') && !upper.startsWith('RCPT') && !upper.startsWith('DATA') && !upper.startsWith('QUIT')) {
          state.authUser = Buffer.from(line, 'base64').toString('utf8');
          state.stage = 'pass';
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (state.stage === 'pass') {
          state.authPass = Buffer.from(line, 'base64').toString('utf8');
          state.stage = 'user';
          socket.write(options.authFails ? '535 5.7.8 认证失败\r\n' : '235 2.7.0 认证成功\r\n');
        } else if (upper.startsWith('MAIL')) socket.write('250 2.1.0 Ok\r\n');
        else if (upper.startsWith('RCPT')) socket.write('250 2.1.5 Ok\r\n');
        else if (upper.startsWith('DATA')) {
          inData = true;
          socket.write('354 开始发送\r\n');
        } else if (upper.startsWith('QUIT')) {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else socket.write('250 Ok\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    commands,
    get data() {
      return state.data;
    },
    get authUser() {
      return state.authUser;
    },
    get authPass() {
      return state.authPass;
    },
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  } as unknown as FakeServer & { data: string };
}

test('SMTP：完整发信流程，命令序列与正文都正确', async () => {
  const smtp = (await startFakeSmtp()) as FakeServer & { data: string };
  try {
    const transport = createSmtpTransport();
    await transport.send({
      host: '127.0.0.1',
      port: smtp.port,
      secure: 'plain',
      user: 'me@example.com',
      password: 'auth-code-16',
      from: 'me@example.com',
      to: 'me@example.com',
      subject: '账单日报 · 2026-10-03',
      text: '今日支出 46.50 元\n建议：餐饮连续偏高\n',
    });

    assert.deepEqual(
      smtp.commands
        .filter((c) => /^(EHLO|AUTH|MAIL|RCPT|DATA|QUIT)/i.test(c))
        .map((c) => (c.split(' ')[0] ?? '').toUpperCase()),
      ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT'],
    );
    assert.ok(smtp.commands.some((c) => c === 'MAIL FROM:<me@example.com>'), 'MAIL FROM 应为发件人');
    assert.ok(smtp.commands.some((c) => c === 'RCPT TO:<me@example.com>'), 'RCPT TO 应为收件人');

    // 认证用的就是配置里的授权码（base64 解码后应完全一致）
    const fake = smtp as unknown as { authUser: string | null; authPass: string | null; data: string };
    assert.equal(fake.authUser, 'me@example.com');
    assert.equal(fake.authPass, 'auth-code-16');

    // 正文是 base64，解出来应还原原文（含中文与换行）
    // 注意：假服务器按行累积，头部与正文之间是一个空行 —— 必须按空行切，不能用尾部长串正则
    const parts = fake.data.split('\n\n');
    assert.equal(parts.length >= 2, true, '应能切出头部与正文');
    const bodyBase64 = parts[1] ?? '';
    assert.equal(
      Buffer.from(bodyBase64, 'base64').toString('utf8'),
      '今日支出 46.50 元\n建议：餐饮连续偏高\n',
    );
  } finally {
    await smtp.close();
  }
});

test('SMTP：无账号时不发 AUTH（本机中继场景）', async () => {
  const smtp = (await startFakeSmtp()) as FakeServer & { data: string };
  try {
    await createSmtpTransport().send({
      host: '127.0.0.1',
      port: smtp.port,
      secure: 'plain',
      user: '',
      password: '',
      from: 'a@b.c',
      to: 'd@e.f',
      subject: 'x',
      text: 'y',
    });
    assert.equal(smtp.commands.some((c) => c.toUpperCase().startsWith('AUTH')), false);
  } finally {
    await smtp.close();
  }
});

test('SMTP：认证失败时给出可读错误（而不是静默）', async () => {
  const smtp = (await startFakeSmtp({ authFails: true })) as FakeServer & { data: string };
  try {
    await assert.rejects(
      () =>
        createSmtpTransport().send({
          host: '127.0.0.1',
          port: smtp.port,
          secure: 'plain',
          user: 'me@example.com',
          password: 'wrong',
          from: 'me@example.com',
          to: 'me@example.com',
          subject: 's',
          text: 't',
        }),
      (error: Error) => {
        assert.ok(error instanceof EmailSendError);
        assert.match(error.message, /535|授权码|密码/);
        return true;
      },
    );
  } finally {
    await smtp.close();
  }
});

test('SMTP：连不上时抛出可读错误', async () => {
  // 用一个刚关闭的端口，保证连接被拒
  const smtp = (await startFakeSmtp()) as FakeServer & { data: string };
  const port = smtp.port;
  await smtp.close();
  await assert.rejects(
    () =>
      createSmtpTransport().send({
        host: '127.0.0.1',
        port,
        secure: 'plain',
        user: '',
        password: '',
        from: 'a@b.c',
        to: 'd@e.f',
        subject: 's',
        text: 't',
      }),
    (error: Error) => {
      assert.ok(error instanceof EmailSendError);
      assert.match(error.message, /连接邮件服务器失败/);
      return true;
    },
  );
});

test('MIME：中文主题走 RFC 2047 编码，正文长行按 76 列折行', () => {
  const message = buildMimeMessage({
    from: 'me@qq.com',
    to: 'me@qq.com',
    subject: '账单日报 · 2026-10-03',
    text: 'A'.repeat(400),
  });
  const lines = message.split('\r\n');
  assert.ok(lines.some((l) => l.startsWith('Subject: =?UTF-8?B?')), '主题应 RFC2047 编码');
  assert.ok(lines.some((l) => l.startsWith('Content-Transfer-Encoding: base64')));
  const bodyLines = message.split('\r\n\r\n')[1]?.split('\r\n') ?? [];
  assert.ok(bodyLines.every((l) => l.length <= 76), '每行不超过 76 列');
  const decoded = Buffer.from(bodyLines.join(''), 'base64').toString('utf8');
  assert.equal(decoded, 'A'.repeat(400));
});

test('SmtpHost 推导与默认端口', () => {
  assert.equal(deriveSmtpHost('imap.qq.com'), 'smtp.qq.com');
  assert.equal(deriveSmtpHost('imap.163.com'), 'smtp.163.com');
  assert.equal(deriveSmtpHost('imap.gmail.com'), 'smtp.gmail.com');
  assert.equal(deriveSmtpHost('mail.example.com'), 'mail.example.com');
  assert.equal(deriveSmtpHost(''), '');
  assert.equal(defaultSmtpPort('starttls'), 587);
  assert.equal(defaultSmtpPort('tls'), 465);
});

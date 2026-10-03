/**
 * 最小可用的 .eml 解析（零依赖）。
 *
 * 只做消费通知邮件真正需要的那部分：头部解码（RFC2047）、
 * multipart 递归、base64 / quoted-printable、按 charset 解码、HTML 降级为纯文本、附件收集。
 * 不做签名校验、不做复杂嵌套优化——够用且可测。
 */

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface ParsedEmail {
  subject: string;
  from: string;
  /** Date 头解析出的 ISO 时间；解析不出为 null */
  date: string | null;
  messageId: string | null;
  /** 纯文本正文（优先 text/plain，其次 HTML 去标签） */
  textBody: string;
  usedHtml: boolean;
  attachments: ParsedAttachment[];
  charsetUsed: string;
}

function decodeCharset(bytes: Uint8Array, charset: string | undefined): { text: string; charset: string } {
  const candidates = [charset, 'utf-8', 'gb18030', 'iso-8859-1'].filter(
    (c): c is string => typeof c === 'string' && c !== '',
  );
  for (const candidate of candidates) {
    try {
      return { text: new TextDecoder(candidate).decode(bytes), charset: candidate };
    } catch {
      continue;
    }
  }
  return { text: Buffer.from(bytes).toString('latin1'), charset: 'latin1' };
}

/** =?UTF-8?B?xxx?= / =?GBK?Q?xxx?= 编码字 */
export function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset: string, kind: string, payload: string) => {
    try {
      const bytes =
        kind.toUpperCase() === 'B'
          ? Buffer.from(payload, 'base64')
          : quotedPrintableToBytes(payload.replace(/_/g, ' '));
      return decodeCharset(bytes, charset).text;
    } catch {
      return payload;
    }
  });
}

function quotedPrintableToBytes(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] as string;
    if (ch === '=') {
      const hex = input.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
      // 软换行 "=\r\n" 直接丢弃
      if (hex.startsWith('\r') || hex.startsWith('\n')) continue;
      out.push(0x3d);
      continue;
    }
    out.push(ch.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(out);
}

function decodeQuotedPrintable(input: string): Uint8Array {
  const withoutSoftBreaks = input.replace(/=\r?\n/g, '');
  return quotedPrintableToBytes(withoutSoftBreaks);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface HeaderMap {
  get(name: string): string | undefined;
  raw: Map<string, string>;
}

function parseHeaders(block: string): HeaderMap {
  const raw = new Map<string, string>();
  const lines = block.split(/\r?\n/);
  let current = '';
  const push = (): void => {
    if (current === '') return;
    const index = current.indexOf(':');
    if (index > 0) {
      const name = current.slice(0, index).trim().toLowerCase();
      const value = current.slice(index + 1).trim();
      raw.set(name, raw.has(name) ? `${raw.get(name)} ${value}` : value);
    }
    current = '';
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current !== '') {
      current += ` ${line.trim()}`; // 折行还原
      continue;
    }
    push();
    current = line;
  }
  push();
  return { get: (name) => raw.get(name.toLowerCase()), raw };
}

interface ContentType {
  type: string;
  subtype: string;
  charset?: string;
  boundary?: string;
  name?: string;
}

function parseContentType(value: string | undefined): ContentType {
  if (!value) return { type: 'text', subtype: 'plain' };
  const parts = value.split(';').map((p) => p.trim());
  const main = (parts[0] ?? 'text/plain').toLowerCase();
  const [type = 'text', subtype = 'plain'] = main.split('/');
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    let val = part.slice(index + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = decodeEncodedWords(val);
  }
  return {
    type,
    subtype,
    charset: params['charset'],
    boundary: params['boundary'],
    name: params['name'],
  };
}

function splitByBoundary(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const parts: string[] = [];
  let current: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith(marker)) {
      parts.push(current.join('\n'));
      current = [];
      if (line.startsWith(`${marker}--`)) break;
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) parts.push(current.join('\n'));
  // 第一个片段是前言，丢掉
  return parts.slice(1).filter((p) => p.trim() !== '');
}

interface Accumulator {
  textPlain: string | null;
  textHtml: string | null;
  attachments: ParsedAttachment[];
  charsetUsed: string;
}

function decodeBody(part: string, encoding: string | undefined, charset: string | undefined): { text: string; charset: string } {
  const kind = (encoding ?? '7bit').toLowerCase();
  if (kind === 'base64') {
    const bytes = Buffer.from(part.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
    return decodeCharset(bytes, charset);
  }
  if (kind === 'quoted-printable') {
    return decodeCharset(decodeQuotedPrintable(part), charset);
  }
  return decodeCharset(Buffer.from(part, 'latin1'), charset);
}

function walk(rawPart: string, acc: Accumulator): void {
  const separator = rawPart.search(/\r?\n\r?\n/);
  const headerBlock = separator === -1 ? rawPart : rawPart.slice(0, separator);
  const body = separator === -1 ? '' : rawPart.slice(separator).replace(/^\r?\n\r?\n/, '');
  const headers = parseHeaders(headerBlock);
  const contentType = parseContentType(headers.get('content-type'));
  const encoding = headers.get('content-transfer-encoding');
  const disposition = headers.get('content-disposition') ?? '';
  const filename = /filename\*?=([^;]+)/i.exec(disposition)?.[1]?.replace(/^"|"$/g, '') ?? contentType.name;

  if (contentType.type === 'multipart' && contentType.boundary) {
    for (const child of splitByBoundary(body, contentType.boundary)) walk(child, acc);
    return;
  }

  const isAttachment = /attachment/i.test(disposition) || (filename !== undefined && filename !== '');
  if (isAttachment) {
    const bytes =
      (encoding ?? '').toLowerCase() === 'base64'
        ? Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
        : (encoding ?? '').toLowerCase() === 'quoted-printable'
          ? Buffer.from(decodeQuotedPrintable(body))
          : Buffer.from(body, 'latin1');
    acc.attachments.push({
      filename: filename ?? '(未命名)',
      contentType: `${contentType.type}/${contentType.subtype}`,
      content: bytes,
    });
    return;
  }

  if (contentType.type === 'text' && contentType.subtype === 'plain' && acc.textPlain === null) {
    const decoded = decodeBody(body, encoding, contentType.charset);
    acc.textPlain = decoded.text;
    acc.charsetUsed = decoded.charset;
    return;
  }
  if (contentType.type === 'text' && contentType.subtype === 'html' && acc.textHtml === null) {
    const decoded = decodeBody(body, encoding, contentType.charset);
    acc.textHtml = decoded.text;
    if (acc.charsetUsed === '') acc.charsetUsed = decoded.charset;
  }
}

export function parseEml(input: Uint8Array | string): ParsedEmail {
  const raw = typeof input === 'string' ? Buffer.from(input, 'utf8').toString('latin1') : Buffer.from(input).toString('latin1');
  const separator = raw.search(/\r?\n\r?\n/);
  const headerBlock = separator === -1 ? raw : raw.slice(0, separator);
  const body = separator === -1 ? '' : raw.slice(separator).replace(/^\r?\n\r?\n/, '');
  const headers = parseHeaders(headerBlock);

  const acc: Accumulator = { textPlain: null, textHtml: null, attachments: [], charsetUsed: '' };
  const topType = parseContentType(headers.get('content-type'));
  if (topType.type === 'multipart' && topType.boundary) {
    for (const child of splitByBoundary(body, topType.boundary)) walk(child, acc);
  } else {
    walk(raw, acc);
  }

  const dateHeader = headers.get('date');
  const parsedDate = dateHeader ? Date.parse(dateHeader) : Number.NaN;

  return {
    subject: decodeEncodedWords(headers.get('subject') ?? ''),
    from: decodeEncodedWords(headers.get('from') ?? ''),
    date: Number.isNaN(parsedDate) ? null : new Date(parsedDate).toISOString(),
    messageId: (headers.get('message-id') ?? '').replace(/^<|>$/g, '') || null,
    textBody: acc.textPlain ?? (acc.textHtml !== null ? stripHtml(acc.textHtml) : ''),
    usedHtml: acc.textPlain === null && acc.textHtml !== null,
    attachments: acc.attachments,
    charsetUsed: acc.charsetUsed || 'utf-8',
  };
}

/**
 * zip 读取（零依赖，自己解析）：只为支付宝/微信类导出服务。
 *
 * 支持 store(0) 与 deflate(8) 两种压缩、以及传统 ZipCrypto 加密
 * （支付宝的"用于个人对账"导出就是这种；WinZip AES 用的是 method 99，这里明确报错而不是静默出错）。
 *
 * 为什么不引第三方库：核心卖点就是零运行时依赖，而 zip 的中央目录格式是稳定的公开格式；
 * 加密部分也只有 ZipCrypto 这一种（12 字节随机头 + 3 个 32 位密钥的伪随机流）。
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  encrypted: boolean;
  /** 本地头的偏移，解压时从这里取数据 */
  localHeaderOffset: number;
  /** 是否设置了 bit 3（大小/CRC 写在数据描述符里） */
  usesDataDescriptor: boolean;
  crc32: number;
  dosTime: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

/** 需要密码（或者需要提供密码）时抛出 */
export class ZipPasswordRequiredError extends ZipError {
  constructor(message = '这个 zip 是加密的，需要解压密码') {
    super(message);
    this.name = 'ZipPasswordRequiredError';
  }
}

/** 密码不对 */
export class ZipPasswordWrongError extends ZipError {
  constructor(message = '解压密码不对') {
    super(message);
    this.name = 'ZipPasswordWrongError';
  }
}

// ---------------------------------------------------------------- zip 结构
export function listZipEntries(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > Math.max(0, buf.length - 66000); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('不是有效的 zip（未找到中央目录结束记录）');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new ZipError('中央目录损坏');
    const flags = buf.readUInt16LE(offset + 8);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    entries.push({
      name: buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8'),
      method: buf.readUInt16LE(offset + 10),
      compressedSize: buf.readUInt32LE(offset + 20),
      uncompressedSize: buf.readUInt32LE(offset + 24),
      encrypted: (flags & 0x1) !== 0,
      usesDataDescriptor: (flags & 0x8) !== 0,
      crc32: buf.readUInt32LE(offset + 16),
      dosTime: buf.readUInt16LE(offset + 12),
      localHeaderOffset: buf.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 从本地头定位真正的压缩数据起点（中央目录里的 extra 长度和本地头可能不同，必须重读） */
function dataOffsetOf(buf: Buffer, entry: ZipEntry): { start: number; size: number } {
  const at = entry.localHeaderOffset;
  if (buf.readUInt32LE(at) !== 0x04034b50) throw new ZipError('本地文件头损坏');
  const nameLen = buf.readUInt16LE(at + 26);
  const extraLen = buf.readUInt16LE(at + 28);
  return { start: at + 30 + nameLen + extraLen, size: entry.compressedSize };
}

// ---------------------------------------------------------------- ZipCrypto
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc: number, byte: number): number {
  return (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
}

/** 整段数据的 CRC32（用于校验解压结果；顺带把"错密码"和"文件损坏"区分开） */
export function crc32Of(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crc32Update(crc, byte);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 用密码解密一段 ZipCrypto 数据。
 * 校验方式遵循 PKWARE 规范：解出 12 字节头后，最后一个字节应等于
 * CRC 的最高字节（未设置 bit 3 时）或 DOS 时间的高字节（设置了 bit 3 时）。
 */
function decryptZipCrypto(
  data: Buffer,
  password: string,
  check: { crc32: number; usesDataDescriptor: boolean; dosTime: number },
): Buffer {
  let key0 = 0x12345678;
  let key1 = 0x23456789;
  let key2 = 0x34567890;
  const update = (byte: number): void => {
    key0 = crc32Update(key0, byte);
    key1 = (Math.imul((key1 + (key0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    key2 = crc32Update(key2, (key1 >>> 24) & 0xff);
  };
  const streamByte = (): number => {
    const temp = (key2 | 2) & 0xffff;
    return Math.imul(temp, temp ^ 1) >>> 8 & 0xff;
  };

  for (const byte of Buffer.from(password, 'utf8')) update(byte);

  const out = Buffer.alloc(Math.max(0, data.length - 12));
  let header12 = 0;
  for (let i = 0; i < data.length; i += 1) {
    const plain = data[i]! ^ streamByte();
    update(plain);
    if (i < 12) header12 = (header12 << 8) | plain;
    else out[i - 12] = plain;
  }
  const lastByte = header12 & 0xff;
  const expected = check.usesDataDescriptor ? (check.dosTime >>> 8) & 0xff : (check.crc32 >>> 24) & 0xff;
  if (lastByte !== expected) throw new ZipPasswordWrongError();
  return out;
}

// ---------------------------------------------------------------- 解压
export function extractZipEntry(buf: Buffer, entry: ZipEntry, password?: string): Buffer {
  if (entry.name.endsWith('/')) return Buffer.alloc(0);
  if (entry.method === 99) throw new ZipError('这是 WinZip AES 加密的 zip，本工具只支持传统 ZipCrypto');

  const { start, size } = dataOffsetOf(buf, entry);
  let raw = buf.subarray(start, start + size);

  if (entry.encrypted) {
    if (password === undefined || password === '') throw new ZipPasswordRequiredError();
    raw = decryptZipCrypto(raw, password, entry);
  }

  const out =
    entry.method === 0
      ? raw
      : entry.method === 8
        ? inflateRawSync(raw)
        : (() => {
            throw new ZipError(`不支持的压缩方式：${entry.method}`);
          })();

  // 完整性校验：中央目录里的 CRC 是权威的。解压出来对不上 → 密码错（或文件损坏）。
  if (entry.crc32 !== 0 && crc32Of(out) !== entry.crc32) {
    if (entry.encrypted) throw new ZipPasswordWrongError();
    throw new ZipError('解压结果 CRC 校验失败（文件可能损坏）');
  }
  return out;
}

export interface ExtractedFile {
  name: string;
  data: Buffer;
}

/** 解开全部文件条目（跳过目录项） */
export function extractZip(buf: Buffer, password?: string): ExtractedFile[] {
  return listZipEntries(buf)
    .filter((entry) => !entry.name.endsWith('/'))
    .map((entry) => ({ name: entry.name, data: extractZipEntry(buf, entry, password) }));
}

/** 该 zip 是否需要密码 */
export function zipNeedsPassword(buf: Buffer): boolean {
  return listZipEntries(buf).some((entry) => entry.encrypted);
}

/**
 * 快速校验密码：只解开 12 字节加密头做 PKWARE 校验，不解压正文。
 * 用于"密码只有 6 位数字、想直接试出来"的场景（约 1/256 概率误判，所以命中后必须再做一次完整解压确认）。
 */
export function tryZipPassword(buf: Buffer, entry: ZipEntry, password: string): boolean {
  if (!entry.encrypted) return true;
  const { start } = dataOffsetOf(buf, entry);
  if (start + 12 > buf.length) return false;

  let key0 = 0x12345678;
  let key1 = 0x23456789;
  let key2 = 0x34567890;
  const update = (byte: number): void => {
    key0 = crc32Update(key0, byte);
    key1 = (Math.imul((key1 + (key0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    key2 = crc32Update(key2, (key1 >>> 24) & 0xff);
  };
  const streamByte = (): number => {
    const temp = (key2 | 2) & 0xffff;
    return (Math.imul(temp, temp ^ 1) >>> 8) & 0xff;
  };

  for (const byte of Buffer.from(password, 'utf8')) update(byte);
  let header = 0;
  for (let i = 0; i < 12; i += 1) {
    const plain = buf[start + i]! ^ streamByte();
    update(plain);
    header = ((header << 8) | plain) >>> 0;
  }
  const expected = entry.usesDataDescriptor ? (entry.dosTime >>> 8) & 0xff : (entry.crc32 >>> 24) & 0xff;
  return (header & 0xff) === expected;
}

/** 从 zip 里的文件名猜出账单来源（支付宝/微信/银行） */
export function guessSourceFromName(name: string): 'alipay' | 'wechat' | 'bank' | 'unknown' {
  if (name.includes('支付宝') || /alipay/i.test(name)) return 'alipay';
  if (name.includes('微信') || /wechat|weixin/i.test(name)) return 'wechat';
  if (/银行|bank|明细|流水/.test(name)) return 'bank';
  return 'unknown';
}

/**
 * CSV 解析（零依赖）。
 *
 * 平台导出的账单有几个固定坑，这里逐个处理：
 *  - 编码：支付宝是 GBK/GB18030，微信带 BOM，银行 CSV 编码杂
 *  - 表头前有若干行说明文字（"支付宝交易流水明细"、时间范围、导出时间）
 *  - 金额带 ¥ 与千分位
 *  - 字段里可能有逗号、引号、换行（用标准 RFC4180 状态机）
 */

export type SupportedEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';

export interface DecodeResult {
  text: string;
  encoding: SupportedEncoding;
  hadBom: boolean;
}

export function detectEncoding(buffer: Uint8Array): { encoding: SupportedEncoding; hadBom: boolean } {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: 'utf-8', hadBom: true };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { encoding: 'utf-16le', hadBom: true };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { encoding: 'utf-16be', hadBom: true };
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { encoding: 'utf-8', hadBom: false };
  } catch {
    // 不是合法 UTF-8：国内账单基本是 GBK/GB18030
    return { encoding: 'gb18030', hadBom: false };
  }
}

export function decodeBuffer(buffer: Uint8Array, encoding?: string): DecodeResult {
  const detected = detectEncoding(buffer);
  const chosen = (encoding && encoding.trim() !== '' ? encoding.trim().toLowerCase() : detected.encoding) as SupportedEncoding;
  try {
    const text = new TextDecoder(chosen).decode(buffer);
    return { text, encoding: chosen, hadBom: detected.hadBom };
  } catch {
    const text = new TextDecoder(detected.encoding).decode(buffer);
    return { text, encoding: detected.encoding, hadBom: detected.hadBom };
  }
}

/** RFC4180 状态机：支持引号包裹、双写引号转义、字段内换行与 CRLF */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',' || ch === '\t') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export interface CsvTable {
  /** 表头所在行（0 起） */
  headerRow: number;
  headers: string[];
  /** 表头之前的说明行（原样保留，导入报告里会回显） */
  preamble: string[];
  rows: string[][];
  /** 行号（1 起，对应源文件）与数据一一对应 */
  rowNumbers: number[];
}

export function tableFromCsv(text: string, headerRowHint?: number): CsvTable {
  const all = parseCsv(text);
  const headerRow = Math.max(0, Math.min(headerRowHint ?? 0, Math.max(0, all.length - 1)));
  const headers = (all[headerRow] ?? []).map((h) => h.trim());
  const dataRows = all.slice(headerRow + 1);
  return {
    headerRow,
    headers,
    preamble: all.slice(0, headerRow).map((r) => r.join(',')),
    rows: dataRows,
    // parseCsv 过滤了空行，行号是近似值，仅用于报告定位
    rowNumbers: dataRows.map((_, i) => headerRow + 2 + i),
  };
}

/** CSV 文本 → 对象行（同名列自动加后缀去重） */
export function rowsToObjects(table: CsvTable): Array<Record<string, string>> {
  const seen = new Map<string, number>();
  const keys = table.headers.map((h, i) => {
    const base = h === '' ? `列${i + 1}` : h;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
  return table.rows.map((row) => {
    const obj: Record<string, string> = {};
    keys.forEach((key, i) => {
      obj[key] = (row[i] ?? '').trim();
    });
    return obj;
  });
}

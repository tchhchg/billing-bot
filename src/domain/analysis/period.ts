/**
 * 时区与自然日：统计口径的时间基础。
 *
 * 全部基于 IANA 时区 + Intl（Node 自带完整 ICU），不引入日期库依赖。
 * 返回的毫秒时间戳对齐到秒，避免亚秒误差。
 */

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function localPartsOf(instantMs: number, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const get = (type: string): number => {
    const v = parts.find((p) => p.type === type)?.value ?? '0';
    return Number(v);
  };
  let hour = get('hour');
  if (hour === 24) hour = 0; // 部分 ICU 版本在午夜返回 24
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** 某个瞬时在指定时区里的自然日（YYYY-MM-DD） */
export function localDateOf(instant: number | string, timeZone: string): string {
  const ms = typeof instant === 'string' ? Date.parse(instant) : instant;
  if (Number.isNaN(ms)) throw new RangeError(`invalid instant: ${String(instant)}`);
  const p = localPartsOf(ms, timeZone);
  return formatDate(p.year, p.month, p.day);
}

/** 本地时区“现在”的自然日 */
export function todayLocal(timeZone: string, nowMs: number = Date.now()): string {
  return localDateOf(nowMs, timeZone);
}

/** 该时区在给定瞬时的 UTC 偏移（毫秒） */
function tzOffsetMs(instantMs: number, timeZone: string): number {
  const aligned = Math.floor(instantMs / 1000) * 1000;
  const p = localPartsOf(aligned, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - aligned;
}

export function parseDate(date: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`invalid date: ${date}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** 本地自然日 00:00 对应的 UTC 毫秒 */
export function zonedStartOfDay(date: string, timeZone: string): number {
  const { year, month, day } = parseDate(date);
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const first = tzOffsetMs(utcGuess, timeZone);
  let ts = utcGuess - first;
  const second = tzOffsetMs(ts, timeZone);
  if (second !== first) ts = utcGuess - second; // DST 边界的二次校正
  return ts;
}

export interface DayWindow {
  localDate: string;
  startMs: number;
  /** 开区间上界 */
  endMs: number;
}

export function dayWindow(date: string, timeZone: string): DayWindow {
  return {
    localDate: date,
    startMs: zonedStartOfDay(date, timeZone),
    endMs: zonedStartOfDay(addDays(date, 1), timeZone),
  };
}

export function isWithinDay(instantIso: string, date: string, timeZone: string): boolean {
  const ms = Date.parse(instantIso);
  const w = dayWindow(date, timeZone);
  return ms >= w.startMs && ms < w.endMs;
}

/** 纯日历加减（与时区无关），返回 YYYY-MM-DD */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** 0 = 周日 */
export function weekdayOf(date: string): number {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function daysBetween(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/** 闭区间 [from, to] 的日期列表 */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const total = daysBetween(from, to);
  for (let i = 0; i <= total; i += 1) out.push(addDays(from, i));
  return out;
}

/** 向前取 n 天（不含 date 本身） */
export function previousDays(date: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n; i >= 1; i -= 1) out.push(addDays(date, -i));
  return out;
}

export function endOfMonth(date: string): string {
  const { year, month } = parseDate(date);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return formatDate(year, month, last);
}

export function startOfMonth(date: string): string {
  const { year, month } = parseDate(date);
  return formatDate(year, month, 1);
}

/** 以周一为一周起点 */
export function startOfWeek(date: string): string {
  const wd = weekdayOf(date); // 0=Sun
  const delta = wd === 0 ? 6 : wd - 1;
  return addDays(date, -delta);
}

// ---------------------------------------------------------------- 导入解析用：本地墙上时间 ↔ 瞬时

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * 解析账单文件里的"墙上时间"（不含时区）。
 * 支持：2026-10-03 12:30:45 / 2026-10-03 12:30 / 2026/10/03 12:30 / 2026年10月3日 12:30 / 2026-10-03
 */
export function parseWallClock(text: string): WallClock | null {
  const normalized = text
    .trim()
    .replace(/[年月]/g, '-')
    .replace(/日/g, '')
    .replace(/\//g, '-')
    .replace(/\s+/g, ' ');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(normalized);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4] ?? '0');
  const minute = Number(m[5] ?? '0');
  const second = Number(m[6] ?? '0');
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  return { year, month, day, hour, minute, second };
}

/** 墙上时间 + 时区 → UTC 毫秒（跨 DST 边界做二次校正） */
export function wallClockToUtcMs(clock: WallClock, timeZone: string): number {
  const utcGuess = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  const first = tzOffsetMs(utcGuess, timeZone);
  let ts = utcGuess - first;
  const second = tzOffsetMs(ts, timeZone);
  if (second !== first) ts = utcGuess - second;
  return ts;
}

/** 瞬时 → 带时区偏移的 ISO8601（账单持久化格式） */
export function isoWithOffset(instantMs: number, timeZone: string): string {
  const p = localPartsOf(instantMs, timeZone);
  const offsetMinutes = Math.round(tzOffsetMs(instantMs, timeZone) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${formatDate(p.year, p.month, p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}${sign}${pad2(
    Math.floor(abs / 60),
  )}:${pad2(abs % 60)}`;
}

/** 账单文件里的时间文本 → 带偏移的 ISO；无法解析返回 null */
export function parseBillTimestamp(text: string, timeZone: string): string | null {
  const clock = parseWallClock(text);
  if (clock) return isoWithOffset(wallClockToUtcMs(clock, timeZone), timeZone);
  // 已经是带偏移的 ISO
  if (/[+-]\d{2}:?\d{2}$|Z$/.test(text.trim())) {
    const ms = Date.parse(text.trim());
    if (!Number.isNaN(ms)) return isoWithOffset(ms, timeZone);
  }
  return null;
}

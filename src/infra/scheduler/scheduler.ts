/**
 * 每日调度器（零依赖，分钟级 tick）。
 *
 * 覆盖三种现实情况：
 *  1. 到点执行：本地时间 ≥ 配置时间 且 今天还没跑过
 *  2. 免打扰：配置时间落在免打扰区间内 → 顺延到免打扰结束（跨零点则顺延到次日早晨）
 *  3. 休眠/关机漏跑：启动时与每次 tick 检查"昨天是否已生成"，缺则补跑
 *     （补跑靠 run_key 幂等，绝不重复推送）
 */
import {
  addDays,
  localPartsOf,
  parseWallClock,
  todayLocal,
  wallClockToUtcMs,
} from '../../domain/analysis/period.ts';

export interface SchedulerOptions {
  timeZone: string;
  /** HH:MM */
  time: string;
  quietHours: [string, string];
  /** 到点时调用；date 是"要生成日报的本地日期"。返回状态字符串用于日志（如 pushed / skipped_already_run） */
  onRun: (date: string) => Promise<string | void>;
  /** 漏跑补跑；缺省则不补 */
  onCatchUp?: (args: { maxDays: number }) => Promise<void>;
  now?: () => Date;
  intervalMs?: number;
  maxCatchUpDays?: number;
  log?: (message: string) => void;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  /** 手动推进一步（测试与界面上的"立即检查"都用它） */
  tick(): Promise<{ ran: boolean; note: string }>;
  state(): { lastRunDate: string | null; lastCatchUpDate: string | null; nextDueAt: number | null };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h ?? 0) * 60 + Number(m ?? 0);
}

function hhmmOf(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function hhmmOfInstant(instantMs: number, timeZone: string): string {
  const p = localPartsOf(instantMs, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** 免打扰区间是否包含该时刻（支持跨零点，如 22:30–07:30） */
export function isInQuietHours(hhmm: string, quiet: [string, string]): boolean {
  const value = minutesOf(hhmm);
  const start = minutesOf(quiet[0]);
  const end = minutesOf(quiet[1]);
  if (start === end) return false;
  return start < end ? value >= start && value < end : value >= start || value < end;
}

/**
 * 某日期的实际执行时刻。若配置时间落在免打扰内：
 *  - 配置时间 ≥ 免打扰起点（晚上那一段）→ 顺延到次日免打扰结束
 *  - 配置时间 < 免打扰终点（凌晨那一段）→ 顺延到当日免打扰结束
 */
export function dueInstantForDate(
  date: string,
  options: Pick<SchedulerOptions, 'time' | 'timeZone' | 'quietHours'>,
): number {
  const clock = parseWallClock(`${date} ${options.time}`);
  if (!clock) throw new RangeError(`非法的调度时间：${options.time}`);
  if (!isInQuietHours(options.time, options.quietHours)) {
    return wallClockToUtcMs(clock, options.timeZone);
  }
  const [start, end] = options.quietHours;
  const targetDate = minutesOf(options.time) >= minutesOf(start) ? addDays(date, 1) : date;
  const targetClock = parseWallClock(`${targetDate} ${hhmmOf(minutesOf(end))}`);
  if (!targetClock) throw new RangeError(`非法的免打扰结束时间：${end}`);
  return wallClockToUtcMs(targetClock, options.timeZone);
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const now = options.now ?? ((): Date => new Date());
  const log = options.log ?? ((): void => {});
  const intervalMs = options.intervalMs ?? 60_000;
  const maxCatchUpDays = options.maxCatchUpDays ?? 1;
  let timer: NodeJS.Timeout | null = null;
  let lastRunDate: string | null = null;
  let lastCatchUpDate: string | null = null;
  let running = false;
  let started = false;

  const nextDue = (): number | null => {
    const today = todayLocal(options.timeZone, now().getTime());
    for (const date of [today, addDays(today, 1)]) {
      const due = dueInstantForDate(date, options);
      if (due > now().getTime()) return due;
    }
    return null;
  };

  const tick = async (): Promise<{ ran: boolean; note: string }> => {
    if (running) return { ran: false, note: '上一次执行尚未结束' };
    running = true;
    try {
      const current = now().getTime();
      const today = todayLocal(options.timeZone, current);

      // ---- 漏跑补跑（独立于"今天是否到点"）；每个本地日最多补一次
      let didCatchUp = false;
      if (options.onCatchUp && (lastCatchUpDate === null || lastCatchUpDate < today)) {
        await options.onCatchUp({ maxDays: maxCatchUpDays });
        lastCatchUpDate = today;
        didCatchUp = true;
        log('[scheduler] 检测到漏跑，已补跑');
      }

      if (lastRunDate === today) {
        return { ran: didCatchUp, note: didCatchUp ? '补跑完成（今天已生成过）' : '今天已经跑过' };
      }

      const due = dueInstantForDate(today, options);
      if (current < due) {
        const inQuiet = isInQuietHours(hhmmOfInstant(current, options.timeZone), options.quietHours);
        return {
          ran: didCatchUp,
          note: didCatchUp ? '补跑完成，今日尚未到点' : inQuiet ? '免打扰时段内，已顺延' : `未到时间（${options.time}）`,
        };
      }

      const status = await options.onRun(today);
      // 推送失败时不要标记"今天已完成"，否则一天内不会再重试
      if (status !== 'failed') lastRunDate = today;
      log(
        `[scheduler] ${today} → ${status ?? '已执行'}` + (status === 'failed' ? '（下个周期会重试）' : ''),
      );
      return { ran: true, note: didCatchUp ? '补跑 + 今日日报' : '已执行' };
    } finally {
      running = false;
    }
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      // 启动即检查一次：解决"睡眠期间错过"
      void tick().catch((error: unknown) => log(`[scheduler] 启动检查失败：${String(error)}`));
      timer = setInterval(() => {
        void tick().catch((error: unknown) => log(`[scheduler] tick 失败：${String(error)}`));
      }, intervalMs);
      timer.unref?.();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      started = false;
    },

    tick,

    state(): { lastRunDate: string | null; lastCatchUpDate: string | null; nextDueAt: number | null } {
      return { lastRunDate, lastCatchUpDate, nextDueAt: nextDue() };
    },
  };
}

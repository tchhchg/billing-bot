/**
 * 公共汇率 API 适配器。
 *
 * 默认源为 open.er-api.com（免密钥）。返回的是「1 基础币种 = X 外币」，
 * 而领域层需要的是「1 外币 = ? 基础币种」的乘数，这里做一次倒数换算并测试锁死。
 * 出网内容仅币种代码与日期，不含任何金额或商户信息。
 */
import type { FxRate } from '../../domain/types.ts';
import type { FxRepo } from '../db/fxRepo.ts';

export interface PublicFxOptions {
  /** 形如 https://open.er-api.com/v6/latest/{base} */
  urlTemplate?: string;
  fetchImpl?: typeof fetch;
  source?: string;
  timeoutMs?: number;
  /** 自定义响应解析：返回「1 base = rate 目标币」的表 */
  extract?: (payload: unknown, base: string) => Record<string, number> | null;
}

export interface PublicFxProvider {
  readonly source: string;
  fetchRates(args: { base: string; quotes: readonly string[]; date: string }): Promise<FxRate[]>;
}

const DEFAULT_URL_TEMPLATE = 'https://open.er-api.com/v6/latest/{base}';

function defaultExtract(payload: unknown, base: string): Record<string, number> | null {
  const root = (payload ?? {}) as Record<string, unknown>;
  if (root['result'] === 'error') return null;
  const rates = root['rates'];
  if (typeof rates !== 'object' || rates === null) return null;
  const out: Record<string, number> = {};
  for (const [quote, value] of Object.entries(rates as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[quote] = value;
  }
  if (Object.keys(out).length === 0) return null;
  void base;
  return out;
}

export function createPublicFxProvider(options: PublicFxOptions = {}): PublicFxProvider {
  const template = options.urlTemplate ?? DEFAULT_URL_TEMPLATE;
  const doFetch = options.fetchImpl ?? fetch;
  const source = options.source ?? new URL(template.replace('{base}', 'CNY')).host;
  const extract = options.extract ?? defaultExtract;
  const timeoutMs = options.timeoutMs ?? 8000;

  return {
    source,

    async fetchRates(args): Promise<FxRate[]> {
      const url = template.replace('{base}', encodeURIComponent(args.base));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`汇率接口返回 HTTP ${response.status}`);
        const payload: unknown = await response.json();
        const table = extract(payload, args.base);
        if (!table) throw new Error('汇率接口返回格式无法解析');

        const fetchedAt = new Date().toISOString();
        const rates: FxRate[] = [];
        for (const quote of args.quotes) {
          if (quote === args.base) continue;
          const forward = table[quote];
          if (forward === undefined || forward <= 0) continue;
          rates.push({
            rateDate: args.date,
            base: args.base,
            quote,
            // 1 base = forward quote  ⇒  1 quote = 1/forward base
            rate: 1 / forward,
            source,
            fetchedAt,
          });
        }
        return rates;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface RefreshRatesResult {
  stored: number;
  ok: boolean;
  error?: string;
  /** 仍然缺失的币种 */
  missingQuotes: string[];
}

/** 拉取并写入本机缓存；失败时返回 ok=false，调用方保持离线降级（用最近可用汇率）。 */
export async function refreshRates(args: {
  fxRepo: FxRepo;
  provider: PublicFxProvider;
  base: string;
  quotes: readonly string[];
  date: string;
}): Promise<RefreshRatesResult> {
  const wanted = args.quotes.filter((q) => q !== args.base);
  if (wanted.length === 0) return { stored: 0, ok: true, missingQuotes: [] };
  try {
    const rates = await args.provider.fetchRates({ base: args.base, quotes: wanted, date: args.date });
    const stored = args.fxRepo.putMany(rates);
    const got = new Set(rates.map((r) => r.quote));
    return { stored, ok: true, missingQuotes: wanted.filter((q) => !got.has(q)) };
  } catch (error) {
    return {
      stored: 0,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      missingQuotes: [...wanted],
    };
  }
}

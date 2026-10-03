/** 汇率仓储（本机缓存，离线时用最近可用值）。 */
import type { FxRate } from '../../domain/types.ts';
import type { FxLookup } from '../../domain/analysis/fx.ts';
import type { Db } from './database.ts';
import { tx } from './database.ts';

interface FxRow {
  rate_date: string;
  base: string;
  quote: string;
  rate: number;
  source: string;
  fetched_at: string;
}

export interface FxRepo {
  put(rate: FxRate): void;
  putMany(rates: readonly FxRate[]): number;
  get(rateDate: string, base: string, quote: string): FxRate | null;
  latest(base: string, quote: string): FxRate | null;
  count(): number;
  findMissingDates(base: string, quotes: readonly string[], dates: readonly string[]): string[];
  /** 直接当领域的 FxLookup 用 */
  lookup(): FxLookup;
}

export function createFxRepo(db: Db): FxRepo {
  const get = (rateDate: string, base: string, quote: string): FxRate | null => {
    const row = db
      .prepare('SELECT * FROM fx_rate WHERE rate_date=? AND base=? AND quote=?')
      .get(rateDate, base, quote) as unknown as FxRow | undefined;
    return row ? { rateDate: row.rate_date, base: row.base, quote: row.quote, rate: row.rate, source: row.source, fetchedAt: row.fetched_at } : null;
  };

  const latest = (base: string, quote: string): FxRate | null => {
    const row = db
      .prepare('SELECT * FROM fx_rate WHERE base=? AND quote=? ORDER BY rate_date DESC LIMIT 1')
      .get(base, quote) as unknown as FxRow | undefined;
    return row ? { rateDate: row.rate_date, base: row.base, quote: row.quote, rate: row.rate, source: row.source, fetchedAt: row.fetched_at } : null;
  };

  return {
    put(rate): void {
      db.prepare(
        `INSERT INTO fx_rate (rate_date, base, quote, rate, source, fetched_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(rate_date, base, quote) DO UPDATE SET rate=excluded.rate, source=excluded.source, fetched_at=excluded.fetched_at`,
      ).run(rate.rateDate, rate.base, rate.quote, rate.rate, rate.source, rate.fetchedAt);
    },

    putMany(rates): number {
      const stmt = db.prepare(
        `INSERT INTO fx_rate (rate_date, base, quote, rate, source, fetched_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(rate_date, base, quote) DO UPDATE SET rate=excluded.rate, source=excluded.source, fetched_at=excluded.fetched_at`,
      );
      return tx(db, () => {
        let n = 0;
        for (const r of rates) {
          stmt.run(r.rateDate, r.base, r.quote, r.rate, r.source, r.fetchedAt);
          n += 1;
        }
        return n;
      });
    },

    get,

    latest,

    count(): number {
      const row = db.prepare('SELECT COUNT(*) AS n FROM fx_rate').get() as { n: number };
      return Number(row.n);
    },

    findMissingDates(base, quotes, dates): string[] {
      const stmt = db.prepare('SELECT 1 AS ok FROM fx_rate WHERE rate_date=? AND base=? AND quote=?');
      const missing = new Set<string>();
      for (const quote of quotes) {
        for (const date of dates) {
          if (!stmt.get(date, base, quote)) missing.add(date);
        }
      }
      return [...missing].sort();
    },

    lookup(): FxLookup {
      return {
        onDate: (rateDate, base, quote) => {
          if (base === quote) return 1;
          return get(rateDate, base, quote)?.rate ?? null;
        },
        latest: (base, quote) => {
          if (base === quote) return { rate: 1, rateDate: '' };
          const row = latest(base, quote);
          return row ? { rate: row.rate, rateDate: row.rateDate } : null;
        },
      };
    },
  };
}

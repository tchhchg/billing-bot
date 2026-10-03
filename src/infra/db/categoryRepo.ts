/** 分类与自动分类规则仓储。 */
import type { Category, CategoryRule, RuleKind } from '../../domain/category.ts';
import type { Db } from './database.ts';
import { tx } from './database.ts';

interface CategoryRow {
  category_id: string;
  parent_id: string | null;
  name: string;
  preset: number;
  sort: number;
}

interface RuleRow {
  id: number;
  kind: string;
  pattern: string;
  category_id: string;
  hits: number;
}

function rowToCategory(row: CategoryRow): Category {
  return {
    categoryId: row.category_id,
    parentId: row.parent_id,
    name: row.name,
    preset: row.preset === 1,
    sort: row.sort,
  };
}

function rowToRule(row: RuleRow): CategoryRule {
  return { id: row.id, kind: row.kind as RuleKind, pattern: row.pattern, categoryId: row.category_id, hits: row.hits };
}

export interface CategoryRepo {
  seedPreset(categories: readonly Category[], now: string): void;
  list(): Category[];
  insertIfAbsent(category: Category): void;
  upsert(category: Category): void;
  /** 删除分类，并把账单迁移到 migrateTo（null = 未分类） */
  remove(categoryId: string, migrateTo: string | null): void;
  count(): number;
  listRules(): CategoryRule[];
  upsertRule(args: { kind: RuleKind; pattern: string; categoryId: string; now: string; id?: number }): number;
  bumpRule(id: number, now: string): void;
  removeRule(id: number): void;
}

export function createCategoryRepo(db: Db): CategoryRepo {
  return {
    seedPreset(categories, now): void {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO category (category_id, parent_id, name, preset, sort) VALUES (?,?,?,?,?)`,
      );
      tx(db, () => {
        for (const c of categories) stmt.run(c.categoryId, c.parentId, c.name, c.preset ? 1 : 0, c.sort);
      });
      void now;
    },

    list(): Category[] {
      return (db.prepare('SELECT * FROM category ORDER BY sort ASC, category_id ASC').all() as unknown as CategoryRow[]).map(
        rowToCategory,
      );
    },

    insertIfAbsent(category: Category): void {
      db.prepare(
        `INSERT OR IGNORE INTO category (category_id, parent_id, name, preset, sort) VALUES (?,?,?,?,?)`,
      ).run(category.categoryId, category.parentId, category.name, category.preset ? 1 : 0, category.sort);
    },

    upsert(category: Category): void {
      db.prepare(
        `INSERT INTO category (category_id, parent_id, name, preset, sort) VALUES (?,?,?,?,?)
         ON CONFLICT(category_id) DO UPDATE SET parent_id=excluded.parent_id, name=excluded.name, sort=excluded.sort`,
      ).run(category.categoryId, category.parentId, category.name, category.preset ? 1 : 0, category.sort);
    },

    remove(categoryId, migrateTo): void {
      tx(db, () => {
        db.prepare('UPDATE bill SET category_id = ? WHERE category_id = ?').run(migrateTo, categoryId);
        db.prepare('DELETE FROM category WHERE category_id = ?').run(categoryId);
      });
    },

    count(): number {
      const row = db.prepare('SELECT COUNT(*) AS n FROM category').get() as { n: number };
      return Number(row.n);
    },

    listRules(): CategoryRule[] {
      return (
        db.prepare('SELECT * FROM rule_map ORDER BY hits DESC, id ASC').all() as unknown as RuleRow[]
      ).map(rowToRule);
    },

    upsertRule(args): number {
      if (args.id !== undefined) {
        db.prepare('UPDATE rule_map SET pattern=?, category_id=?, updated_at=? WHERE id=?').run(
          args.pattern,
          args.categoryId,
          args.now,
          args.id,
        );
        return args.id;
      }
      const result = db
        .prepare(
          `INSERT INTO rule_map (kind, pattern, category_id, hits, updated_at) VALUES (?,?,?,0,?)
           ON CONFLICT(kind, pattern) DO UPDATE SET category_id=excluded.category_id, updated_at=excluded.updated_at`,
        )
        .run(args.kind, args.pattern, args.categoryId, args.now);
      if (Number(result.lastInsertRowid) > 0 && Number(result.changes) > 0) {
        const row = db.prepare('SELECT id FROM rule_map WHERE kind=? AND pattern=?').get(args.kind, args.pattern) as
          | { id: number }
          | undefined;
        if (row) return Number(row.id);
      }
      return Number(result.lastInsertRowid);
    },

    bumpRule(id, now): void {
      db.prepare('UPDATE rule_map SET hits = hits + 1, updated_at = ? WHERE id = ?').run(now, id);
    },

    removeRule(id): void {
      db.prepare('DELETE FROM rule_map WHERE id = ?').run(id);
    },
  };
}

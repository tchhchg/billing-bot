/** 数据库打开与迁移（node:sqlite，零第三方依赖）。 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './schema.ts';

export type Db = DatabaseSync;

export function openDatabase(path: string): Db {
  const isMemory = path === ':memory:';
  if (!isMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (!isMemory) db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

export function currentVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

export function migrate(db: Db): number {
  let version = currentVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    tx(db, () => {
      db.exec(migration.sql);
    });
    db.exec(`PRAGMA user_version = ${migration.version}`);
    version = migration.version;
  }
  return version;
}

/** 事务包装：抛错即回滚 */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function toBool(value: unknown): boolean {
  return value === 1 || value === true;
}

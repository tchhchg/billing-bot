/**
 * 配置文件读写（原子写 + 版本迁移 + 密钥分离）。
 *
 * 数据全部在本机；目录可用 BILLING_BOT_HOME 覆盖（测试即用此法隔离）。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  CONFIG_SCHEMA_VERSION,
  defaultConfigDraft,
  setByPath,
  validateConfigDraft,
  type ConfigIssue,
} from './schema.ts';

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['BILLING_BOT_HOME'];
  if (override && override.trim() !== '') return override;
  const base = env['LOCALAPPDATA'] ?? env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  return join(base, 'billing-bot');
}

export interface LoadedConfig {
  draft: Record<string, unknown>;
  issues: ConfigIssue[];
  /** 载入的是旧版本配置时，这里是被补齐前的版本号 */
  migratedFrom?: number;
}

export interface ConfigStore {
  readonly dir: string;
  configPath: string;
  secretsPath: string;
  exists(): boolean;
  load(): LoadedConfig | null;
  save(draft: Record<string, unknown>): void;
  /** 只改指定键（设置页常用） */
  patch(changes: Array<{ key: string; value: unknown }>): Record<string, unknown>;
  setSecret(name: string, value: string): void;
  getSecret(name: string): string | null;
  clearSecret(name: string): void;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function atomicWrite(path: string, content: string, mode?: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { encoding: 'utf8', mode: mode ?? 0o600 });
  renameSync(tmp, path);
  try {
    if (mode !== undefined) chmodSync(path, mode);
  } catch {
    // Windows 上 chmod 只影响只读位；这里不阻断（见 README 的密钥存储说明）
  }
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  if (raw.trim() === '') return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 深合并：旧配置只写了一个子字段时，不能把同组其它字段抹掉 */
export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMerge(target[key] as Record<string, unknown>, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

/**
 * 补齐缺失字段。
 * **无论版本号是否变化都要补**：新版本加了配置项后，老配置文件里没有这些键，
 * 若不补，设置页会把布尔项渲染成"开启"（因为选中项匹配不上）——那是在骗用户。
 */
export function migrateDraft(draft: Record<string, unknown>): { draft: Record<string, unknown>; migratedFrom?: number } {
  const version = typeof draft['schemaVersion'] === 'number' ? (draft['schemaVersion'] as number) : 0;
  const merged = defaultConfigDraft();
  deepMerge(merged, draft);
  setByPath(merged, 'schemaVersion', CONFIG_SCHEMA_VERSION);
  return version === CONFIG_SCHEMA_VERSION ? { draft: merged } : { draft: merged, migratedFrom: version };
}

export function createConfigStore(dir: string = resolveDataDir()): ConfigStore {
  const configPath = join(dir, 'config.json');
  const secretsPath = join(dir, 'secrets.json');

  const readSecrets = (): Record<string, string> => {
    const raw = readJson(secretsPath);
    if (!raw) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
    return out;
  };

  return {
    dir,
    configPath,
    secretsPath,

    exists(): boolean {
      return existsSync(configPath);
    },

    load(): LoadedConfig | null {
      const raw = readJson(configPath);
      if (!raw) return null;
      const { draft, migratedFrom } = migrateDraft(raw);
      return { draft, issues: validateConfigDraft(draft), migratedFrom };
    },

    save(draft: Record<string, unknown>): void {
      ensureDir(dir);
      const toSave = { ...draft, schemaVersion: CONFIG_SCHEMA_VERSION };
      atomicWrite(configPath, `${JSON.stringify(toSave, null, 2)}\n`);
    },

    patch(changes): Record<string, unknown> {
      const current = this.load()?.draft ?? defaultConfigDraft();
      for (const change of changes) setByPath(current, change.key, change.value);
      setByPath(current, 'schemaVersion', CONFIG_SCHEMA_VERSION);
      this.save(current);
      return current;
    },

    setSecret(name: string, value: string): void {
      ensureDir(dir);
      const secrets = readSecrets();
      if (value === '') delete secrets[name];
      else secrets[name] = value;
      atomicWrite(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
    },

    getSecret(name: string): string | null {
      const value = readSecrets()[name];
      return value === undefined ? null : value;
    },

    clearSecret(name: string): void {
      const secrets = readSecrets();
      if (!(name in secrets)) return;
      delete secrets[name];
      if (Object.keys(secrets).length === 0) {
        if (existsSync(secretsPath)) unlinkSync(secretsPath);
        return;
      }
      atomicWrite(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
    },
  };
}

/**
 * 数据库结构（迁移式管理）。
 *
 * 单机单用户：不设 user_id；所有时间同时存 ISO 文本（可读）与 epoch 毫秒（可精确范围查询）。
 * 用 SQL 常量而不是外部 .sql 文件，保证打包成单文件可执行后依然能用。
 */
export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE bill (
  bill_id        TEXT PRIMARY KEY,
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  currency       TEXT NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('expense','income','transfer')),
  category_id    TEXT,
  occurred_at    TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  merchant       TEXT,
  account_id     TEXT,
  payment_method TEXT,
  note           TEXT,
  tags           TEXT,
  source         TEXT NOT NULL CHECK (source IN ('manual','import','api')),
  source_ref     TEXT,
  refund_of      TEXT,
  status         TEXT NOT NULL DEFAULT 'normal' CHECK (status IN ('normal','pending_review','void')),
  recurring_id   TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE UNIQUE INDEX ux_bill_src ON bill(source, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX ix_bill_ms ON bill(occurred_at_ms);
CREATE INDEX ix_bill_cat ON bill(category_id, occurred_at_ms);
CREATE INDEX ix_bill_status ON bill(status, occurred_at_ms);
CREATE INDEX ix_bill_dup ON bill(merchant, amount_minor, currency, occurred_at_ms);

CREATE TABLE category (
  category_id TEXT PRIMARY KEY,
  parent_id   TEXT,
  name        TEXT NOT NULL,
  preset      INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE rule_map (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('merchant','keyword','amount_range')),
  pattern     TEXT NOT NULL,
  category_id TEXT NOT NULL,
  hits        INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_rule ON rule_map(kind, pattern);

CREATE TABLE fx_rate (
  rate_date  TEXT NOT NULL,
  base       TEXT NOT NULL,
  quote      TEXT NOT NULL,
  rate       REAL NOT NULL,
  source     TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (rate_date, base, quote)
);

CREATE TABLE daily_run (
  run_key      TEXT PRIMARY KEY,
  local_date   TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  advices_json TEXT NOT NULL,
  revision     INTEGER NOT NULL DEFAULT 1,
  pushed_at    TEXT,
  channel      TEXT,
  push_status  TEXT
);
CREATE INDEX ix_run_date ON daily_run(local_date);

CREATE TABLE rule_pref (
  rule_id    TEXT PRIMARY KEY,
  muted      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE advice_feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  advice_id  TEXT NOT NULL,
  rule_id    TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('viewed','ignored','snoozed','inaccurate','record_added')),
  reason     TEXT,
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_feedback_rule ON advice_feedback(rule_id, created_at);

CREATE TABLE bill_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id     TEXT NOT NULL,
  action      TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_audit_bill ON bill_audit(bill_id, id);

CREATE TABLE import_batch (
  batch_id     TEXT PRIMARY KEY,
  file_name    TEXT NOT NULL,
  file_sha256  TEXT NOT NULL,
  source_kind  TEXT NOT NULL,
  mapping_json TEXT,
  ok_count     INTEGER NOT NULL DEFAULT 0,
  dup_count    INTEGER NOT NULL DEFAULT 0,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  report_json  TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_batch_hash ON import_batch(file_sha256, source_kind);

CREATE TABLE csv_mapping (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind  TEXT NOT NULL,
  name         TEXT NOT NULL,
  mapping_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_mapping ON csv_mapping(source_kind, name);

CREATE TABLE llm_call_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose          TEXT NOT NULL,
  redacted_payload TEXT NOT NULL,
  provider         TEXT NOT NULL,
  ok               INTEGER NOT NULL,
  latency_ms       INTEGER,
  created_at       TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    // 「条目」：账单信息与建议的统一落点，逐条可列举、可追踪是否已发到邮箱。
    sql: `
CREATE TABLE advice_item (
  item_id       TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,             -- bill（账单信息） | advice（建议）
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  source        TEXT NOT NULL,             -- agent（助手整理） | manual（界面手填） | rules（规则引擎）
  local_date    TEXT NOT NULL,
  needs_confirm INTEGER NOT NULL DEFAULT 0,-- 归属存疑，标记待你确认
  status        TEXT NOT NULL,             -- pending（待发） | sent（已发） | failed（发送失败）
  sent_at       TEXT,
  send_error    TEXT,
  bill_id       TEXT,                      -- kind='bill' 时关联的账单 id
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX ix_item_status ON advice_item(status, created_at);
CREATE INDEX ix_item_date ON advice_item(local_date);
`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

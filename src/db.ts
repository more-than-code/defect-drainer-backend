import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

// rebuildDefectsFts imported lazily inside ensureDefectsFts to avoid cycle
// (analytics imports db helpers)

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  workspace_root TEXT,
  repos_json TEXT NOT NULL DEFAULT '[]',
  repo_url TEXT,
  repo_urls_json TEXT NOT NULL DEFAULT '[]',
  /** Agent sandbox profile: strict | workspace (per App Settings) */
  grok_sandbox TEXT NOT NULL DEFAULT 'strict',
  /** Pre-provisioned agent toolchain: none | flutter (per App Settings) */
  agent_toolchain TEXT NOT NULL DEFAULT 'none',
  /** Grant Simulator device-tree writes for batch jobs (per App Settings) */
  allow_simulator_writes INTEGER NOT NULL DEFAULT 0,
  /** Operator-defined verification commands re-run by DD after a fix job */
  verify_commands_json TEXT NOT NULL DEFAULT '[]',
  /** Batch-fix base: worktrees branch from <base_remote>/<base_branch>; PRs target base_branch. */
  base_remote TEXT NOT NULL DEFAULT 'origin',
  base_branch TEXT NOT NULL DEFAULT 'main',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS defects (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'P2',
  status TEXT NOT NULL DEFAULT 'open',
  area TEXT NOT NULL DEFAULT 'other',
  client TEXT NOT NULL DEFAULT 'unknown',
  surface TEXT NOT NULL DEFAULT '',
  repos_json TEXT NOT NULL DEFAULT '[]',
  labels_json TEXT NOT NULL DEFAULT '[]',
  related_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT '',
  /** Who filed it: operator name or agent tool. source is HOW it was detected. */
  reporter TEXT NOT NULL DEFAULT '',
  key_files_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  fix_evidence_json TEXT NOT NULL DEFAULT '[]',
  reported TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  resolution TEXT,
  resolved_date TEXT,
  duplicate_of TEXT,
  bucket TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (app_id) REFERENCES apps(id)
);

CREATE INDEX IF NOT EXISTS idx_defects_app ON defects(app_id);
CREATE INDEX IF NOT EXISTS idx_defects_bucket ON defects(bucket);
CREATE INDEX IF NOT EXISTS idx_defects_status ON defects(status);
CREATE INDEX IF NOT EXISTS idx_defects_app_bucket ON defects(app_id, bucket);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  defect_ids_json TEXT NOT NULL DEFAULT '[]',
  mode TEXT,
  created TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (app_id) REFERENCES apps(id)
);

CREATE INDEX IF NOT EXISTS idx_batches_app ON batches(app_id);

CREATE INDEX IF NOT EXISTS idx_defects_severity ON defects(severity);
CREATE INDEX IF NOT EXISTS idx_defects_area ON defects(area);
CREATE INDEX IF NOT EXISTS idx_defects_source ON defects(source);

/** Phase A analytics: structured prompt/job events (not log scrapes). */
CREATE TABLE IF NOT EXISTS prompt_use (
  id TEXT PRIMARY KEY,
  prompt_key TEXT NOT NULL,
  prompt_version TEXT NOT NULL DEFAULT '1',
  job_id TEXT,
  batch_id TEXT,
  app_id TEXT NOT NULL DEFAULT '',
  defect_ids_json TEXT NOT NULL DEFAULT '[]',
  outcome TEXT NOT NULL DEFAULT 'unknown',
  runner TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prompt_use_app ON prompt_use(app_id);
CREATE INDEX IF NOT EXISTS idx_prompt_use_key ON prompt_use(prompt_key);
CREATE INDEX IF NOT EXISTS idx_prompt_use_job ON prompt_use(job_id);
CREATE INDEX IF NOT EXISTS idx_prompt_use_created ON prompt_use(created_at);

/** Phase A: denormalized batch job rows for SQL harness analytics. */
CREATE TABLE IF NOT EXISTS job_summary (
  job_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL DEFAULT '',
  app_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT '',
  defect_count INTEGER NOT NULL DEFAULT 0,
  pr_created INTEGER NOT NULL DEFAULT 0,
  pr_merged INTEGER NOT NULL DEFAULT 0,
  pr_open INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_summary_app ON job_summary(app_id);
CREATE INDEX IF NOT EXISTS idx_job_summary_status ON job_summary(status);
CREATE INDEX IF NOT EXISTS idx_job_summary_created ON job_summary(created_at);

/** Phase B fail-soft: docs that failed to publish to OpenSearch. */
CREATE TABLE IF NOT EXISTS search_outbox (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL,
  op TEXT NOT NULL DEFAULT 'index',
  body_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_outbox_updated ON search_outbox(updated_at);
`;

export function resolveDbPath(dataRoot: string): string {
  return path.join(dataRoot, 'defect-drainer.db');
}

export function openDatabase(dataRoot: string): Db {
  mkdirSync(dataRoot, { recursive: true });
  const dbPath = resolveDbPath(dataRoot);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrateAppColumns(db);
  migrateDefectColumns(db);
  ensureDefectsFts(db);
  return db;
}

/** Additive column upgrades for existing SQLite files. */
function migrateAppColumns(db: Db): void {
  const cols = db
    .prepare(`PRAGMA table_info(apps)`)
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('grok_sandbox')) {
    db.exec(
      `ALTER TABLE apps ADD COLUMN grok_sandbox TEXT NOT NULL DEFAULT 'strict'`,
    );
  }
  if (!names.has('agent_toolchain')) {
    db.exec(
      `ALTER TABLE apps ADD COLUMN agent_toolchain TEXT NOT NULL DEFAULT 'none'`,
    );
  }
  if (!names.has('allow_simulator_writes')) {
    db.exec(
      `ALTER TABLE apps ADD COLUMN allow_simulator_writes INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!names.has('verify_commands_json')) {
    db.exec(
      `ALTER TABLE apps ADD COLUMN verify_commands_json TEXT NOT NULL DEFAULT '[]'`,
    );
  }
  if (!names.has('base_remote')) {
    db.exec(
      `ALTER TABLE apps ADD COLUMN base_remote TEXT NOT NULL DEFAULT 'origin'`,
    );
  }
  if (!names.has('base_branch')) {
    db.exec(
      `ALTER TABLE apps ADD COLUMN base_branch TEXT NOT NULL DEFAULT 'main'`,
    );
  }
}

/** Additive column upgrades for existing SQLite files. */
function migrateDefectColumns(db: Db): void {
  const cols = db
    .prepare(`PRAGMA table_info(defects)`)
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has('reporter')) {
    db.exec(`ALTER TABLE defects ADD COLUMN reporter TEXT NOT NULL DEFAULT ''`);
  }
}

/** FTS5 index for Phase A defect find (title/summary/body). */
function ensureDefectsFts(db: Db): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS defects_fts USING fts5(
      id UNINDEXED,
      app_id UNINDEXED,
      title,
      summary,
      body,
      tokenize = 'porter unicode61'
    );
  `);
  try {
    const ftsCount = Number(
      (db.prepare(`SELECT COUNT(*) AS c FROM defects_fts`).get() as { c: number })
        .c,
    );
    const defCount = Number(
      (db.prepare(`SELECT COUNT(*) AS c FROM defects`).get() as { c: number }).c,
    );
    if (defCount > 0 && ftsCount === 0) {
      // Dynamic import avoided — inline rebuild to keep startup sync
      const rows = db
        .prepare(`SELECT id, app_id, title, summary, body FROM defects`)
        .all() as Array<{
        id: string;
        app_id: string;
        title: string;
        summary: string;
        body: string;
      }>;
      const ins = db.prepare(
        `INSERT INTO defects_fts (id, app_id, title, summary, body) VALUES (?,?,?,?,?)`,
      );
      for (const r of rows) {
        ins.run(r.id, r.app_id, r.title || '', r.summary || '', r.body || '');
      }
    }
  } catch {
    /* FTS optional if extension missing */
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function jsonArray(v: unknown): string {
  if (!Array.isArray(v)) return '[]';
  return JSON.stringify(v.map(String));
}

export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.map(String);
  } catch {
    return [];
  }
}

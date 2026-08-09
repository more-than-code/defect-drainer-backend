import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

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

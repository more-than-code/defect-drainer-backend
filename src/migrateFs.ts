/**
 * One-time import of legacy filesystem inventory into SQLite.
 * Safe to call every boot: only runs when target tables are empty.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  appIdFromSeed,
  canonicalizeAppId,
  seededApps,
  type AppRecord,
} from './apps.js';
import type { Db } from './db.js';
import { jsonArray, nowIso } from './db.js';
import { parseMarkdownWithFrontmatter } from './frontmatter.js';
import {
  batchesDir,
  evidenceDir,
  openDir,
  resolvedDir,
  umbrellaRoot,
} from './paths.js';

function asString(v: unknown, fallback = ''): string {
  if (v == null) return fallback;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(String);
}

export function migrateFilesystemIfNeeded(
  db: Db,
  defectsRoot: string = umbrellaRoot,
): { apps: number; defects: number; batches: number } {
  const appsImported = migrateApps(db, defectsRoot);
  const defectsImported = migrateDefects(db, defectsRoot);
  const batchesImported = migrateBatches(db, defectsRoot);
  return {
    apps: appsImported,
    defects: defectsImported,
    batches: batchesImported,
  };
}

function migrateApps(db: Db, defectsRoot: string): number {
  const count = (
    db.prepare('SELECT COUNT(*) AS c FROM apps').get() as { c: number }
  ).c;
  if (count > 0) return 0;

  const ts = nowIso();
  let n = 0;

  // Prefer registry.json
  const regPath = path.join(defectsRoot, 'apps', 'registry.json');
  let apps: AppRecord[] = [];
  if (existsSync(regPath)) {
    try {
      const raw = JSON.parse(readFileSync(regPath, 'utf8')) as {
        apps?: AppRecord[];
      };
      if (Array.isArray(raw.apps)) {
        apps = raw.apps.map((a) => ({
          ...a,
          id: canonicalizeAppId(String(a.id)),
        }));
      }
    } catch {
      /* fall through */
    }
  }
  if (!apps.length) apps = seededApps();

  // Ensure seeded product apps present
  const byId = new Map(apps.map((a) => [a.id, a]));
  for (const s of seededApps()) {
    if (!byId.has(s.id)) byId.set(s.id, s);
  }

  const insert = db.prepare(`
    INSERT INTO apps (
      id, name, description, workspace_root, repos_json, repo_url, repo_urls_json,
      grok_sandbox, is_default, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const a of byId.values()) {
    if (!a.id?.startsWith('app_')) continue;
    const urls = [
      ...(a.repo_urls ?? []),
      ...(a.repo_url ? [a.repo_url] : []),
    ].filter(Boolean);
    insert.run(
      a.id,
      a.name || a.id,
      a.description ?? null,
      a.workspace_root ?? null,
      jsonArray(a.repos ?? []),
      urls.length === 1 ? urls[0]! : null,
      jsonArray(urls.length > 1 ? urls : []),
      a.grok_sandbox === 'workspace' ? 'workspace' : 'strict',
      a.default ? 1 : 0,
      ts,
      ts,
    );
    n += 1;
  }
  return n;
}

function migrateDefects(db: Db, defectsRoot: string): number {
  const count = (
    db.prepare('SELECT COUNT(*) AS c FROM defects').get() as { c: number }
  ).c;
  if (count > 0) return 0;

  let n = 0;
  const insert = db.prepare(`
    INSERT INTO defects (
      id, app_id, title, severity, status, area, client, surface,
      repos_json, labels_json, related_json, source, key_files_json,
      evidence_json, fix_evidence_json, reported, summary, body,
      resolution, resolved_date, duplicate_of, bucket, created_at, updated_at
    ) VALUES (
      ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
    )
  `);

  for (const bucket of ['open', 'resolved'] as const) {
    const dir =
      bucket === 'open' ? openDir(defectsRoot) : resolvedDir(defectsRoot);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md') || name.startsWith('_') || name.startsWith('.'))
        continue;
      const abs = path.join(dir, name);
      try {
        const raw = readFileSync(abs, 'utf8');
        const { frontmatter, body } = parseMarkdownWithFrontmatter(raw);
        const id = asString(frontmatter.id, name.slice(0, -3));
        const app_id = canonicalizeAppId(
          asString(frontmatter.app_id, appIdFromSeed('tutored-webapp')),
        );
        // ensure app exists
        const appRow = db
          .prepare('SELECT id FROM apps WHERE id = ?')
          .get(app_id) as { id: string } | undefined;
        if (!appRow) {
          const ts = nowIso();
          db.prepare(
            `INSERT OR IGNORE INTO apps (id, name, repos_json, repo_urls_json, is_default, created_at, updated_at)
             VALUES (?, ?, '[]', '[]', 0, ?, ?)`,
          ).run(app_id, app_id, ts, ts);
        }
        const ts = nowIso();
        insert.run(
          id,
          app_id,
          asString(frontmatter.title),
          asString(frontmatter.severity, 'P2'),
          asString(
            frontmatter.status,
            bucket === 'resolved' ? 'resolved' : 'open',
          ),
          asString(frontmatter.area, 'other'),
          asString(frontmatter.client, 'unknown'),
          asString(frontmatter.surface),
          jsonArray(asStringArray(frontmatter.repos)),
          jsonArray(asStringArray(frontmatter.labels)),
          jsonArray(asStringArray(frontmatter.related)),
          asString(frontmatter.source, 'screenshot+comment'),
          jsonArray(asStringArray(frontmatter.key_files)),
          jsonArray(asStringArray(frontmatter.evidence)),
          jsonArray(asStringArray(frontmatter.fix_evidence)),
          asString(frontmatter.reported),
          asString(frontmatter.summary),
          body,
          asString(frontmatter.resolution) || null,
          asString(frontmatter.resolved_date) || null,
          asString(frontmatter.duplicate_of) || null,
          bucket,
          ts,
          ts,
        );
        n += 1;
      } catch {
        /* skip corrupt */
      }
    }
  }

  // Ensure evidence dirs known
  const evRoot = evidenceDir(defectsRoot);
  if (existsSync(evRoot)) {
    /* files stay on disk; paths already in evidence_json */
  }
  return n;
}

function migrateBatches(db: Db, defectsRoot: string): number {
  const count = (
    db.prepare('SELECT COUNT(*) AS c FROM batches').get() as { c: number }
  ).c;
  if (count > 0) return 0;

  const dir = batchesDir(defectsRoot);
  if (!existsSync(dir)) return 0;

  let n = 0;
  const insert = db.prepare(`
    INSERT INTO batches (id, app_id, title, goal, status, defect_ids_json, mode, created, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || name.startsWith('.')) continue;
    const abs = path.join(dir, name);
    try {
      const text = readFileSync(abs, 'utf8');
      const id =
        text.match(/\*\*id:\*\*\s*`([^`]+)`/)?.[1] || name.replace(/\.md$/, '');
      const title =
        text.match(/^#\s*Batch:\s*(.+)$/m)?.[1]?.trim() || id;
      const app_id = canonicalizeAppId(
        text.match(/\*\*App:\*\*\s*`([^`]+)`/)?.[1] ||
          appIdFromSeed('tutored-webapp'),
      );
      const goal = text.match(/\*\*Goal:\*\*\s*(.+)$/m)?.[1]?.trim() || '';
      const status =
        text.match(/\*\*Status:\*\*\s*(\w+)/)?.[1]?.trim() || 'planned';
      const mode = text.match(/\*\*Mode:\*\*\s*(\w+)/)?.[1] || null;
      const created =
        text.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/)?.[1] ||
        nowIso().slice(0, 10);
      const defect_ids: string[] = [];
      const defSection = text.split('**Defects:**')[1] || '';
      for (const line of defSection.split('\n')) {
        const m = line.match(/^-\s+(DEF-[A-Za-z0-9._-]+)/);
        if (m) defect_ids.push(m[1]!);
      }
      const appRow = db
        .prepare('SELECT id FROM apps WHERE id = ?')
        .get(app_id) as { id: string } | undefined;
      if (!appRow) continue;
      const ts = nowIso();
      insert.run(
        id,
        app_id,
        title,
        goal,
        status,
        jsonArray(defect_ids),
        mode,
        created,
        ts,
      );
      n += 1;
    } catch {
      /* skip */
    }
  }
  return n;
}


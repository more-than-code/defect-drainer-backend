import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  canonicalizeAppId,
  SEEDED_TUTORED_WEBAPP_APP_ID,
} from './apps.js';
import type { Db } from './db.js';
import { jsonArray, nowIso, parseJsonArray } from './db.js';
import { parseMarkdownWithFrontmatter } from './frontmatter.js';
import { evidenceDir } from './paths.js';

export type DefectStatus =
  | 'open'
  | 'triaged'
  | 'in_progress'
  | 'resolved'
  | 'wontfix'
  | 'duplicate';

export type DefectRecord = {
  id: string;
  app_id: string;
  title: string;
  severity: string;
  status: DefectStatus | string;
  area: string;
  client: string;
  surface: string;
  repos: string[];
  labels: string[];
  related: string[];
  source: string;
  key_files: string[];
  evidence: string[];
  fix_evidence: string[];
  reported: string;
  summary: string;
  resolved_date?: string;
  resolution?: string;
  duplicate_of?: string;
  body: string;
  bucket: 'open' | 'resolved';
  /** Synthetic path for API compatibility */
  path: string;
};

export function isSafeId(id: string): boolean {
  return /^DEF-[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(id);
}

export function slugify(input: string, max = 40): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'defect';
}

export function makeDefectId(comment: string, date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const slug = slugify(comment);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `DEF-${y}${m}${d}-${slug}-${suffix}`;
}

type DefectRow = {
  id: string;
  app_id: string;
  title: string;
  severity: string;
  status: string;
  area: string;
  client: string;
  surface: string;
  repos_json: string;
  labels_json: string;
  related_json: string;
  source: string;
  key_files_json: string;
  evidence_json: string;
  fix_evidence_json: string;
  reported: string;
  summary: string;
  body: string;
  resolution: string | null;
  resolved_date: string | null;
  duplicate_of: string | null;
  bucket: string;
};

function rowToDefect(row: DefectRow): DefectRecord {
  const bucket = row.bucket === 'resolved' ? 'resolved' : 'open';
  return {
    id: row.id,
    app_id: canonicalizeAppId(row.app_id),
    title: row.title,
    severity: row.severity,
    status: row.status,
    area: row.area,
    client: row.client,
    surface: row.surface,
    repos: parseJsonArray(row.repos_json),
    labels: parseJsonArray(row.labels_json),
    related: parseJsonArray(row.related_json),
    source: row.source,
    key_files: parseJsonArray(row.key_files_json),
    evidence: parseJsonArray(row.evidence_json),
    fix_evidence: parseJsonArray(row.fix_evidence_json),
    reported: row.reported,
    summary: row.summary,
    body: row.body,
    resolution: row.resolution || undefined,
    resolved_date: row.resolved_date || undefined,
    duplicate_of: row.duplicate_of || undefined,
    bucket,
    path: `${bucket}/${row.id}.md`,
  };
}

export class DefectStore {
  constructor(
    readonly db: Db,
    /** Root for evidence/ files (not defect markdown) */
    readonly defectsRoot: string,
  ) {
    mkdirSync(evidenceDir(defectsRoot), { recursive: true });
  }

  list(filter?: {
    status?: string;
    bucket?: 'open' | 'resolved' | 'all';
    app_id?: string;
  }): DefectRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.bucket === 'open' || filter?.bucket === 'resolved') {
      clauses.push('bucket = ?');
      params.push(filter.bucket);
    }
    if (filter?.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter?.app_id) {
      clauses.push('app_id = ?');
      params.push(canonicalizeAppId(filter.app_id));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM defects ${where}
         ORDER BY reported DESC, id ASC`,
      )
      .all(...params) as DefectRow[];
    return rows.map(rowToDefect);
  }

  get(id: string): DefectRecord | null {
    if (!isSafeId(id)) return null;
    const row = this.db
      .prepare('SELECT * FROM defects WHERE id = ?')
      .get(id) as DefectRow | undefined;
    return row ? rowToDefect(row) : null;
  }

  write(
    record: Omit<DefectRecord, 'path' | 'bucket'> & {
      bucket?: 'open' | 'resolved';
    },
  ): DefectRecord {
    if (!isSafeId(record.id)) {
      throw new Error(`invalid defect id: ${record.id}`);
    }
    const bucket =
      record.bucket ??
      (record.status === 'resolved' || record.status === 'wontfix'
        ? 'resolved'
        : 'open');
    const app_id = canonicalizeAppId(record.app_id || SEEDED_TUTORED_WEBAPP_APP_ID);
    const ts = nowIso();
    const existing = this.get(record.id);

    if (existing) {
      this.db
        .prepare(
          `UPDATE defects SET
            app_id=?, title=?, severity=?, status=?, area=?, client=?, surface=?,
            repos_json=?, labels_json=?, related_json=?, source=?, key_files_json=?,
            evidence_json=?, fix_evidence_json=?, reported=?, summary=?, body=?,
            resolution=?, resolved_date=?, duplicate_of=?, bucket=?, updated_at=?
           WHERE id=?`,
        )
        .run(
          app_id,
          record.title,
          record.severity,
          record.status,
          record.area,
          record.client,
          record.surface,
          jsonArray(record.repos),
          jsonArray(record.labels),
          jsonArray(record.related),
          record.source,
          jsonArray(record.key_files),
          jsonArray(record.evidence),
          jsonArray(record.fix_evidence ?? []),
          record.reported,
          record.summary,
          record.body,
          record.resolution ?? null,
          record.resolved_date ?? null,
          record.duplicate_of ?? null,
          bucket,
          ts,
          record.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO defects (
            id, app_id, title, severity, status, area, client, surface,
            repos_json, labels_json, related_json, source, key_files_json,
            evidence_json, fix_evidence_json, reported, summary, body,
            resolution, resolved_date, duplicate_of, bucket, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          record.id,
          app_id,
          record.title,
          record.severity,
          record.status,
          record.area,
          record.client,
          record.surface,
          jsonArray(record.repos),
          jsonArray(record.labels),
          jsonArray(record.related),
          record.source,
          jsonArray(record.key_files),
          jsonArray(record.evidence),
          jsonArray(record.fix_evidence ?? []),
          record.reported,
          record.summary,
          record.body,
          record.resolution ?? null,
          record.resolved_date ?? null,
          record.duplicate_of ?? null,
          bucket,
          ts,
          ts,
        );
    }
    return this.get(record.id)!;
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        DefectRecord,
        | 'title'
        | 'app_id'
        | 'severity'
        | 'status'
        | 'area'
        | 'client'
        | 'surface'
        | 'repos'
        | 'labels'
        | 'related'
        | 'source'
        | 'key_files'
        | 'evidence'
        | 'fix_evidence'
        | 'summary'
        | 'body'
        | 'resolution'
        | 'resolved_date'
        | 'duplicate_of'
      >
    >,
  ): DefectRecord {
    const cur = this.get(id);
    if (!cur) throw new Error(`defect not found: ${id}`);
    const next: DefectRecord = { ...cur, id: cur.id };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      (next as Record<string, unknown>)[k] = v;
    }
    if (patch.status === 'resolved' || patch.status === 'wontfix') {
      next.bucket = 'resolved';
      if (!next.resolved_date) {
        next.resolved_date = new Date().toISOString().slice(0, 10);
      }
    } else if (
      patch.status === 'open' ||
      patch.status === 'triaged' ||
      patch.status === 'in_progress'
    ) {
      next.bucket = 'open';
    }
    return this.write(next);
  }

  resolve(
    id: string,
    opts?: {
      resolution?: string;
      fix_evidence?: string[];
      skipEvidenceCheck?: boolean;
    },
  ): DefectRecord {
    const cur = this.get(id);
    if (!cur) throw new Error(`defect not found: ${id}`);
    const fix_evidence = opts?.fix_evidence ?? cur.fix_evidence ?? [];
    if (!opts?.skipEvidenceCheck && fix_evidence.length === 0) {
      throw new Error(
        'fix_evidence required: attach post-fix screenshot(s) before resolve',
      );
    }
    return this.update(id, {
      status: 'resolved',
      resolution: opts?.resolution ?? cur.resolution ?? 'resolved',
      resolved_date: new Date().toISOString().slice(0, 10),
      fix_evidence,
    });
  }

  reopen(id: string): DefectRecord {
    const cur = this.get(id);
    if (!cur) throw new Error(`defect not found: ${id}`);
    return this.write({
      ...cur,
      status: 'open',
      bucket: 'open',
      resolution: undefined,
      resolved_date: undefined,
    });
  }

  delete(id: string, opts?: { evidence?: boolean }): boolean {
    const cur = this.get(id);
    if (!cur) return false;
    this.db.prepare('DELETE FROM defects WHERE id = ?').run(id);
    if (opts?.evidence) {
      const ev = path.join(evidenceDir(this.defectsRoot), id);
      if (existsSync(ev)) {
        rmSync(ev, { recursive: true, force: true });
      }
    }
    return true;
  }

  saveEvidence(
    id: string,
    files: Array<{ filename: string; data: Buffer }>,
    opts?: { kind?: 'report' | 'fix' },
  ): string[] {
    if (!isSafeId(id)) throw new Error(`invalid defect id: ${id}`);
    const kind = opts?.kind ?? 'report';
    const dir = path.join(evidenceDir(this.defectsRoot), id);
    mkdirSync(dir, { recursive: true });
    const existing = existsSync(dir)
      ? readdirSync(dir).filter((n) => !n.startsWith('.'))
      : [];
    const prefix = kind === 'fix' ? 'fix-' : '';
    const used = new Set(existing);
    const paths: string[] = [];
    let n = 1;
    for (const f of files) {
      const ext = path.extname(f.filename || '').toLowerCase() || '.png';
      const safeExt = /^\.(png|jpe?g|webp|gif|heic)$/i.test(ext) ? ext : '.png';
      let name = `${prefix}${String(n).padStart(2, '0')}${safeExt}`;
      while (used.has(name)) {
        n += 1;
        name = `${prefix}${String(n).padStart(2, '0')}${safeExt}`;
      }
      used.add(name);
      writeFileSync(path.join(dir, name), f.data);
      paths.push(path.join('evidence', id, name));
      n += 1;
    }
    return paths;
  }

  addFixEvidence(
    id: string,
    files: Array<{ filename: string; data: Buffer }>,
  ): DefectRecord {
    const cur = this.get(id);
    if (!cur) throw new Error(`defect not found: ${id}`);
    const added = this.saveEvidence(id, files, { kind: 'fix' });
    return this.update(id, {
      fix_evidence: [...(cur.fix_evidence || []), ...added],
    });
  }

  evidenceAbs(relPath: string): string | null {
    const normalized = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
    if (
      !normalized.startsWith('evidence' + path.sep) &&
      !normalized.startsWith('evidence/')
    ) {
      if (!/^evidence[/\\]/.test(normalized.replace(/\\/g, '/'))) return null;
    }
    const abs = path.resolve(this.defectsRoot, normalized);
    const root = path.resolve(evidenceDir(this.defectsRoot));
    if (!abs.startsWith(root + path.sep) && abs !== root) return null;
    if (!existsSync(abs)) return null;
    return abs;
  }

  promoteFromHandoff(opts: {
    id: string;
    defectMarkdown: string;
    evidenceFiles: Array<{ filename: string; absPath: string }>;
  }): DefectRecord {
    const { frontmatter, body } = parseMarkdownWithFrontmatter(opts.defectMarkdown);
    const asString = (v: unknown, fallback = '') =>
      v == null ? fallback : String(v);
    const asStringArray = (v: unknown) =>
      Array.isArray(v) ? v.map(String) : [];

    const evidence = this.saveEvidence(
      opts.id,
      opts.evidenceFiles.map((f) => ({
        filename: f.filename,
        data: readFileSync(f.absPath),
      })),
    );
    return this.write({
      id: opts.id,
      title: asString(frontmatter.title, 'Untitled defect'),
      app_id: canonicalizeAppId(
        asString(frontmatter.app_id, SEEDED_TUTORED_WEBAPP_APP_ID),
      ),
      severity: asString(frontmatter.severity, 'P2'),
      status: asString(frontmatter.status, 'open'),
      area: asString(frontmatter.area, 'other'),
      client: asString(frontmatter.client, 'unknown'),
      surface: asString(frontmatter.surface),
      repos: asStringArray(frontmatter.repos),
      labels: asStringArray(frontmatter.labels),
      related: asStringArray(frontmatter.related),
      source: asString(frontmatter.source, 'screenshot+comment'),
      key_files: asStringArray(frontmatter.key_files),
      evidence,
      fix_evidence: asStringArray(frontmatter.fix_evidence),
      reported: asString(
        frontmatter.reported,
        new Date().toISOString().slice(0, 10),
      ),
      summary: asString(frontmatter.summary),
      body,
      bucket: 'open',
    });
  }
}

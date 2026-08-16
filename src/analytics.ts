/**
 * Phase A search & analytics — SQL aggregates + FTS over SSOT.
 * See docs/search-and-analytics.md.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import { jsonArray, nowIso, parseJsonArray } from './db.js';
import { promptUseDoc } from './search/documents.js';
import { jobSummaryDoc } from './search/documents.js';
import { publishDocumentsBackground } from './search/publisher.js';

export type PromptOutcome =
  | 'success'
  | 'fail'
  | 'aborted'
  | 'unknown'
  | string;

export type PromptUseInput = {
  prompt_key: string;
  prompt_version?: string;
  job_id?: string;
  batch_id?: string;
  app_id: string;
  defect_ids?: string[];
  outcome?: PromptOutcome;
  runner?: string;
  body_text?: string;
  id?: string;
};

export type JobSummaryInput = {
  job_id: string;
  batch_id?: string;
  app_id: string;
  status: string;
  mode?: string;
  defect_ids?: string[];
  prs?: Array<{ status?: string; ghState?: string }>;
  error?: string;
  created_at: string;
  updated_at?: string;
};

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

/** Record a structured prompt invocation (batch fix, etc.). */
export function recordPromptUse(db: Db, input: PromptUseInput): string {
  const id = input.id?.trim() || makeId('pu');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO prompt_use (
      id, prompt_key, prompt_version, job_id, batch_id, app_id,
      defect_ids_json, outcome, runner, body_text, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    (input.prompt_key || 'unknown').slice(0, 200),
    (input.prompt_version || '1').slice(0, 40),
    input.job_id ?? null,
    input.batch_id ?? null,
    input.app_id || '',
    jsonArray(input.defect_ids ?? []),
    input.outcome || 'unknown',
    (input.runner || '').slice(0, 80),
    (input.body_text || '').slice(0, 2000),
    ts,
    ts,
  );
  try {
    publishDocumentsBackground(
      { db },
      [
        promptUseDoc({
          id,
          prompt_key: (input.prompt_key || 'unknown').slice(0, 200),
          app_id: input.app_id || '',
          job_id: input.job_id,
          batch_id: input.batch_id,
          body_text: (input.body_text || '').slice(0, 2000),
          outcome: input.outcome || 'unknown',
          created_at: ts,
          defect_ids: input.defect_ids,
        }),
      ],
    );
  } catch {
    /* ignore */
  }
  return id;
}

/** Update outcome for the latest prompt_use row for a job (or all rows for job_id). */
export function setPromptUseOutcomeForJob(
  db: Db,
  jobId: string,
  outcome: PromptOutcome,
): void {
  if (!jobId) return;
  db.prepare(
    `UPDATE prompt_use SET outcome = ?, updated_at = ? WHERE job_id = ?`,
  ).run(outcome, nowIso(), jobId);
}

export function upsertJobSummary(db: Db, input: JobSummaryInput): void {
  const prs = input.prs || [];
  let pr_created = 0;
  let pr_merged = 0;
  let pr_open = 0;
  for (const p of prs) {
    if (p.status === 'created' || p.status === 'existing') pr_created += 1;
    if (p.ghState === 'merged') pr_merged += 1;
    if (p.ghState === 'open') pr_open += 1;
  }
  const terminal =
    input.status === 'completed' ||
    input.status === 'failed' ||
    input.status === 'cancelled' ||
    input.status === 'manual';
  const updated = input.updated_at || nowIso();
  const completed_at = terminal ? updated : null;

  db.prepare(
    `INSERT INTO job_summary (
      job_id, batch_id, app_id, status, mode, defect_count,
      pr_created, pr_merged, pr_open, error, created_at, updated_at, completed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(job_id) DO UPDATE SET
      batch_id=excluded.batch_id,
      app_id=excluded.app_id,
      status=excluded.status,
      mode=excluded.mode,
      defect_count=excluded.defect_count,
      pr_created=excluded.pr_created,
      pr_merged=excluded.pr_merged,
      pr_open=excluded.pr_open,
      error=excluded.error,
      updated_at=excluded.updated_at,
      completed_at=COALESCE(job_summary.completed_at, excluded.completed_at)`,
  ).run(
    input.job_id,
    input.batch_id || '',
    input.app_id || '',
    input.status || '',
    input.mode || '',
    (input.defect_ids || []).length,
    pr_created,
    pr_merged,
    pr_open,
    input.error ? String(input.error).slice(0, 500) : null,
    input.created_at,
    updated,
    completed_at,
  );
  try {
    publishDocumentsBackground(
      { db },
      jobSummaryDoc({
        job_id: input.job_id,
        batch_id: input.batch_id,
        app_id: input.app_id,
        status: input.status,
        mode: input.mode,
        error: input.error,
        created_at: input.created_at,
        updated_at: updated,
        defect_ids: input.defect_ids,
      }),
    );
  } catch {
    /* ignore */
  }
}

export function deleteJobSummary(db: Db, jobId: string): void {
  db.prepare(`DELETE FROM job_summary WHERE job_id = ?`).run(jobId);
}

export function syncDefectFts(
  db: Db,
  rec: {
    id: string;
    app_id: string;
    title?: string;
    summary?: string;
    body?: string;
  },
): void {
  db.prepare(`DELETE FROM defects_fts WHERE id = ?`).run(rec.id);
  db.prepare(
    `INSERT INTO defects_fts (id, app_id, title, summary, body) VALUES (?,?,?,?,?)`,
  ).run(
    rec.id,
    rec.app_id || '',
    rec.title || '',
    rec.summary || '',
    rec.body || '',
  );
}

export function removeDefectFts(db: Db, id: string): void {
  db.prepare(`DELETE FROM defects_fts WHERE id = ?`).run(id);
}

/** Rebuild FTS from defects table (migrate / repair). */
export function rebuildDefectsFts(db: Db): number {
  db.exec(`DELETE FROM defects_fts`);
  const rows = db
    .prepare(
      `SELECT id, app_id, title, summary, body FROM defects`,
    )
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
  return rows.length;
}

type AggRow = { key: string; count: number };

function groupCount(
  db: Db,
  sql: string,
  params: Array<string | number | null>,
): AggRow[] {
  const rows = db.prepare(sql).all(...params) as Array<{
    key: string | null;
    count: number | bigint;
  }>;
  return rows.map((r) => ({
    key: r.key == null || r.key === '' ? '(empty)' : String(r.key),
    count: Number(r.count),
  }));
}

export type AnalyticsSummary = {
  app_id: string | null;
  defects: {
    total: number;
    by_severity: AggRow[];
    by_area: AggRow[];
    by_status: AggRow[];
    by_source: AggRow[];
    by_bucket: AggRow[];
    by_surface: AggRow[];
  };
  prompts: {
    total: number;
    top: Array<{
      prompt_key: string;
      uses: number;
      success: number;
      fail: number;
      aborted: number;
      unknown: number;
      last_used: string;
    }>;
  };
  jobs: {
    total: number;
    by_status: AggRow[];
    completed: number;
    failed: number;
    success_rate: number | null;
    pr_merged_total: number;
  };
};

export function getAnalyticsSummary(
  db: Db,
  opts?: { app_id?: string },
): AnalyticsSummary {
  const appId = opts?.app_id?.trim() || null;
  const appClause = appId ? 'WHERE app_id = ?' : '';
  const appParams = appId ? [appId] : [];

  const defectTotal = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS c FROM defects ${appClause}`)
        .get(...appParams) as { c: number | bigint }
    ).c,
  );

  const by = (col: string) =>
    groupCount(
      db,
      `SELECT ${col} AS key, COUNT(*) AS count FROM defects ${appClause} GROUP BY ${col} ORDER BY count DESC LIMIT 30`,
      appParams,
    );

  const promptTotal = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS c FROM prompt_use ${appClause}`)
        .get(...appParams) as { c: number | bigint }
    ).c,
  );

  const topPrompts = db
    .prepare(
      `SELECT prompt_key,
        COUNT(*) AS uses,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN outcome = 'fail' THEN 1 ELSE 0 END) AS fail,
        SUM(CASE WHEN outcome = 'aborted' THEN 1 ELSE 0 END) AS aborted,
        SUM(CASE WHEN outcome = 'unknown' OR outcome IS NULL OR outcome = '' THEN 1 ELSE 0 END) AS unknown,
        MAX(created_at) AS last_used
      FROM prompt_use
      ${appClause}
      GROUP BY prompt_key
      ORDER BY uses DESC
      LIMIT 25`,
    )
    .all(...appParams) as Array<{
    prompt_key: string;
    uses: number | bigint;
    success: number | bigint;
    fail: number | bigint;
    aborted: number | bigint;
    unknown: number | bigint;
    last_used: string;
  }>;

  const jobTotal = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS c FROM job_summary ${appClause}`)
        .get(...appParams) as { c: number | bigint }
    ).c,
  );

  const jobByStatus = groupCount(
    db,
    `SELECT status AS key, COUNT(*) AS count FROM job_summary ${appClause} GROUP BY status ORDER BY count DESC`,
    appParams,
  );

  const countJobsByStatus = (status: string) =>
    Number(
      (
        db
          .prepare(
            appId
              ? `SELECT COUNT(*) AS c FROM job_summary WHERE app_id = ? AND status = ?`
              : `SELECT COUNT(*) AS c FROM job_summary WHERE status = ?`,
          )
          .get(...(appId ? [appId, status] : [status])) as {
          c: number | bigint;
        }
      ).c,
    );
  const completed = countJobsByStatus('completed');
  const failed = countJobsByStatus('failed');
  const denom = completed + failed;
  const prMerged = Number(
    (
      db
        .prepare(
          appId
            ? `SELECT COALESCE(SUM(pr_merged),0) AS c FROM job_summary WHERE app_id = ?`
            : `SELECT COALESCE(SUM(pr_merged),0) AS c FROM job_summary`,
        )
        .get(...(appId ? [appId] : [])) as { c: number | bigint }
    ).c,
  );

  return {
    app_id: appId,
    defects: {
      total: defectTotal,
      by_severity: by('severity'),
      by_area: by('area'),
      by_status: by('status'),
      by_source: by('source'),
      by_bucket: by('bucket'),
      by_surface: by('surface'),
    },
    prompts: {
      total: promptTotal,
      top: topPrompts.map((r) => ({
        prompt_key: r.prompt_key,
        uses: Number(r.uses),
        success: Number(r.success),
        fail: Number(r.fail),
        aborted: Number(r.aborted),
        unknown: Number(r.unknown),
        last_used: r.last_used,
      })),
    },
    jobs: {
      total: jobTotal,
      by_status: jobByStatus,
      completed,
      failed,
      success_rate: denom > 0 ? completed / denom : null,
      pr_merged_total: prMerged,
    },
  };
}

export type SearchHit = {
  id: string;
  app_id: string;
  title: string;
  summary: string;
  severity: string;
  status: string;
  area: string;
  bucket: string;
  snippet?: string;
};

/**
 * Phase A find: FTS5 when q present, else recent defects.
 * Falls back to LIKE if FTS errors.
 */
export function searchDefects(
  db: Db,
  opts: { q?: string; app_id?: string; limit?: number },
): { hits: SearchHit[]; mode: 'fts' | 'like' | 'recent' } {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
  const appId = opts.app_id?.trim();
  const q = (opts.q || '').trim();

  if (!q) {
    const rows = db
      .prepare(
        appId
          ? `SELECT id, app_id, title, summary, severity, status, area, bucket
             FROM defects WHERE app_id = ? ORDER BY updated_at DESC LIMIT ?`
          : `SELECT id, app_id, title, summary, severity, status, area, bucket
             FROM defects ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...(appId ? [appId, limit] : [limit])) as SearchHit[];
    return { hits: rows, mode: 'recent' };
  }

  // FTS5: quote tokens lightly — strip quotes, join with AND
  const tokens = q
    .replace(/["']/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (!tokens.length) {
    return searchDefects(db, { ...opts, q: '' });
  }
  const ftsQuery = tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ');

  try {
    const sql = appId
      ? `SELECT d.id, d.app_id, d.title, d.summary, d.severity, d.status, d.area, d.bucket,
               snippet(defects_fts, 2, '[', ']', '…', 12) AS snippet
         FROM defects_fts
         JOIN defects d ON d.id = defects_fts.id
         WHERE defects_fts MATCH ? AND d.app_id = ?
         ORDER BY rank
         LIMIT ?`
      : `SELECT d.id, d.app_id, d.title, d.summary, d.severity, d.status, d.area, d.bucket,
               snippet(defects_fts, 2, '[', ']', '…', 12) AS snippet
         FROM defects_fts
         JOIN defects d ON d.id = defects_fts.id
         WHERE defects_fts MATCH ?
         ORDER BY rank
         LIMIT ?`;
    const hits = db
      .prepare(sql)
      .all(...(appId ? [ftsQuery, appId, limit] : [ftsQuery, limit])) as SearchHit[];
    return { hits, mode: 'fts' };
  } catch {
    const like = `%${q.slice(0, 80)}%`;
    const hits = db
      .prepare(
        appId
          ? `SELECT id, app_id, title, summary, severity, status, area, bucket
             FROM defects
             WHERE app_id = ?
               AND (title LIKE ? OR summary LIKE ? OR body LIKE ?)
             ORDER BY updated_at DESC LIMIT ?`
          : `SELECT id, app_id, title, summary, severity, status, area, bucket
             FROM defects
             WHERE title LIKE ? OR summary LIKE ? OR body LIKE ?
             ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(
        ...(appId
          ? [appId, like, like, like, limit]
          : [like, like, like, limit]),
      ) as SearchHit[];
    return { hits, mode: 'like' };
  }
}

export function jobStatusToPromptOutcome(status: string): PromptOutcome {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'fail';
  if (status === 'cancelled') return 'aborted';
  if (status === 'manual') return 'success';
  return 'unknown';
}

export function parsePromptDefectIds(raw: string): string[] {
  return parseJsonArray(raw);
}

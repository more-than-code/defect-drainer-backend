/** Full reindex from SQLite SSOT into OpenSearch (Phase B). */
import type { Db } from '../db.js';
import { parseJsonArray } from '../db.js';
import type { DefectStore } from '../store.js';
import { allDocsForDefect, jobSummaryDoc, promptUseDoc } from './documents.js';
import { publishDocuments } from './publisher.js';
import type { SearchDocument } from './types.js';

export async function reindexAll(
  db: Db,
  store: DefectStore,
): Promise<{ docs: number; ok: boolean; error?: string }> {
  const docs: SearchDocument[] = [];

  for (const d of store.list({ bucket: 'all' })) {
    docs.push(...allDocsForDefect(d));
  }

  const prompts = db
    .prepare(
      `SELECT id, prompt_key, app_id, job_id, batch_id, body_text, outcome, created_at, defect_ids_json
       FROM prompt_use`,
    )
    .all() as Array<{
    id: string;
    prompt_key: string;
    app_id: string;
    job_id: string | null;
    batch_id: string | null;
    body_text: string;
    outcome: string;
    created_at: string;
    defect_ids_json: string;
  }>;
  for (const p of prompts) {
    docs.push(
      promptUseDoc({
        ...p,
        defect_ids: parseJsonArray(p.defect_ids_json),
      }),
    );
  }

  const jobs = db
    .prepare(
      `SELECT job_id, batch_id, app_id, status, mode, error, created_at, updated_at, defect_count
       FROM job_summary`,
    )
    .all() as Array<{
    job_id: string;
    batch_id: string;
    app_id: string;
    status: string;
    mode: string;
    error: string | null;
    created_at: string;
    updated_at: string;
    defect_count: number;
  }>;
  for (const j of jobs) {
    docs.push(
      ...jobSummaryDoc({
        ...j,
        defect_ids: [],
      }),
    );
  }

  // Chunk bulk
  const chunk = 100;
  let published = 0;
  let lastErr: string | undefined;
  for (let i = 0; i < docs.length; i += chunk) {
    const slice = docs.slice(i, i + chunk);
    const r = await publishDocuments({ db }, slice);
    published += r.published;
    if (!r.ok) lastErr = r.error;
  }
  return {
    docs: docs.length,
    ok: !lastErr && published === docs.length,
    error: lastErr,
  };
}

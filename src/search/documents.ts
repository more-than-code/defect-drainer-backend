/** Build OpenSearch envelope docs from SSOT entities. */
import type { DefectRecord } from '../store.js';
import type { SearchDocument } from './types.js';

export function defectSummaryDoc(d: DefectRecord): SearchDocument {
  return {
    _id: `defect_summary:${d.id}`,
    artifact_type: 'defect_summary',
    app_id: d.app_id,
    defect_id: d.id,
    severity: d.severity,
    area: d.area,
    status: d.status,
    source: d.source,
    surface: d.surface,
    title: d.title,
    body_text: [d.summary, d.body, d.resolution].filter(Boolean).join('\n\n'),
    labels: d.labels || [],
    created_at: undefined,
    updated_at: undefined,
    blob_uri: null,
  };
}

export function evidenceDocs(d: DefectRecord): SearchDocument[] {
  const out: SearchDocument[] = [];
  for (const rel of d.evidence || []) {
    const file = rel.split(/[/\\]/).pop() || rel;
    out.push({
      _id: `screenshot:${d.id}:${file}`,
      artifact_type: 'screenshot',
      app_id: d.app_id,
      defect_id: d.id,
      severity: d.severity,
      area: d.area,
      status: d.status,
      title: file,
      body_text: `${d.title} ${d.summary}`.trim(),
      blob_uri: rel,
      labels: d.labels || [],
    });
  }
  for (const rel of d.fix_evidence || []) {
    const file = rel.split(/[/\\]/).pop() || rel;
    out.push({
      _id: `fix_evidence:${d.id}:${file}`,
      artifact_type: 'fix_evidence',
      app_id: d.app_id,
      defect_id: d.id,
      severity: d.severity,
      area: d.area,
      status: d.status,
      title: file,
      body_text: `${d.title} fix evidence`.trim(),
      blob_uri: rel,
      labels: d.labels || [],
    });
  }
  return out;
}

export function promptUseDoc(row: {
  id: string;
  prompt_key: string;
  app_id: string;
  job_id?: string | null;
  batch_id?: string | null;
  body_text?: string;
  outcome?: string;
  created_at?: string;
  defect_ids?: string[];
}): SearchDocument {
  const primaryDefect = row.defect_ids?.[0] ?? null;
  return {
    _id: `prompt:${row.id}`,
    artifact_type: 'prompt',
    app_id: row.app_id,
    defect_id: primaryDefect,
    job_id: row.job_id ?? null,
    batch_id: row.batch_id ?? null,
    prompt_key: row.prompt_key,
    title: row.prompt_key,
    body_text: row.body_text || '',
    status: row.outcome || 'unknown',
    created_at: row.created_at ?? null,
  };
}

export function jobSummaryDoc(row: {
  job_id: string;
  batch_id?: string;
  app_id: string;
  status: string;
  mode?: string;
  error?: string | null;
  created_at: string;
  updated_at?: string;
  log_excerpt?: string;
  defect_ids?: string[];
}): SearchDocument[] {
  const docs: SearchDocument[] = [
    {
      _id: `job_summary:${row.job_id}`,
      artifact_type: 'job_summary',
      app_id: row.app_id,
      job_id: row.job_id,
      batch_id: row.batch_id ?? null,
      defect_id: row.defect_ids?.[0] ?? null,
      status: row.status,
      title: `${row.job_id} (${row.status})`,
      body_text: [row.mode, row.error, row.status].filter(Boolean).join(' · '),
      created_at: row.created_at,
      updated_at: row.updated_at ?? null,
    },
  ];
  if (row.log_excerpt?.trim()) {
    docs.push({
      _id: `job_log:${row.job_id}`,
      artifact_type: 'job_log',
      app_id: row.app_id,
      job_id: row.job_id,
      batch_id: row.batch_id ?? null,
      status: row.status,
      title: `log ${row.job_id}`,
      body_text: row.log_excerpt.slice(0, 8000),
      created_at: row.created_at,
    });
  }
  return docs;
}

export function allDocsForDefect(d: DefectRecord): SearchDocument[] {
  return [defectSummaryDoc(d), ...evidenceDocs(d)];
}

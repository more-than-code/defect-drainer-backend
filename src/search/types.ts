/** Multi-artifact envelope for OpenSearch (Phase B). */

export type ArtifactType =
  | 'defect_summary'
  | 'screenshot'
  | 'fix_evidence'
  | 'prompt'
  | 'job_summary'
  | 'job_log'
  | 'note'
  | string;

export type SearchDocument = {
  artifact_type: ArtifactType;
  app_id: string;
  defect_id?: string | null;
  job_id?: string | null;
  batch_id?: string | null;
  severity?: string | null;
  area?: string | null;
  status?: string | null;
  source?: string | null;
  surface?: string | null;
  title?: string | null;
  body_text?: string | null;
  prompt_key?: string | null;
  labels?: string[];
  created_at?: string | null;
  updated_at?: string | null;
  blob_uri?: string | null;
  /** Stable document id in the index */
  _id: string;
};

export type SearchHit = {
  id: string;
  artifact_type: string;
  app_id: string;
  defect_id?: string | null;
  job_id?: string | null;
  batch_id?: string | null;
  title?: string | null;
  body_text?: string | null;
  severity?: string | null;
  status?: string | null;
  area?: string | null;
  prompt_key?: string | null;
  blob_uri?: string | null;
  score?: number;
  snippet?: string;
};

export type FacetBucket = { key: string; count: number };

export type MultiSearchResult = {
  mode: 'opensearch' | 'fts' | 'like' | 'recent' | 'disabled';
  hits: SearchHit[];
  total: number;
  facets?: {
    artifact_type?: FacetBucket[];
    severity?: FacetBucket[];
    area?: FacetBucket[];
    status?: FacetBucket[];
  };
  opensearch?: {
    url: string;
    index: string;
    ok: boolean;
    error?: string;
  };
};

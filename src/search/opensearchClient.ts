/**
 * Minimal OpenSearch REST client (fetch). No heavy SDK.
 * Disabled when DEFECT_DRAINER_OPENSEARCH_URL is unset.
 */
import { envDrainer } from '../env.js';

export type OsHttp = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; json: unknown; text: string }>;

export type OpenSearchConfig = {
  url: string;
  index: string;
  enabled: boolean;
};

export function getOpenSearchConfig(): OpenSearchConfig {
  const url = (envDrainer('OPENSEARCH_URL') || '').replace(/\/+$/, '');
  const index =
    envDrainer('OPENSEARCH_INDEX')?.trim() || 'defect-drainer-artifacts';
  return {
    url,
    index,
    enabled: Boolean(url),
  };
}

export function createOsHttp(baseUrl: string): OsHttp {
  return async (method, path, body) => {
    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const res = await fetch(url, {
      method,
      headers:
        body === undefined
          ? { Accept: 'application/json' }
          : {
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12_000),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  };
}

const INDEX_BODY = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      analyzer: {
        default: {
          type: 'standard',
        },
      },
    },
  },
  mappings: {
    properties: {
      artifact_type: { type: 'keyword' },
      app_id: { type: 'keyword' },
      defect_id: { type: 'keyword' },
      job_id: { type: 'keyword' },
      batch_id: { type: 'keyword' },
      severity: { type: 'keyword' },
      area: { type: 'keyword' },
      status: { type: 'keyword' },
      source: { type: 'keyword' },
      surface: { type: 'keyword' },
      title: { type: 'text', fields: { raw: { type: 'keyword', ignore_above: 256 } } },
      body_text: { type: 'text' },
      prompt_key: { type: 'keyword' },
      labels: { type: 'keyword' },
      created_at: { type: 'date', format: 'strict_date_optional_time||epoch_millis' },
      updated_at: { type: 'date', format: 'strict_date_optional_time||epoch_millis' },
      blob_uri: { type: 'keyword', index: false },
    },
  },
};

export async function ensureIndex(
  http: OsHttp,
  index: string,
): Promise<void> {
  const head = await http('HEAD', `/${index}`);
  if (head.status === 200) return;
  const put = await http('PUT', `/${index}`, INDEX_BODY);
  if (put.status >= 300 && put.status !== 400) {
    // 400 often "resource_already_exists"
    const err =
      typeof put.json === 'object' && put.json && 'error' in (put.json as object)
        ? JSON.stringify((put.json as { error: unknown }).error)
        : put.text.slice(0, 300);
    if (!/resource_already_exists|already_exists/i.test(err)) {
      throw new Error(`opensearch create index ${put.status}: ${err}`);
    }
  }
}

export async function bulkIndex(
  http: OsHttp,
  index: string,
  docs: Array<{ id: string; body: Record<string, unknown> }>,
): Promise<{ errors: boolean; items: unknown }> {
  if (!docs.length) return { errors: false, items: [] };
  const lines: string[] = [];
  for (const d of docs) {
    lines.push(JSON.stringify({ index: { _index: index, _id: d.id } }));
    lines.push(JSON.stringify(d.body));
  }
  const raw = `${lines.join('\n')}\n`;
  const urlPath = `/_bulk`;
  // bulk needs ndjson content-type
  const cfg = getOpenSearchConfig();
  const res = await fetch(`${cfg.url}${urlPath}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-ndjson',
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: { errors?: boolean; items?: unknown } = {};
  try {
    json = JSON.parse(text) as { errors?: boolean; items?: unknown };
  } catch {
    throw new Error(`opensearch bulk non-json ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status >= 300) {
    throw new Error(`opensearch bulk ${res.status}: ${text.slice(0, 300)}`);
  }
  return { errors: Boolean(json.errors), items: json.items };
}

/** bulkIndex with injectable base URL (tests / custom http not used for bulk body). */
export async function bulkIndexAt(
  baseUrl: string,
  index: string,
  docs: Array<{ id: string; body: Record<string, unknown> }>,
): Promise<{ errors: boolean; items: unknown }> {
  if (!docs.length) return { errors: false, items: [] };
  const lines: string[] = [];
  for (const d of docs) {
    lines.push(JSON.stringify({ index: { _index: index, _id: d.id } }));
    lines.push(JSON.stringify(d.body));
  }
  const raw = `${lines.join('\n')}\n`;
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/_bulk`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-ndjson',
    },
    body: raw,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: { errors?: boolean; items?: unknown } = {};
  try {
    json = JSON.parse(text) as { errors?: boolean; items?: unknown };
  } catch {
    throw new Error(`opensearch bulk non-json ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status >= 300) {
    throw new Error(`opensearch bulk ${res.status}: ${text.slice(0, 300)}`);
  }
  return { errors: Boolean(json.errors), items: json.items };
}

export async function deleteById(
  http: OsHttp,
  index: string,
  id: string,
): Promise<void> {
  await http('DELETE', `/${index}/_doc/${encodeURIComponent(id)}`);
}

export async function ping(http: OsHttp): Promise<boolean> {
  try {
    const r = await http('GET', '/');
    return r.status < 300;
  } catch {
    return false;
  }
}

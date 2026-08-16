/**
 * Phase B multi-artifact search via OpenSearch, with Phase A FTS fallback.
 */
import { searchDefects } from '../analytics.js';
import type { Db } from '../db.js';
import {
  createOsHttp,
  ensureIndex,
  getOpenSearchConfig,
  type OsHttp,
} from './opensearchClient.js';
import type {
  FacetBucket,
  MultiSearchResult,
  SearchHit,
} from './types.js';

export type SearchQueryOpts = {
  q?: string;
  app_id?: string;
  artifact_type?: string;
  severity?: string;
  area?: string;
  status?: string;
  limit?: number;
  /** force engine */
  prefer?: 'opensearch' | 'fts';
};

function mapFacet(
  agg: { buckets?: Array<{ key: string; doc_count: number }> } | undefined,
): FacetBucket[] {
  return (agg?.buckets || []).map((b) => ({
    key: String(b.key),
    count: b.doc_count,
  }));
}

export async function multiSearch(
  db: Db,
  opts: SearchQueryOpts,
  http?: OsHttp,
): Promise<MultiSearchResult> {
  const cfg = getOpenSearchConfig();
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
  const prefer = opts.prefer || 'opensearch';

  if (cfg.enabled && prefer !== 'fts') {
    try {
      const client = http ?? createOsHttp(cfg.url);
      await ensureIndex(client, cfg.index);

      const filter: object[] = [];
      if (opts.app_id) filter.push({ term: { app_id: opts.app_id } });
      if (opts.artifact_type)
        filter.push({ term: { artifact_type: opts.artifact_type } });
      if (opts.severity) filter.push({ term: { severity: opts.severity } });
      if (opts.area) filter.push({ term: { area: opts.area } });
      if (opts.status) filter.push({ term: { status: opts.status } });

      const q = (opts.q || '').trim();
      const must: object[] = q
        ? [
            {
              multi_match: {
                query: q,
                fields: ['title^3', 'body_text', 'prompt_key^2'],
                type: 'best_fields',
                fuzziness: 'AUTO',
              },
            },
          ]
        : [{ match_all: {} }];

      const body = {
        size: limit,
        query: {
          bool: {
            must,
            filter,
          },
        },
        highlight: {
          fields: {
            title: {},
            body_text: {},
          },
          pre_tags: ['['],
          post_tags: [']'],
          fragment_size: 120,
        },
        aggs: {
          artifact_type: { terms: { field: 'artifact_type', size: 20 } },
          severity: { terms: { field: 'severity', size: 20 } },
          area: { terms: { field: 'area', size: 30 } },
          status: { terms: { field: 'status', size: 20 } },
        },
      };

      const res = await client('POST', `/${cfg.index}/_search`, body);
      if (res.status >= 300) {
        throw new Error(
          `search ${res.status}: ${res.text.slice(0, 200)}`,
        );
      }
      const j = res.json as {
        hits?: {
          total?: { value?: number } | number;
          hits?: Array<{
            _id: string;
            _score?: number;
            _source?: Record<string, unknown>;
            highlight?: Record<string, string[]>;
          }>;
        };
        aggregations?: Record<
          string,
          { buckets?: Array<{ key: string; doc_count: number }> }
        >;
      };
      const totalRaw = j.hits?.total;
      const total =
        typeof totalRaw === 'number'
          ? totalRaw
          : Number(totalRaw?.value ?? 0);
      const hits: SearchHit[] = (j.hits?.hits || []).map((h) => {
        const s = h._source || {};
        const hl =
          h.highlight?.body_text?.[0] ||
          h.highlight?.title?.[0] ||
          undefined;
        return {
          id: h._id,
          artifact_type: String(s.artifact_type ?? ''),
          app_id: String(s.app_id ?? ''),
          defect_id: (s.defect_id as string) ?? null,
          job_id: (s.job_id as string) ?? null,
          batch_id: (s.batch_id as string) ?? null,
          title: (s.title as string) ?? null,
          body_text: (s.body_text as string) ?? null,
          severity: (s.severity as string) ?? null,
          status: (s.status as string) ?? null,
          area: (s.area as string) ?? null,
          prompt_key: (s.prompt_key as string) ?? null,
          blob_uri: (s.blob_uri as string) ?? null,
          score: h._score,
          snippet: hl,
        };
      });
      return {
        mode: 'opensearch',
        hits,
        total,
        facets: {
          artifact_type: mapFacet(j.aggregations?.artifact_type),
          severity: mapFacet(j.aggregations?.severity),
          area: mapFacet(j.aggregations?.area),
          status: mapFacet(j.aggregations?.status),
        },
        opensearch: { url: cfg.url, index: cfg.index, ok: true },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // fall through to FTS
      const fb = searchDefects(db, {
        q: opts.q,
        app_id: opts.app_id,
        limit,
      });
      return {
        mode: fb.mode,
        hits: fb.hits.map((h) => ({
          id: h.id,
          artifact_type: 'defect_summary',
          app_id: h.app_id,
          defect_id: h.id,
          title: h.title,
          body_text: h.summary,
          severity: h.severity,
          status: h.status,
          area: h.area,
          snippet: h.snippet,
        })),
        total: fb.hits.length,
        opensearch: {
          url: cfg.url,
          index: cfg.index,
          ok: false,
          error: msg,
        },
      };
    }
  }

  // Phase A fallback
  const fb = searchDefects(db, {
    q: opts.q,
    app_id: opts.app_id,
    limit,
  });
  return {
    mode: cfg.enabled ? fb.mode : fb.mode === 'recent' ? 'recent' : fb.mode,
    hits: fb.hits.map((h) => ({
      id: h.id,
      artifact_type: 'defect_summary',
      app_id: h.app_id,
      defect_id: h.id,
      title: h.title,
      body_text: h.summary,
      severity: h.severity,
      status: h.status,
      area: h.area,
      snippet: h.snippet,
    })),
    total: fb.hits.length,
    opensearch: cfg.enabled
      ? { url: cfg.url, index: cfg.index, ok: false, error: 'not queried' }
      : undefined,
  };
}

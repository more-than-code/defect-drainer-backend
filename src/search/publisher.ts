/**
 * Fail-soft OpenSearch publisher + SQLite outbox.
 * SSOT writes never throw because of index failures.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from '../db.js';
import { nowIso } from '../db.js';
import {
  bulkIndexAt,
  createOsHttp,
  ensureIndex,
  getOpenSearchConfig,
  type OsHttp,
} from './opensearchClient.js';
import type { SearchDocument } from './types.js';

export type PublisherDeps = {
  db: Db;
  http?: OsHttp;
  /** Override config for tests */
  config?: ReturnType<typeof getOpenSearchConfig>;
};

function outboxId(): string {
  return `obx_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

function docToBody(doc: SearchDocument): Record<string, unknown> {
  const { _id, ...rest } = doc;
  return rest;
}

function enqueue(
  db: Db,
  docId: string,
  op: 'index' | 'delete',
  body: Record<string, unknown> | null,
  err?: string,
): void {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO search_outbox (id, doc_id, op, body_json, attempts, last_error, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    outboxId(),
    docId,
    op,
    body ? JSON.stringify(body) : null,
    1,
    err?.slice(0, 500) ?? null,
    ts,
    ts,
  );
}

/** Publish one or more docs; on failure enqueue outbox. Never throws. */
export async function publishDocuments(
  deps: PublisherDeps,
  docs: SearchDocument[],
): Promise<{ ok: boolean; error?: string; published: number }> {
  const cfg = deps.config ?? getOpenSearchConfig();
  if (!cfg.enabled || !docs.length) {
    return { ok: true, published: 0 };
  }
  try {
    const http = deps.http ?? createOsHttp(cfg.url);
    await ensureIndex(http, cfg.index);
    const bulk = await bulkIndexAt(
      cfg.url,
      cfg.index,
      docs.map((d) => ({ id: d._id, body: docToBody(d) })),
    );
    if (bulk.errors) {
      for (const d of docs) {
        enqueue(deps.db, d._id, 'index', docToBody(d), 'bulk item errors');
      }
      return { ok: false, error: 'bulk item errors', published: 0 };
    }
    return { ok: true, published: docs.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const d of docs) {
      try {
        enqueue(deps.db, d._id, 'index', docToBody(d), msg);
      } catch {
        /* ignore */
      }
    }
    return { ok: false, error: msg, published: 0 };
  }
}

/** Drain outbox (best effort). */
export async function flushSearchOutbox(
  deps: PublisherDeps,
  limit = 50,
): Promise<{ flushed: number; remaining: number }> {
  const cfg = deps.config ?? getOpenSearchConfig();
  if (!cfg.enabled) return { flushed: 0, remaining: 0 };

  const rows = deps.db
    .prepare(
      `SELECT id, doc_id, op, body_json, attempts FROM search_outbox
       ORDER BY updated_at ASC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    doc_id: string;
    op: string;
    body_json: string | null;
    attempts: number;
  }>;

  if (!rows.length) {
    const remaining = Number(
      (
        deps.db.prepare(`SELECT COUNT(*) AS c FROM search_outbox`).get() as {
          c: number;
        }
      ).c,
    );
    return { flushed: 0, remaining };
  }

  const toIndex = rows
    .filter((r) => r.op === 'index' && r.body_json)
    .map((r) => ({
      id: r.doc_id,
      body: JSON.parse(r.body_json!) as Record<string, unknown>,
      outboxId: r.id,
    }));

  let flushed = 0;
  try {
    const http = deps.http ?? createOsHttp(cfg.url);
    await ensureIndex(http, cfg.index);
    if (toIndex.length) {
      const bulk = await bulkIndexAt(
        cfg.url,
        cfg.index,
        toIndex.map((t) => ({ id: t.id, body: t.body })),
      );
      if (!bulk.errors) {
        for (const t of toIndex) {
          deps.db.prepare(`DELETE FROM search_outbox WHERE id = ?`).run(t.outboxId);
          flushed += 1;
        }
      } else {
        for (const t of toIndex) {
          deps.db
            .prepare(
              `UPDATE search_outbox SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
            )
            .run('bulk errors', nowIso(), t.outboxId);
        }
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const r of rows) {
      deps.db
        .prepare(
          `UPDATE search_outbox SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(msg.slice(0, 500), nowIso(), r.id);
    }
  }

  const remaining = Number(
    (
      deps.db.prepare(`SELECT COUNT(*) AS c FROM search_outbox`).get() as {
        c: number;
      }
    ).c,
  );
  return { flushed, remaining };
}

/** Fire-and-forget publish (logs errors to outbox only). */
export function publishDocumentsBackground(
  deps: PublisherDeps,
  docs: SearchDocument[],
): void {
  void publishDocuments(deps, docs).then(() => flushSearchOutbox(deps, 20));
}

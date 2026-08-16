import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { openDatabase } from '../src/db.js';
import { allDocsForDefect } from '../src/search/documents.js';
import {
  bulkIndexAt,
  createOsHttp,
  ensureIndex,
  getOpenSearchConfig,
} from '../src/search/opensearchClient.js';
import { publishDocuments } from '../src/search/publisher.js';
import { multiSearch } from '../src/search/query.js';
import type { DefectRecord } from '../src/store.js';

describe('Phase B OpenSearch (unit)', () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'os-unit-'));
  after(() => rmSync(dataRoot, { recursive: true, force: true }));

  it('builds multi-artifact docs for a defect', () => {
    const d: DefectRecord = {
      id: 'DEF-20260809-phaseb-test-x1y2',
      app_id: 'app_test',
      title: 'Login fails',
      severity: 'P1',
      status: 'open',
      area: 'auth',
      client: 'ios',
      surface: 'login',
      repos: [],
      labels: ['mobile'],
      related: [],
      source: 'web-ui',
      key_files: [],
      evidence: ['evidence/DEF-20260809-phaseb-test-x1y2/01.png'],
      fix_evidence: [],
      reported: '2026-08-09',
      summary: 'button no-op',
      body: 'details',
      bucket: 'open',
      path: 'open/x.md',
    };
    const docs = allDocsForDefect(d);
    assert.ok(docs.some((x) => x.artifact_type === 'defect_summary'));
    assert.ok(docs.some((x) => x.artifact_type === 'screenshot'));
    assert.equal(docs.find((x) => x.artifact_type === 'screenshot')?.blob_uri, d.evidence[0]);
  });

  it('enqueues outbox when OpenSearch URL is bad', async () => {
    const db = openDatabase(dataRoot);
    const prev = process.env.DEFECT_DRAINER_OPENSEARCH_URL;
    process.env.DEFECT_DRAINER_OPENSEARCH_URL = 'http://127.0.0.1:1';
    try {
      const r = await publishDocuments(
        {
          db,
          config: {
            url: 'http://127.0.0.1:1',
            index: 'test-idx',
            enabled: true,
          },
        },
        [
          {
            _id: 'defect_summary:DEF-x',
            artifact_type: 'defect_summary',
            app_id: 'app_x',
            title: 't',
            body_text: 'b',
          },
        ],
      );
      assert.equal(r.ok, false);
      const n = Number(
        (db.prepare(`SELECT COUNT(*) AS c FROM search_outbox`).get() as { c: number })
          .c,
      );
      assert.ok(n >= 1);
    } finally {
      if (prev === undefined) delete process.env.DEFECT_DRAINER_OPENSEARCH_URL;
      else process.env.DEFECT_DRAINER_OPENSEARCH_URL = prev;
    }
  });

  it('multiSearch falls back to FTS when OS disabled', async () => {
    const db = openDatabase(path.join(dataRoot, 'fts-fb'));
    const prev = process.env.DEFECT_DRAINER_OPENSEARCH_URL;
    delete process.env.DEFECT_DRAINER_OPENSEARCH_URL;
    try {
      const r = await multiSearch(db, { q: 'login', limit: 5 });
      assert.ok(r.mode === 'fts' || r.mode === 'like' || r.mode === 'recent');
    } finally {
      if (prev !== undefined) process.env.DEFECT_DRAINER_OPENSEARCH_URL = prev;
    }
  });
});

describe('Phase B OpenSearch (integration, optional)', () => {
  it('indexes and searches when OPENSEARCH_URL is live', async () => {
    const url = process.env.DEFECT_DRAINER_OPENSEARCH_URL;
    if (!url) {
      // skip without failing CI
      return;
    }
    const http = createOsHttp(url.replace(/\/+$/, ''));
    const index = 'defect-drainer-test-artifacts';
    await ensureIndex(http, index);
    const id = `defect_summary:test-${Date.now()}`;
    await bulkIndexAt(url.replace(/\/+$/, ''), index, [
      {
        id,
        body: {
          artifact_type: 'defect_summary',
          app_id: 'app_test',
          title: 'UniquePhaseBLoginZed',
          body_text: 'phase b integration search token',
          severity: 'P1',
          status: 'open',
          area: 'auth',
        },
      },
    ]);
    // refresh
    await http('POST', `/${index}/_refresh`);
    const res = await http('POST', `/${index}/_search`, {
      query: { match: { title: 'UniquePhaseBLoginZed' } },
    });
    assert.ok(res.status < 300);
    const hits = (res.json as { hits?: { hits?: unknown[] } })?.hits?.hits || [];
    assert.ok(hits.length >= 1);
  });
});

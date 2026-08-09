import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ensureSeededApps, SEEDED_TUTORED_WEBAPP_APP_ID } from '../src/apps.js';
import { openDatabase } from '../src/db.js';
import {
  parseMarkdownWithFrontmatter,
  serializeMarkdown,
} from '../src/frontmatter.js';
import {
  DefectStore,
  isSafeId,
  makeDefectId,
} from '../src/store.js';

describe('frontmatter', () => {
  it('round-trips arrays and scalars', () => {
    const md = serializeMarkdown(
      {
        id: 'DEF-20260808-test-abcd',
        title: 'Broken button',
        severity: 'P1',
        status: 'open',
        repos: ['ttd-webapp', 'ttd-backend'],
        labels: [],
        summary: 'Click does nothing',
      },
      '## Actual\n\nnada\n',
    );
    const { frontmatter, body } = parseMarkdownWithFrontmatter(md);
    assert.equal(frontmatter.id, 'DEF-20260808-test-abcd');
    assert.deepEqual(frontmatter.repos, ['ttd-webapp', 'ttd-backend']);
    assert.match(body, /## Actual/);
  });
});

describe('DefectStore (sqlite)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'defects-'));
  const data = mkdtempSync(path.join(tmpdir(), 'defects-data-'));
  const db = openDatabase(data);
  ensureSeededApps(db);
  const store = new DefectStore(db, root);
  after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });

  it('validates ids', () => {
    assert.equal(isSafeId('DEF-20260808-foo-ab12'), true);
    assert.equal(isSafeId('../etc'), false);
  });

  it('creates ids', () => {
    const id = makeDefectId('Chat cards missing');
    assert.match(id, /^DEF-\d{8}-chat-cards-missing-[a-z0-9]+$/);
  });

  it('CRUD + resolve moves bucket', () => {
    const id = 'DEF-20260808-crud-test01';
    store.write({
      id,
      title: 'CRUD test',
      app_id: SEEDED_TUTORED_WEBAPP_APP_ID,
      severity: 'P2',
      status: 'open',
      area: 'webapp',
      client: 'web',
      surface: '/chat',
      repos: ['ttd-webapp'],
      labels: ['ui'],
      related: [],
      source: 'test',
      key_files: [],
      evidence: [],
      fix_evidence: [],
      reported: '2026-08-08',
      summary: 'summary',
      body: '## Notes\n\nok\n',
      bucket: 'open',
    });
    const got = store.get(id);
    assert.ok(got);
    assert.equal(got.bucket, 'open');
    assert.equal(got.title, 'CRUD test');

    store.update(id, { title: 'CRUD test updated' });
    assert.equal(store.get(id)?.title, 'CRUD test updated');

    assert.throws(
      () => store.resolve(id, { resolution: 'fixed in test' }),
      /fix_evidence/,
    );
    store.resolve(id, {
      resolution: 'fixed in test',
      fix_evidence: [`evidence/${id}/fix-01.png`],
    });
    const resolved = store.get(id);
    assert.equal(resolved?.bucket, 'resolved');
    assert.equal(resolved?.status, 'resolved');
    assert.equal(resolved?.fix_evidence?.length, 1);

    store.reopen(id);
    assert.equal(store.get(id)?.bucket, 'open');

    assert.equal(store.delete(id), true);
    assert.equal(store.get(id), null);
  });

  it('saves evidence safely', () => {
    const id = 'DEF-20260808-ev-test0001';
    const paths = store.saveEvidence(id, [
      { filename: 'shot.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    assert.deepEqual(paths, [`evidence/${id}/01.png`]);
    assert.ok(store.evidenceAbs(paths[0]!));
    assert.equal(store.evidenceAbs('../../etc/passwd'), null);
  });
});

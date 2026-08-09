import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  getAnalyticsSummary,
  recordPromptUse,
  searchDefects,
  setPromptUseOutcomeForJob,
  upsertJobSummary,
} from '../src/analytics.js';
import { SEEDED_TUTORED_WEBAPP_APP_ID } from '../src/apps.js';
import { buildApp } from '../src/server.js';

describe('Phase A analytics', () => {
  const defectsRoot = mkdtempSync(path.join(tmpdir(), 'defects-an-'));
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'defects-an-data-'));
  let built: Awaited<ReturnType<typeof buildApp>>;

  after(async () => {
    await built?.app.close();
    rmSync(defectsRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('aggregates defects, prompts, jobs and FTS search', async () => {
    process.env.DEFECT_DRAINER_NORMALIZE_LOCAL = '1';
    built = await buildApp({
      defectsRoot,
      dataRoot,
      skipMigrate: true,
    });
    const { app, db, store } = built;
    const appId = SEEDED_TUTORED_WEBAPP_APP_ID;

    // Defects with dimensions
    store.write({
      id: 'DEF-20260809-analytics-login-fail-a1b2',
      app_id: appId,
      title: 'Login button no-op on iOS',
      severity: 'P1',
      status: 'open',
      area: 'auth',
      client: 'ios',
      surface: 'login',
      repos: ['webapp'],
      labels: [],
      related: [],
      source: 'web-ui',
      key_files: [],
      evidence: [],
      fix_evidence: [],
      reported: '2026-08-09',
      summary: 'Tapping login does nothing',
      body: 'Expected navigate home. Actual no-op.',
      bucket: 'open',
    });
    store.write({
      id: 'DEF-20260809-analytics-paywall-c3d4',
      app_id: appId,
      title: 'Paywall flashes blank',
      severity: 'P2',
      status: 'open',
      area: 'billing',
      client: 'web',
      surface: 'paywall',
      repos: ['webapp'],
      labels: [],
      related: [],
      source: 'api',
      key_files: [],
      evidence: [],
      fix_evidence: [],
      reported: '2026-08-09',
      summary: 'Flash of empty paywall',
      body: 'Billing surface blank',
      bucket: 'open',
    });

    recordPromptUse(db, {
      prompt_key: 'batch_fix.v1',
      app_id: appId,
      job_id: 'bjob_test1',
      defect_ids: ['DEF-20260809-analytics-login-fail-a1b2'],
      outcome: 'unknown',
      runner: 'coding_agent',
      body_text: 'Fix login',
    });
    setPromptUseOutcomeForJob(db, 'bjob_test1', 'success');
    recordPromptUse(db, {
      prompt_key: 'batch_fix.v1',
      app_id: appId,
      job_id: 'bjob_test2',
      outcome: 'fail',
      runner: 'coding_agent',
    });
    recordPromptUse(db, {
      prompt_key: 'batch_fix.manual.v1',
      app_id: appId,
      outcome: 'success',
      runner: 'manual',
    });

    upsertJobSummary(db, {
      job_id: 'bjob_test1',
      batch_id: 'BATCH-1',
      app_id: appId,
      status: 'completed',
      mode: 'grok',
      defect_ids: ['DEF-20260809-analytics-login-fail-a1b2'],
      prs: [{ status: 'created', ghState: 'merged' }],
      created_at: '2026-08-09T00:00:00.000Z',
      updated_at: '2026-08-09T01:00:00.000Z',
    });
    upsertJobSummary(db, {
      job_id: 'bjob_test2',
      batch_id: 'BATCH-2',
      app_id: appId,
      status: 'failed',
      mode: 'grok',
      defect_ids: [],
      created_at: '2026-08-09T00:00:00.000Z',
      updated_at: '2026-08-09T01:00:00.000Z',
    });

    const summary = getAnalyticsSummary(db, { app_id: appId });
    assert.ok(summary.defects.total >= 2);
    assert.ok(summary.defects.by_severity.some((r) => r.key === 'P1'));
    assert.ok(summary.defects.by_area.some((r) => r.key === 'auth'));
    assert.equal(summary.prompts.total, 3);
    const batchFix = summary.prompts.top.find((p) => p.prompt_key === 'batch_fix.v1');
    assert.ok(batchFix);
    assert.equal(batchFix!.uses, 2);
    assert.equal(batchFix!.success, 1);
    assert.equal(batchFix!.fail, 1);
    assert.equal(summary.jobs.total, 2);
    assert.equal(summary.jobs.completed, 1);
    assert.equal(summary.jobs.failed, 1);
    assert.equal(summary.jobs.success_rate, 0.5);
    assert.equal(summary.jobs.pr_merged_total, 1);

    const fts = searchDefects(db, { q: 'login', app_id: appId });
    assert.ok(fts.hits.length >= 1);
    assert.ok(fts.hits.some((h) => h.id.includes('login')));
    assert.ok(fts.mode === 'fts' || fts.mode === 'like');

    const apiAn = await app.inject({
      method: 'GET',
      url: `/api/analytics?app_id=${encodeURIComponent(appId)}`,
    });
    assert.equal(apiAn.statusCode, 200);
    assert.equal(apiAn.json().analytics.prompts.total, 3);

    const apiSearch = await app.inject({
      method: 'GET',
      url: `/api/search?q=paywall&app_id=${encodeURIComponent(appId)}`,
    });
    assert.equal(apiSearch.statusCode, 200);
    assert.ok(apiSearch.json().hits.length >= 1);
  });
});

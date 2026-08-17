import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { SEEDED_TUTORED_WEBAPP_APP_ID } from '../src/apps.js';
import { buildApp } from '../src/server.js';

describe('defect-drainer API', () => {
  const defectsRoot = mkdtempSync(path.join(tmpdir(), 'defects-api-'));
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'defects-data-'));
  let app: Awaited<ReturnType<typeof buildApp>>['app'];

  after(async () => {
    await app?.close();
    rmSync(defectsRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('health + local intake + list + patch + resolve', async () => {
    process.env.DEFECT_DRAINER_NORMALIZE_LOCAL = '1';
    const built = await buildApp({
      defectsRoot,
      dataRoot,
      skipMigrate: true,
    });
    app = built.app;

    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().ok, true);

    const apps = await app.inject({ method: 'GET', url: '/api/apps' });
    assert.equal(apps.statusCode, 200);
    assert.equal(apps.json().defaultAppId, SEEDED_TUTORED_WEBAPP_APP_ID);
    assert.ok(
      apps.json().apps.some((a: { id: string }) => a.id === SEEDED_TUTORED_WEBAPP_APP_ID),
    );
    assert.match(SEEDED_TUTORED_WEBAPP_APP_ID, /^app_[a-f0-9]{16}$/);

    // Settings: named repo URLs (name + url pairs)
    const patchApp = await app.inject({
      method: 'PATCH',
      url: `/api/apps/${SEEDED_TUTORED_WEBAPP_APP_ID}`,
      payload: {
        name: 'Tutored',
        repo_entries: [
          {
            name: 'webapp',
            url: 'https://github.com/example/ttd-webapp.git',
          },
          {
            name: 'backend',
            url: 'https://github.com/example/ttd-backend.git',
          },
        ],
      },
    });
    assert.equal(patchApp.statusCode, 200);
    assert.deepEqual(patchApp.json().app.repos, ['webapp', 'backend']);
    assert.equal(patchApp.json().app.repo_entries?.length, 2);
    assert.equal(patchApp.json().app.repo_entries[0].name, 'webapp');
    assert.equal(
      patchApp.json().app.repo_entries[0].url,
      'https://github.com/example/ttd-webapp.git',
    );
    assert.equal(patchApp.json().app.repo_entries[0].base_source, 'origin');
    assert.equal(patchApp.json().app.id, SEEDED_TUTORED_WEBAPP_APP_ID);
    // default sandbox is strict (restrict)
    assert.equal(patchApp.json().app.grok_sandbox, 'strict');

    const patchPerRepo = await app.inject({
      method: 'PATCH',
      url: `/api/apps/${SEEDED_TUTORED_WEBAPP_APP_ID}`,
      payload: {
        repo_entries: [
          {
            name: 'webapp',
            url: 'https://github.com/example/ttd-webapp.git',
            base_source: 'origin',
            base_branch: 'dev',
          },
          {
            name: 'mobile',
            url: '/Users/joe/workspace/tutored/ttd-mobileapp',
            base_source: 'local',
            base_branch: 'dev',
          },
        ],
      },
    });
    assert.equal(patchPerRepo.statusCode, 200);
    const entries = patchPerRepo.json().app.repo_entries;
    assert.equal(entries[0].base_source, 'origin');
    assert.equal(entries[0].base_branch, 'dev');
    assert.equal(entries[1].base_source, 'local');
    assert.equal(entries[1].url, '/Users/joe/workspace/tutored/ttd-mobileapp');

    const branchesBad = await app.inject({
      method: 'POST',
      url: '/api/git/branches',
      payload: { source: 'local', location: '' },
    });
    assert.equal(branchesBad.statusCode, 400);

    const patchSandbox = await app.inject({
      method: 'PATCH',
      url: `/api/apps/${SEEDED_TUTORED_WEBAPP_APP_ID}`,
      payload: { grok_sandbox: 'workspace' },
    });
    assert.equal(patchSandbox.statusCode, 200);
    assert.equal(patchSandbox.json().app.grok_sandbox, 'workspace');

    const patchRestrict = await app.inject({
      method: 'PATCH',
      url: `/api/apps/${SEEDED_TUTORED_WEBAPP_APP_ID}`,
      payload: { grok_sandbox: 'restrict' },
    });
    assert.equal(patchRestrict.statusCode, 200);
    assert.equal(patchRestrict.json().app.grok_sandbox, 'strict');

    const created = await app.inject({
      method: 'POST',
      url: '/api/apps',
      payload: {
        name: 'Extra App',
        repos: ['svc-a', 'svc-b'],
        repo_url: 'https://github.com/example/svc-a.git',
      },
    });
    assert.equal(created.statusCode, 201);
    assert.match(created.json().app.id, /^app_[a-f0-9]{16}$/);
    assert.equal(created.json().app.name, 'Extra App');
    assert.ok(created.json().app.repos.includes('svc-a'));

    const delExtra = await app.inject({
      method: 'DELETE',
      url: `/api/apps/${created.json().app.id}`,
    });
    assert.equal(delExtra.statusCode, 200);
    assert.equal(delExtra.json().ok, true);

    const intake = await app.inject({
      method: 'POST',
      url: '/api/intake/json',
      payload: {
        comment: 'Submit button does nothing on practice hub',
        severity: 'P1',
        client: 'web',
        surface: 'practice hub',
        app_id: SEEDED_TUTORED_WEBAPP_APP_ID,
        repos: ['webapp'],
        reporter: 'parity-harness',
        mode: 'local',
      },
    });
    assert.equal(intake.statusCode, 202);
    const job = intake.json().job;
    assert.equal(job.status, 'completed');
    assert.equal(job.app_id, SEEDED_TUTORED_WEBAPP_APP_ID);
    assert.deepEqual(job.repos, ['webapp']);
    assert.ok(job.defectId.startsWith('DEF-'));

    // wait a tick if race (run is awaited inside enqueue for local)
    const list = await app.inject({
      method: 'GET',
      url: `/api/defects?bucket=open&app_id=${SEEDED_TUTORED_WEBAPP_APP_ID}`,
    });
    assert.equal(list.statusCode, 200);
    const defects = list.json().defects;
    assert.ok(defects.length >= 1);
    const id = job.defectId;
    assert.ok(defects.some((d: { id: string }) => d.id === id));

    const one = await app.inject({ method: 'GET', url: `/api/defects/${id}` });
    assert.equal(one.statusCode, 200);
    assert.match(one.json().defect.summary, /Submit button/i);
    assert.equal(one.json().defect.app_id, SEEDED_TUTORED_WEBAPP_APP_ID);
    assert.deepEqual(one.json().defect.repos, ['webapp']);
    // reporter supplied at intake survives normalize → SSOT → API
    assert.equal(one.json().defect.reporter, 'parity-harness');

    // omitting reporter is valid and yields '' (not an error, not undefined)
    const anon = await app.inject({
      method: 'POST',
      url: '/api/intake/json',
      payload: {
        comment: 'Anonymous intake without a reporter',
        app_id: SEEDED_TUTORED_WEBAPP_APP_ID,
        mode: 'local',
      },
    });
    assert.equal(anon.statusCode, 202);
    const anonOne = await app.inject({
      method: 'GET',
      url: `/api/defects/${anon.json().job.defectId}`,
    });
    assert.equal(anonOne.statusCode, 200);
    assert.equal(anonOne.json().defect.reporter, '');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/defects/${id}`,
      payload: { title: 'Practice hub submit is dead' },
    });
    assert.equal(patch.statusCode, 200);
    assert.equal(patch.json().defect.title, 'Practice hub submit is dead');

    // planned only — worktree setup needs real product git checkouts
    const batch = await app.inject({
      method: 'POST',
      url: '/api/batches',
      payload: {
        app_id: SEEDED_TUTORED_WEBAPP_APP_ID,
        defect_ids: [id],
        goal: 'test batch',
        mode: 'manual',
        start_fix: false,
      },
    });
    assert.equal(batch.statusCode, 201);
    assert.ok(batch.json().batch.id.startsWith('BATCH-'));
    assert.equal(batch.json().job.mode, 'manual');

    const batches = await app.inject({ method: 'GET', url: '/api/batches' });
    assert.equal(batches.statusCode, 200);
    assert.ok(batches.json().batches.some((b: { id: string }) => b.id === batch.json().batch.id));

    const jobId = batch.json().job.jobId as string;
    const jobGet = await app.inject({
      method: 'GET',
      url: `/api/batch-jobs/${jobId}`,
    });
    assert.equal(jobGet.statusCode, 200);
    assert.ok(Array.isArray(jobGet.json().job.log));
    assert.ok(jobGet.json().job.log.length >= 1);

    // stop only allowed while running/queued
    const stopManual = await app.inject({
      method: 'POST',
      url: `/api/batch-jobs/${jobId}/stop`,
    });
    assert.equal(stopManual.statusCode, 400);

    // re-run only for grok jobs with worktrees
    const rerunManual = await app.inject({
      method: 'POST',
      url: `/api/batch-jobs/${jobId}/rerun`,
    });
    assert.equal(rerunManual.statusCode, 400);

    // batch manifest status tracks lifecycle (manual planned/manual → still readable)
    const batchGet = await app.inject({
      method: 'GET',
      url: `/api/batches/${batch.json().batch.id}`,
    });
    assert.equal(batchGet.statusCode, 200);
    assert.ok(batchGet.json().batch.status);

    // create-prs without worktrees fails
    const noPr = await app.inject({
      method: 'POST',
      url: `/api/batch-jobs/${jobId}/create-prs`,
    });
    assert.equal(noPr.statusCode, 400);

    // refresh-prs without PRs fails
    const noRefresh = await app.inject({
      method: 'POST',
      url: `/api/batch-jobs/${jobId}/refresh-prs`,
    });
    assert.equal(noRefresh.statusCode, 400);

    // delete job removes it from list
    const delJob = await app.inject({
      method: 'DELETE',
      url: `/api/batch-jobs/${jobId}`,
    });
    assert.equal(delJob.statusCode, 200);
    assert.equal(delJob.json().ok, true);
    const gone = await app.inject({
      method: 'GET',
      url: `/api/batch-jobs/${jobId}`,
    });
    assert.equal(gone.statusCode, 404);

    // fix-backed-by-evidence: resolve without proof rejected
    const resolveNo = await app.inject({
      method: 'POST',
      url: `/api/defects/${id}/resolve`,
      payload: { resolution: 'test resolve' },
    });
    assert.equal(resolveNo.statusCode, 400);
    assert.match(String(resolveNo.json().error), /fix_evidence/i);

    const resolve = await app.inject({
      method: 'POST',
      url: `/api/defects/${id}/resolve`,
      payload: {
        resolution: 'test resolve',
        fix_evidence: [`evidence/${id}/fix-01.png`],
      },
    });
    assert.equal(resolve.statusCode, 200);
    assert.equal(resolve.json().defect.bucket, 'resolved');
    assert.equal(resolve.json().defect.fix_evidence.length, 1);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/defects/${id}?evidence=1`,
    });
    assert.equal(del.statusCode, 200);
  });
});

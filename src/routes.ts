import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import {
  canonicalizeAppId,
  createApp,
  deleteApp,
  getApp,
  getDefaultAppId,
  listApps,
  parseBaseSource,
  updateAppSettings,
} from './apps.js';
import { getAnalyticsSummary } from './analytics.js';
import type { Db } from './db.js';
import type { BatchJobRunner } from './jobs/batchJob.js';
import { collectHunks } from './jobs/diffHygiene.js';
import {
  resolveNormalizeMode,
  type NormalizeJobRunner,
} from './jobs/normalizeJob.js';
import { evidenceDir } from './paths.js';
import { getOpenSearchConfig, ping, createOsHttp } from './search/opensearchClient.js';
import { flushSearchOutbox } from './search/publisher.js';
import { multiSearch } from './search/query.js';
import { reindexAll } from './search/reindex.js';
import type { DefectStore } from './store.js';
import { isSafeId } from './store.js';
import { chooseLocalFolder, listRepoBranches } from './worktrees.js';

export type RouteDeps = {
  store: DefectStore;
  jobs: NormalizeJobRunner;
  batches: BatchJobRunner;
  defectsRoot: string;
  db: Db;
};

export async function registerRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  const { store, jobs, batches, db } = deps;

  app.get('/health', async () => {
    const open = store.list({ bucket: 'open' }).length;
    const resolved = store.list({ bucket: 'resolved' }).length;
    return {
      ok: true,
      service: 'defect-drainer',
      open,
      resolved,
      defaultAppId: getDefaultAppId(db),
      normalizeMode: resolveNormalizeMode(),
      ssot: 'sqlite',
      analytics: 'phase-a',
      search: getOpenSearchConfig().enabled ? 'phase-b' : 'phase-a',
    };
  });

  /**
   * Phase A analytics — SQL aggregates (defect mix, prompt_use, job success).
   * Query: app_id? (optional filter)
   */
  app.get<{ Querystring: { app_id?: string } }>(
    '/api/analytics',
    async (req) => {
      const app_id = req.query.app_id?.trim() || undefined;
      return { analytics: getAnalyticsSummary(db, { app_id }) };
    },
  );

  /**
   * Multi-artifact search — OpenSearch when configured, else Phase A FTS.
   * Query: q?, app_id?, artifact_type?, severity?, area?, status?, limit?, prefer?
   */
  app.get<{
    Querystring: {
      q?: string;
      app_id?: string;
      artifact_type?: string;
      severity?: string;
      area?: string;
      status?: string;
      limit?: string;
      prefer?: string;
    };
  }>('/api/search', async (req) => {
    const limit = req.query.limit ? Number(req.query.limit) : 40;
    const prefer =
      req.query.prefer === 'fts' || req.query.prefer === 'opensearch'
        ? req.query.prefer
        : undefined;
    const result = await multiSearch(db, {
      q: req.query.q,
      app_id: req.query.app_id?.trim() || undefined,
      artifact_type: req.query.artifact_type?.trim() || undefined,
      severity: req.query.severity?.trim() || undefined,
      area: req.query.area?.trim() || undefined,
      status: req.query.status?.trim() || undefined,
      limit: Number.isFinite(limit) ? limit : 40,
      prefer,
    });
    return result;
  });

  /** OpenSearch status + outbox depth */
  app.get('/api/search/status', async () => {
    const cfg = getOpenSearchConfig();
    let reachable = false;
    if (cfg.enabled) {
      reachable = await ping(createOsHttp(cfg.url));
    }
    const outbox = Number(
      (
        db.prepare(`SELECT COUNT(*) AS c FROM search_outbox`).get() as {
          c: number;
        }
      ).c,
    );
    return {
      enabled: cfg.enabled,
      url: cfg.url || null,
      index: cfg.index,
      reachable,
      outbox,
    };
  });

  /** Flush fail-soft outbox (best effort). */
  app.post('/api/search/flush', async () => {
    const r = await flushSearchOutbox({ db });
    return r;
  });

  /** Full reindex from SQLite → OpenSearch (operator / dev). */
  app.post('/api/search/reindex', async (req, reply) => {
    const cfg = getOpenSearchConfig();
    if (!cfg.enabled) {
      return reply
        .code(400)
        .send({ error: 'OpenSearch disabled (set DEFECT_DRAINER_OPENSEARCH_URL)' });
    }
    const r = await reindexAll(db, store);
    return r;
  });

  app.get('/api/apps', async () => {
    return {
      apps: listApps(db),
      defaultAppId: getDefaultAppId(db),
    };
  });

  /**
   * Create app (onboarding). Generates platform hash id.
   * Body: { name, description?, repos?, repo_entries?, repo_url?, repo_urls?, grok_sandbox?, agent_toolchain?, default? }
   */
  app.post<{
    Body: {
      name?: string;
      description?: string;
      workspace_root?: string;
      repos?: string[];
      repo_entries?: Array<{
        name?: string;
        url?: string;
        base_source?: string;
        base_branch?: string;
      } | string>;
      repo_url?: string;
      repo_urls?: string[];
      grok_sandbox?: string;
      agent_toolchain?: string;
      allow_simulator_writes?: boolean;
      verify_commands?: Array<{ repo?: string; command?: string }>;
      base_remote?: string;
      base_branch?: string;
      default?: boolean;
    };
  }>('/api/apps', async (req, reply) => {
    try {
      const b = req.body ?? {};
      const app = createApp(db, {
        name: b.name ?? '',
        description: b.description,
        workspace_root: b.workspace_root,
        repos: b.repos,
        repo_entries: b.repo_entries,
        repo_url: b.repo_url,
        repo_urls: b.repo_urls,
        grok_sandbox: b.grok_sandbox,
        agent_toolchain: b.agent_toolchain,
        allow_simulator_writes: b.allow_simulator_writes,
        verify_commands: b.verify_commands,
        base_remote: b.base_remote,
        base_branch: b.base_branch,
        default: b.default,
      });
      return reply.code(201).send({ app });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  app.get<{ Params: { id: string } }>('/api/apps/:id', async (req, reply) => {
    const app = getApp(db, req.params.id);
    if (!app) return reply.code(404).send({ error: 'not found' });
    return { app };
  });

  /**
   * Update app settings (Settings UI): name, named repo URLs, etc.
   */
  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      workspace_root?: string;
      repos?: string[];
      repo_entries?: Array<{
        name?: string;
        url?: string;
        base_source?: string;
        base_branch?: string;
      } | string> | null;
      repo_url?: string | null;
      repo_urls?: string[] | null;
      grok_sandbox?: string;
      agent_toolchain?: string;
      allow_simulator_writes?: boolean;
      verify_commands?: Array<{ repo?: string; command?: string }>;
      base_remote?: string;
      base_branch?: string;
      default?: boolean;
    };
  }>('/api/apps/:id', async (req, reply) => {
    try {
      const app = updateAppSettings(db, req.params.id, req.body ?? {});
      return { app };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('unknown')) return reply.code(404).send({ error: msg });
      return reply.code(400).send({ error: msg });
    }
  });

  /**
   * List branches on a GitHub remote or a local checkout for the Settings dropdown.
   * Body: { source: 'origin' | 'local', location: url-or-absolute-path }
   */
  app.post<{
    Body: { source?: string; location?: string };
  }>('/api/git/branches', async (req, reply) => {
    try {
      const source = parseBaseSource(req.body?.source);
      const location = String(req.body?.location ?? '').trim();
      return listRepoBranches({ source, location });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  /**
   * Open Finder (macOS) so the operator can pick a local checkout.
   * Blocks until choose/cancel. Returns { path } or { cancelled: true }.
   */
  app.post('/api/git/choose-folder', async (_req, reply) => {
    try {
      const result = chooseLocalFolder();
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/api/apps/:id',
    async (req, reply) => {
      try {
        deleteApp(db, req.params.id);
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('unknown')) return reply.code(404).send({ error: msg });
        return reply.code(400).send({ error: msg });
      }
    },
  );

  app.get('/api/defects', async (req) => {
    const q = req.query as { status?: string; bucket?: string; app_id?: string };
    const bucket =
      q.bucket === 'open' || q.bucket === 'resolved' || q.bucket === 'all'
        ? q.bucket
        : 'open';
    const list = store.list({
      status: q.status,
      bucket: bucket === 'all' ? 'all' : bucket,
      app_id: q.app_id?.trim() || undefined,
    });
    return { defects: list };
  });

  app.get<{ Params: { id: string } }>('/api/defects/:id', async (req, reply) => {
    const rec = store.get(req.params.id);
    if (!rec) return reply.code(404).send({ error: 'not found' });
    return { defect: rec };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/defects/:id',
    async (req, reply) => {
      if (!isSafeId(req.params.id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const body = req.body ?? {};
      try {
        const defect = store.update(req.params.id, {
          title: str(body.title),
          app_id: str(body.app_id),
          severity: str(body.severity),
          status: str(body.status),
          area: str(body.area),
          client: str(body.client),
          surface: str(body.surface),
          repos: strArr(body.repos),
          labels: strArr(body.labels),
          related: strArr(body.related),
          source: str(body.source),
          key_files: strArr(body.key_files),
          evidence: strArr(body.evidence),
          fix_evidence: strArr(body.fix_evidence),
          summary: str(body.summary),
          body: str(body.body),
          resolution: str(body.resolution),
          resolved_date: str(body.resolved_date),
          duplicate_of: str(body.duplicate_of),
        });
        return { defect };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) return reply.code(404).send({ error: msg });
        return reply.code(400).send({ error: msg });
      }
    },
  );

  /**
   * Upload post-fix proof images (fix-backed-by-evidence).
   * multipart: files → evidence/<id>/fix-NN.ext; merges into fix_evidence.
   */
  app.post<{ Params: { id: string } }>(
    '/api/defects/:id/fix-evidence',
    async (req, reply) => {
      if (!isSafeId(req.params.id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      try {
        const parts = req.parts();
        const files: Array<{ filename: string; data: Buffer }> = [];
        for await (const part of parts) {
          if (part.type === 'file') {
            const buf = await part.toBuffer();
            if (buf.length > 0) {
              files.push({ filename: part.filename || 'fix.png', data: buf });
            }
          }
        }
        if (!files.length) {
          return reply.code(400).send({ error: 'at least one fix evidence file required' });
        }
        const defect = store.addFixEvidence(req.params.id, files);
        return { defect };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) return reply.code(404).send({ error: msg });
        return reply.code(400).send({ error: msg });
      }
    },
  );

  /**
   * Resolve defect. Requires fix_evidence (upload via /fix-evidence first, or
   * multipart files on this request, or JSON fix_evidence paths).
   * JSON: { resolution?, fix_evidence?: string[] }
   * multipart: resolution?, files (images)
   */
  app.post<{ Params: { id: string } }>(
    '/api/defects/:id/resolve',
    async (req, reply) => {
      if (!isSafeId(req.params.id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      try {
        const ct = String(req.headers['content-type'] || '');
        let resolution: string | undefined;
        let fix_evidence: string[] | undefined;

        if (ct.includes('multipart/form-data')) {
          const parts = req.parts();
          const files: Array<{ filename: string; data: Buffer }> = [];
          for await (const part of parts) {
            if (part.type === 'file') {
              const buf = await part.toBuffer();
              if (buf.length > 0) {
                files.push({ filename: part.filename || 'fix.png', data: buf });
              }
            } else if (part.fieldname === 'resolution') {
              resolution = String(part.value ?? '');
            }
          }
          if (files.length) {
            const updated = store.addFixEvidence(req.params.id, files);
            fix_evidence = updated.fix_evidence;
          }
        } else {
          const body = (req.body ?? {}) as {
            resolution?: string;
            fix_evidence?: string[];
          };
          resolution = body.resolution;
          fix_evidence = body.fix_evidence;
        }

        const defect = store.resolve(req.params.id, {
          resolution,
          fix_evidence,
        });
        return { defect };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) return reply.code(404).send({ error: msg });
        return reply.code(400).send({ error: msg });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/defects/:id/reopen',
    async (req, reply) => {
      try {
        const defect = store.reopen(req.params.id);
        return { defect };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(404).send({ error: msg });
      }
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { evidence?: string } }>(
    '/api/defects/:id',
    async (req, reply) => {
      const ok = store.delete(req.params.id, {
        evidence: req.query.evidence === '1' || req.query.evidence === 'true',
      });
      if (!ok) return reply.code(404).send({ error: 'not found' });
      return { ok: true };
    },
  );

  /**
   * Primary create path: screenshot(s) + comment → normalize job (coding agent optional).
   * multipart fields: comment, severity?, client?, surface?, area?, mode?, source?, app_id?, repos?
   * repos: JSON array string, comma-separated names, or repeated field
   * files: any field name (images)
   * Used by web UI and future SDK clients.
   */
  app.post('/api/intake', async (req, reply) => {
    const parts = req.parts();
    let comment = '';
    let severity = '';
    let client = '';
    let surface = '';
    let area = '';
    let source = '';
    let reporter = '';
    let app_id = '';
    let mode: string | undefined;
    const repos: string[] = [];
    const files: Array<{ filename: string; data: Buffer }> = [];

    for await (const part of parts) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        if (buf.length > 0) {
          files.push({ filename: part.filename || 'upload.png', data: buf });
        }
      } else {
        const v = String(part.value ?? '');
        if (part.fieldname === 'comment') comment = v;
        else if (part.fieldname === 'severity') severity = v;
        else if (part.fieldname === 'client') client = v;
        else if (part.fieldname === 'surface') surface = v;
        else if (part.fieldname === 'area') area = v;
        else if (part.fieldname === 'source') source = v;
        else if (part.fieldname === 'reporter') reporter = v;
        else if (part.fieldname === 'app_id') app_id = v;
        else if (part.fieldname === 'mode') mode = v;
        else if (part.fieldname === 'repos') {
          for (const r of parseReposField(v)) repos.push(r);
        }
      }
    }

    try {
      const job = await jobs.enqueue({
        comment,
        severity: severity || undefined,
        client: client || undefined,
        surface: surface || undefined,
        area: area || undefined,
        source: source || undefined,
        reporter: reporter || undefined,
        app_id: app_id || undefined,
        repos: repos.length ? [...new Set(repos)] : undefined,
        files,
        mode:
          mode === 'local' || mode === 'manual' || mode === 'grok'
            ? mode
            : undefined,
      });
      return reply.code(202).send({ job });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  /** JSON-only create (no images) — still goes through normalize (local/grok). */
  app.post<{
    Body: {
      comment?: string;
      severity?: string;
      client?: string;
      surface?: string;
      area?: string;
      source?: string;
      reporter?: string;
      app_id?: string;
      repos?: string[] | string;
      mode?: string;
    };
  }>('/api/intake/json', async (req, reply) => {
    try {
      const b = req.body ?? {};
      const repos =
        typeof b.repos === 'string'
          ? parseReposField(b.repos)
          : Array.isArray(b.repos)
            ? b.repos.map(String).map((s) => s.trim()).filter(Boolean)
            : undefined;
      const job = await jobs.enqueue({
        comment: b.comment ?? '',
        severity: b.severity,
        client: b.client,
        surface: b.surface,
        area: b.area,
        source: b.source,
        reporter: b.reporter,
        app_id: b.app_id,
        repos,
        files: [],
        mode:
          b.mode === 'local' || b.mode === 'manual' || b.mode === 'grok'
            ? b.mode
            : undefined,
      });
      return reply.code(202).send({ job });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  app.get('/api/jobs', async () => ({ jobs: jobs.list() }));

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    return { job };
  });

  app.get('/api/batches', async () => ({
    batches: batches.listManifests(),
    jobs: batches.list(),
  }));

  app.get<{ Params: { id: string } }>('/api/batches/:id', async (req, reply) => {
    const batch = batches.getManifest(req.params.id);
    if (!batch) return reply.code(404).send({ error: 'not found' });
    return { batch };
  });

  /**
   * Create a batch from multi-selected defects; optionally start one coding-agent fix session.
   * Body: { app_id, defect_ids[], goal?, title?, mode?, start_fix?,
   *         repo_url?, repo_urls? }  // git remotes for worktree clones
   */
  app.post<{
    Body: {
      app_id?: string;
      defect_ids?: string[];
      goal?: string;
      title?: string;
      mode?: string;
      start_fix?: boolean;
      repo_url?: string;
      repo_urls?: string[];
    };
  }>('/api/batches', async (req, reply) => {
    try {
      const b = req.body ?? {};
      const app_id = (b.app_id ?? getDefaultAppId(db)).trim();
      const result = await batches.create({
        app_id,
        defect_ids: Array.isArray(b.defect_ids) ? b.defect_ids : [],
        goal: b.goal,
        title: b.title,
        mode: b.mode === 'manual' ? 'manual' : 'grok',
        start_fix: b.start_fix,
        repo_url: b.repo_url,
        repo_urls: Array.isArray(b.repo_urls) ? b.repo_urls : undefined,
      });
      return reply.code(201).send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: msg });
    }
  });

  app.get<{ Params: { id: string } }>(
    '/api/batch-jobs/:id',
    async (req, reply) => {
      const job = batches.get(req.params.id);
      if (!job) return reply.code(404).send({ error: 'not found' });
      return { job };
    },
  );

  /**
   * Hunks behind a job's diff-hygiene numbers, for the console drill-down.
   * Computed on demand from the worktree — diffs are not stored on the job.
   */
  app.get<{
    Params: { id: string; repo: string };
    Querystring: { kind?: string; limit?: string };
  }>('/api/batch-jobs/:id/diff/:repo', async (req, reply) => {
    const job = batches.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'not found' });
    const wt = (job.worktrees || []).find((w) => w.repo === req.params.repo);
    if (!wt) return reply.code(404).send({ error: `no worktree "${req.params.repo}" on this job` });
    const baseSha = (job.diffHygiene?.repos || []).find(
      (r) => r.repo === req.params.repo,
    )?.baseSha;
    if (!baseSha) {
      return reply.code(409).send({ error: 'no diff baseline recorded for this job' });
    }
    if (!existsSync(wt.worktreeAbs)) {
      return reply.code(410).send({ error: `worktree is gone: ${wt.worktreeAbs}` });
    }
    try {
      const kind = req.query.kind === 'all' ? 'all' : 'reflow';
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
      return { repo: req.params.repo, kind, ...collectHunks({ worktreeAbs: wt.worktreeAbs, baseSha, kind, limit }) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  });

  /** Stop a running coding-agent batch job (SIGTERM → SIGKILL). */
  app.post<{ Params: { id: string } }>(
    '/api/batch-jobs/:id/stop',
    async (req, reply) => {
      try {
        const job = batches.stop(req.params.id);
        return { job };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) {
          return reply.code(404).send({ error: msg });
        }
        return reply.code(400).send({ error: msg });
      }
    },
  );

  /** Re-run the coding agent on an existing batch job's worktrees. */
  app.post<{ Params: { id: string } }>(
    '/api/batch-jobs/:id/rerun',
    async (req, reply) => {
      try {
        const job = batches.rerun(req.params.id);
        return { job };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) {
          return reply.code(404).send({ error: msg });
        }
        return reply.code(400).send({ error: msg });
      }
    },
  );

  /**
   * Delete batch job + handoff artifacts (worktrees, BRIEF, logs).
   * Stops the agent process if still running. Does not delete inventory defects/evidence.
   */
  app.delete<{ Params: { id: string } }>(
    '/api/batch-jobs/:id',
    async (req, reply) => {
      try {
        const result = batches.delete(req.params.id);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) {
          return reply.code(404).send({ error: msg });
        }
        return reply.code(400).send({ error: msg });
      }
    },
  );

  /**
   * Push worktree branches and create GitHub PRs (requires `gh` auth on host).
   */
  app.post<{ Params: { id: string } }>(
    '/api/batch-jobs/:id/create-prs',
    async (req, reply) => {
      try {
        const job = batches.createPullRequests(req.params.id);
        return { job, prs: job.prs ?? [] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) {
          return reply.code(404).send({ error: msg });
        }
        return reply.code(400).send({ error: msg });
      }
    },
  );

  /**
   * Refresh GitHub PR lifecycle (open / merged / closed) via `gh` on host.
   */
  app.post<{ Params: { id: string } }>(
    '/api/batch-jobs/:id/refresh-prs',
    async (req, reply) => {
      try {
        const job = batches.refreshPullRequests(req.params.id);
        return { job, prs: job.prs ?? [] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not found')) {
          return reply.code(404).send({ error: msg });
        }
        return reply.code(400).send({ error: msg });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/jobs/:id/complete',
    async (req, reply) => {
      try {
        const job = await jobs.completeFromHandoff(req.params.id);
        return { job };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ error: msg });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/jobs/:id/cancel',
    async (req, reply) => {
      try {
        const job = jobs.cancel(req.params.id);
        return { job };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(404).send({ error: msg });
      }
    },
  );

  /** Serve evidence images: /evidence/<id>/<file> */
  app.get<{ Params: { id: string; file: string } }>(
    '/evidence/:id/:file',
    async (req, reply) => {
      const { id, file } = req.params;
      if (!isSafeId(id) || file.includes('..') || file.includes('/') || file.includes('\\')) {
        return reply.code(400).send({ error: 'invalid path' });
      }
      const abs = path.join(evidenceDir(deps.defectsRoot), id, file);
      const root = path.resolve(evidenceDir(deps.defectsRoot));
      if (!abs.startsWith(root + path.sep) || !existsSync(abs)) {
        return reply.code(404).send({ error: 'not found' });
      }
      const ext = path.extname(file).toLowerCase();
      const type =
        ext === '.png'
          ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.webp'
              ? 'image/webp'
              : ext === '.gif'
                ? 'image/gif'
                : 'application/octet-stream';
      reply.header('Content-Type', type);
      return reply.send(createReadStream(abs));
    },
  );
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v);
}

function strArr(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) return undefined;
  return v.map(String);
}

/** Parse repos multipart/JSON field: JSON array, or comma/newline-separated names. */
function parseReposField(raw: string): string[] {
  const t = raw.trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    try {
      const v = JSON.parse(t) as unknown;
      if (Array.isArray(v)) {
        return v.map(String).map((s) => s.trim()).filter(Boolean);
      }
    } catch {
      /* fall through */
    }
  }
  return t
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

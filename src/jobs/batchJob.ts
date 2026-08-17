import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  getApp,
  getAppRepoUrls,
  parseBaseSource,
  parseGitRefName,
  resolveGrokSandbox,
  resolvePrimaryRepos,
} from '../apps.js';
import {
  buildBatchFixBrief,
  getBatch,
  listBatches,
  makeBatchId,
  setBatchStatus,
  writeBatchManifest,
  type BatchRecord,
  type BatchStatus,
} from '../batches.js';
import {
  deleteJobSummary,
  jobStatusToPromptOutcome,
  recordPromptUse,
  setPromptUseOutcomeForJob,
  upsertJobSummary,
} from '../analytics.js';
import { packageRoot } from '../paths.js';
import { jobSummaryDoc } from '../search/documents.js';
import { publishDocumentsBackground } from '../search/publisher.js';
import type { DefectStore } from '../store.js';
import { isSafeId } from '../store.js';
import {
  attachRepoUrls,
  createBatchWorktrees,
  createPullRequestsForWorktrees,
  DEFAULT_BASE,
  ensureCloneFromUrl,
  type BaseConfig,
  hasTrackablePrs,
  isLocalBaseRemote,
  parseGitRepoUrl,
  primariesFromRepoUrls,
  refreshPullRequestStatuses,
  removeBatchWorktrees,
  type CreatePrResult,
  type WorktreeBinding,
} from '../worktrees.js';
import { spawnGrokBatchFix } from './spawnGrokBatchFix.js';

/** Safe job directory name: bjob_<alnum> */
const SAFE_JOB_ID = /^bjob_[a-z0-9_]+$/i;

export type BatchJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'manual'
  | 'cancelled';

export type BatchJob = {
  jobId: string;
  batchId: string;
  status: BatchJobStatus;
  mode: 'grok' | 'manual';
  app_id: string;
  defect_ids: string[];
  createdAt: string;
  updatedAt: string;
  error?: string;
  log: string[];
  batchPath?: string;
  handoffPath?: string;
  worktrees?: WorktreeBinding[];
  /** Git remotes supplied from the console for this batch */
  repo_urls?: string[];
  /** Results from Create PR action */
  prs?: CreatePrResult[];
};

function nowIso(): string {
  return new Date().toISOString();
}

export class BatchJobRunner {
  private jobs = new Map<string, BatchJob>();
  /** Live Grok child kill handles (web UI stop) */
  private running = new Map<string, { kill: () => void }>();

  constructor(
    private readonly store: DefectStore,
    private readonly dataRoot: string,
  ) {
    mkdirSync(path.join(dataRoot, 'batch-jobs'), { recursive: true });
    this.hydrate();
  }

  private jobsRoot(): string {
    return path.join(this.dataRoot, 'batch-jobs');
  }

  private hydrate(): void {
    const root = this.jobsRoot();
    if (!existsSync(root)) return;
    for (const name of readdirSync(root)) {
      const p = path.join(root, name, 'job.json');
      if (!existsSync(p)) continue;
      try {
        const job = JSON.parse(readFileSync(p, 'utf8')) as BatchJob;
        if (!job?.jobId) continue;
        if (!Array.isArray(job.log)) job.log = [];
        // Process handles do not survive restarts
        if (job.status === 'running' || job.status === 'queued') {
          job.status = 'failed';
          job.error = job.error || 'interrupted by backend restart';
          job.log.push(
            '[warn] marked failed on hydrate (Grok process no longer live)',
          );
          job.updatedAt = nowIso();
          writeFileSync(p, JSON.stringify(job, null, 2), 'utf8');
        }
        this.jobs.set(job.jobId, job);
        try {
          upsertJobSummary(this.store.db, {
            job_id: job.jobId,
            batch_id: job.batchId,
            app_id: job.app_id,
            status: job.status,
            mode: job.mode,
            defect_ids: job.defect_ids,
            prs: job.prs,
            error: job.error,
            created_at: job.createdAt,
            updated_at: job.updatedAt,
          });
        } catch {
          /* ignore backfill errors */
        }
      } catch {
        /* skip */
      }
    }
  }

  private persist(job: BatchJob): void {
    this.jobs.set(job.jobId, job);
    const dir = path.join(this.jobsRoot(), job.jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
    // Phase A: denormalized job row for SQL analytics
    try {
      upsertJobSummary(this.store.db, {
        job_id: job.jobId,
        batch_id: job.batchId,
        app_id: job.app_id,
        status: job.status,
        mode: job.mode,
        defect_ids: job.defect_ids,
        prs: job.prs,
        error: job.error,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
      });
      const outcome = jobStatusToPromptOutcome(job.status);
      if (outcome !== 'unknown') {
        setPromptUseOutcomeForJob(this.store.db, job.jobId, outcome);
      }
      // Phase B: index job summary + tail of log (not full firehose)
      const logTail = (job.log || []).slice(-40).join('\n').slice(0, 6000);
      publishDocumentsBackground(
        { db: this.store.db },
        jobSummaryDoc({
          job_id: job.jobId,
          batch_id: job.batchId,
          app_id: job.app_id,
          status: job.status,
          mode: job.mode,
          error: job.error,
          created_at: job.createdAt,
          updated_at: job.updatedAt,
          log_excerpt: logTail || undefined,
          defect_ids: job.defect_ids,
        }),
      );
    } catch {
      /* analytics must not break harness */
    }
  }

  /**
   * Append a job log line with emitter source for UI distinction.
   * Format: `[level] [DefectDrainer|Grok] message`
   */
  private log(
    job: BatchJob,
    line: string,
    level: 'info' | 'warn' | 'error' = 'info',
    source: 'DefectDrainer' | 'Grok' = 'DefectDrainer',
  ): void {
    // Re-fetch map entry so concurrent updates stay on the live object
    const live = this.jobs.get(job.jobId) ?? job;
    if (!Array.isArray(live.log)) live.log = [];
    live.log.push(`[${level}] [${source}] ${line}`);
    // Keep a long tail for the web UI live log
    if (live.log.length > 4000) live.log.splice(0, live.log.length - 4000);
    live.updatedAt = nowIso();
    this.persist(live);
    // eslint-disable-next-line no-console
    console.log(`[batch ${live.jobId}] [${level}] [${source}] ${line}`);
  }

  list(): BatchJob[] {
    return [...this.jobs.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  get(jobId: string): BatchJob | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Delete a batch job from the runner and wipe handoff artifacts:
   * worktrees (git remove + branch), handoff dir (BRIEF, logs, fix-evidence copies),
   * and the batch manifest row when present.
   * Stops a live Grok process first. Does not delete product defects or inventory evidence.
   */
  delete(jobId: string): { ok: true; jobId: string; batchId?: string } {
    if (!SAFE_JOB_ID.test(jobId)) {
      throw new Error(`invalid job id: ${jobId}`);
    }
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);

    // Stop live Grok if any
    const handle = this.running.get(jobId);
    if (handle) {
      try {
        handle.kill();
      } catch {
        /* ignore */
      }
      this.running.delete(jobId);
    }

    // Free defects that were only in_progress for this batch (no fix proof yet)
    for (const id of job.defect_ids || []) {
      try {
        const d = this.store.get(id);
        if (
          d &&
          d.status === 'in_progress' &&
          !(d.fix_evidence?.length)
        ) {
          this.store.update(id, { status: 'open' });
        }
      } catch {
        /* ignore */
      }
    }

    // Detach git worktrees + delete batch branches
    try {
      if (job.worktrees?.length) {
        removeBatchWorktrees(job.worktrees);
      }
    } catch {
      /* best effort */
    }

    // Wipe entire handoff (job.json, BRIEF, worktrees/, fix-evidence/, logs)
    const handoff = path.join(this.jobsRoot(), jobId);
    const root = path.resolve(this.jobsRoot());
    const abs = path.resolve(handoff);
    if (abs === root || !abs.startsWith(root + path.sep)) {
      throw new Error('refusing to delete path outside batch-jobs');
    }
    if (existsSync(abs)) {
      rmSync(abs, { recursive: true, force: true });
    }

    // Drop batch manifest if this was its job
    if (job.batchId) {
      try {
        this.store.db
          .prepare('DELETE FROM batches WHERE id = ?')
          .run(job.batchId);
      } catch {
        /* ignore */
      }
    }

    this.jobs.delete(jobId);
    try {
      deleteJobSummary(this.store.db, jobId);
    } catch {
      /* ignore */
    }
    return { ok: true, jobId, batchId: job.batchId };
  }

  listManifests(): BatchRecord[] {
    return listBatches(this.store.db);
  }

  getManifest(id: string): BatchRecord | null {
    return getBatch(this.store.db, id);
  }

  /** App-level fallback when a repo entry has no source/branch of its own. */
  private baseConfigFor(appId: string): BaseConfig {
    const app = getApp(this.store.db, appId);
    return {
      remote: app?.base_remote || DEFAULT_BASE.remote,
      branch: app?.base_branch || DEFAULT_BASE.branch,
    };
  }

  /** Per-repo base from Settings entries; missing names fall back to the app default. */
  private baseByRepoFor(appId: string): Record<string, BaseConfig> {
    const app = getApp(this.store.db, appId);
    const fallback = this.baseConfigFor(appId);
    const out: Record<string, BaseConfig> = {};
    for (const e of app?.repo_entries ?? []) {
      if (!e.name) continue;
      const source = parseBaseSource(e.base_source, fallback.remote === 'local' ? 'local' : 'origin');
      out[e.name] = {
        remote: source === 'local' ? 'local' : 'origin',
        branch: parseGitRefName(e.base_branch, fallback.branch),
      };
    }
    return out;
  }

  /**
   * Create product worktrees for this batch (fail-closed).
   * Prefer explicit repo_urls (clone + worktree); else app workspace_root checkouts.
   */
  private setupWorktrees(
    job: BatchJob,
    defectRepos: string[][],
    repoUrls: string[],
  ): WorktreeBinding[] {
    const worktreesRoot = path.join(
      this.jobsRoot(),
      job.jobId,
      'worktrees',
    );
    const app = getApp(this.store.db, job.app_id);
    const fallback = this.baseConfigFor(job.app_id);
    const baseByRepo = this.baseByRepoFor(job.app_id);
    const wanted = new Set<string>();
    for (const list of defectRepos) {
      for (const r of list) {
        const n = r.trim();
        if (n) wanted.add(n);
      }
    }

    const entries = (app?.repo_entries ?? []).filter((e) => e.name);
    const selected = wanted.size
      ? entries.filter((e) => wanted.has(e.name))
      : entries;

    let primaryByRepo: Record<string, string>;
    let urlByRepo: Record<string, string> = {};
    let fetchFirst = false;

    if (selected.length) {
      primaryByRepo = {};
      const clonesRoot = path.join(this.dataRoot, 'clones');
      for (const e of selected) {
        const cfg =
          baseByRepo[e.name] ?? {
            remote:
              parseBaseSource(e.base_source, fallback.remote === 'local' ? 'local' : 'origin') ===
              'local'
                ? 'local'
                : 'origin',
            branch: parseGitRefName(e.base_branch, fallback.branch),
          };
        baseByRepo[e.name] = cfg;
        if (isLocalBaseRemote(cfg.remote)) {
          const loc =
            e.url.trim() ||
            (app?.workspace_root
              ? path.join(app.workspace_root, e.name)
              : '');
          if (!loc) {
            throw new Error(
              `${e.name}: local checkout path required (set the repo path in Settings)`,
            );
          }
          if (!path.isAbsolute(loc)) {
            throw new Error(`${e.name}: local checkout must be an absolute path`);
          }
          primaryByRepo[e.name] = path.resolve(loc);
          this.log(job, `local checkout: ${e.name} → ${primaryByRepo[e.name]}`);
        } else {
          if (!e.url.trim()) {
            throw new Error(`${e.name}: GitHub repo URL required`);
          }
          const cloned = ensureCloneFromUrl(e.url, clonesRoot);
          primaryByRepo[e.name] = cloned.primaryAbs;
          urlByRepo[e.name] = cloned.url;
          this.log(job, `clone ready: ${e.name} ← ${cloned.url}`);
        }
      }
    } else if (repoUrls.length) {
      const clonesRoot = path.join(this.dataRoot, 'clones');
      this.log(job, `cloning/fetching ${repoUrls.length} repo URL(s) → ${clonesRoot}`);
      primaryByRepo = primariesFromRepoUrls(repoUrls, clonesRoot);
      for (const u of repoUrls) {
        const { name, url } = parseGitRepoUrl(u);
        urlByRepo[name] = url;
        this.log(job, `clone ready: ${name} ← ${url}`);
      }
    } else {
      primaryByRepo = resolvePrimaryRepos(this.store.db, {
        app_id: job.app_id,
        defectRepos,
      });
      fetchFirst = !isLocalBaseRemote(fallback.remote);
    }

    this.log(job, `creating worktrees under ${worktreesRoot}`);
    let bindings = createBatchWorktrees({
      batchId: job.batchId,
      worktreesRoot,
      primaryByRepo,
      base: fallback,
      baseByRepo,
      fetchFirst,
      onLog: (line, level) =>
        this.log(job, line, level ?? 'info', 'DefectDrainer'),
    });
    if (Object.keys(urlByRepo).length) {
      bindings = attachRepoUrls(bindings, urlByRepo);
    }
    for (const b of bindings) {
      this.log(
        job,
        `worktree ready: ${b.repo} → ${b.worktreeAbs} (${b.branch})${b.repoUrl ? ` ← ${b.repoUrl}` : ''}`,
      );
    }
    return bindings;
  }

  async create(input: {
    app_id: string;
    defect_ids: string[];
    goal?: string;
    title?: string;
    mode?: 'grok' | 'manual';
    start_fix?: boolean;
    /** Git repo URL(s) from console — cloned then worktree'd */
    repo_url?: string;
    repo_urls?: string[];
  }): Promise<{ batch: BatchRecord; job: BatchJob }> {
    const ids = [...new Set(input.defect_ids.map((s) => s.trim()).filter(Boolean))];
    if (!ids.length) throw new Error('defect_ids required');

    const defects = ids.map((id) => {
      const d = this.store.get(id);
      if (!d) throw new Error(`defect not found: ${id}`);
      if (input.app_id && d.app_id && d.app_id !== input.app_id) {
        throw new Error(`defect ${id} belongs to app ${d.app_id}, not ${input.app_id}`);
      }
      return d;
    });

    // Ensure app is known early (workspace_root fallback when no repo_urls)
    if (!getApp(this.store.db, input.app_id)) {
      throw new Error(`unknown app_id: ${input.app_id}`);
    }

    const fromRequest = [
      ...(input.repo_urls ?? []),
      ...(input.repo_url ? [input.repo_url] : []),
    ]
      .flatMap((s) => s.split(/[\n,]+/))
      .map((s) => s.trim())
      .filter(Boolean);
    // Prefer request URLs; else app settings (Settings page)
    const appCfg = getApp(this.store.db, input.app_id);
    const repoUrls = fromRequest.length
      ? fromRequest
      : getAppRepoUrls(appCfg);
    // de-dupe preserving order
    const seenUrl = new Set<string>();
    const uniqueRepoUrls = repoUrls.filter((u) => {
      if (seenUrl.has(u)) return false;
      seenUrl.add(u);
      return true;
    });

    const batchId = makeBatchId();
    const mode = input.mode === 'manual' ? 'manual' : 'grok';
    const start = input.start_fix !== false;
    const goal =
      input.goal?.trim() ||
      `Batch-fix ${ids.length} defect(s) for app ${input.app_id}`;
    const title =
      input.title?.trim() ||
      `${input.app_id} · ${ids.length} defects · ${batchId.slice(-5)}`;

    const batch = writeBatchManifest(this.store.db, {
      id: batchId,
      title,
      app_id: input.app_id,
      goal,
      status: start ? 'in_progress' : 'planned',
      defect_ids: ids,
      mode,
    });

    for (const d of defects) {
      if (d.status === 'open' || d.status === 'triaged') {
        try {
          this.store.update(d.id, { status: 'in_progress' });
        } catch {
          /* ignore */
        }
      }
    }

    const jobId = `bjob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const handoff = path.join(this.jobsRoot(), jobId);
    mkdirSync(handoff, { recursive: true });

    const job: BatchJob = {
      jobId,
      batchId,
      status: start ? (mode === 'manual' ? 'manual' : 'queued') : 'manual',
      mode,
      app_id: input.app_id,
      defect_ids: ids,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      log: [],
      batchPath: batch.path,
      handoffPath: path.relative(packageRoot, handoff),
      worktrees: [],
      repo_urls: uniqueRepoUrls.length ? uniqueRepoUrls : undefined,
    };

    this.persist(job);
    // Phase A: structured prompt_use for batch-fix analytics
    try {
      recordPromptUse(this.store.db, {
        prompt_key:
          mode === 'manual' ? 'batch_fix.manual.v1' : 'batch_fix.v1',
        prompt_version: '1',
        job_id: jobId,
        batch_id: batchId,
        app_id: input.app_id,
        defect_ids: ids,
        outcome: 'unknown',
        runner: mode === 'manual' ? 'manual' : 'coding_agent',
        body_text: goal.slice(0, 2000),
      });
    } catch {
      /* non-fatal */
    }
    this.log(job, `batch manifest → ${batch.path}`);
    this.log(job, `handoff → ${handoff}`);
    // Pre-create handoff dirs the agent must write into (sandbox-writable)
    mkdirSync(path.join(handoff, 'fix-evidence'), { recursive: true });
    mkdirSync(path.join(handoff, 'fix-notes'), { recursive: true });

    let worktrees: WorktreeBinding[] = [];
    if (start) {
      try {
        worktrees = this.setupWorktrees(
          job,
          defects.map((d) => d.repos || []),
          uniqueRepoUrls,
        );
        job.worktrees = worktrees;
        this.persist(job);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        job.status = 'failed';
        job.error = msg;
        this.log(job, `worktree setup failed (fail-closed): ${msg}`, 'error');
        this.persist(job);
        this.syncBatchAndDefects(job, 'failed');
        // still write brief for debugging
        writeFileSync(
          path.join(handoff, 'BRIEF.md'),
          buildBatchFixBrief({
            batch,
            defects: defects.map((d) => this.store.get(d.id)!).filter(Boolean),
            defectsRoot: this.store.defectsRoot,
            worktrees: [],
          }),
          'utf8',
        );
        throw new Error(`batch worktree setup failed: ${msg}`);
      }
    }

    const sandbox = resolveGrokSandbox(appCfg);
    const brief = buildBatchFixBrief({
      batch,
      defects: defects.map((d) => this.store.get(d.id)!).filter(Boolean),
      defectsRoot: this.store.defectsRoot,
      grok_sandbox: sandbox,
      worktrees,
    });
    writeFileSync(path.join(handoff, 'BRIEF.md'), brief, 'utf8');
    writeFileSync(
      path.join(handoff, 'request.json'),
      JSON.stringify(
        {
          batchId,
          app_id: input.app_id,
          defect_ids: ids,
          goal,
          defectsRoot: this.store.defectsRoot,
          batchPath: path.join(this.store.defectsRoot, batch.path),
          worktrees,
          repo_urls: uniqueRepoUrls,
          grok_sandbox: sandbox,
        },
        null,
        2,
      ),
      'utf8',
    );

    if (start && mode === 'grok') {
      if (!worktrees.length) {
        job.status = 'failed';
        job.error = 'no worktrees — refusing Grok spawn';
        this.log(job, job.error, 'error');
        this.persist(job);
        throw new Error(job.error);
      }
      void this.runGrok(job.jobId);
    } else {
      this.log(
        job,
        mode === 'manual' || !start
          ? worktrees.length
            ? `MANUAL: fix inside worktrees only (see BRIEF.md); primary checkouts are off-limits`
            : 'MANUAL: planned only (no worktrees yet)'
          : 'queued',
      );
    }

    return { batch, job: this.jobs.get(job.jobId)! };
  }

  /**
   * Stop a running Grok batch process (SIGTERM → SIGKILL).
   * Safe no-op kill if process already exited; always marks job cancelled when was running.
   */
  stop(jobId: string): BatchJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    if (job.status !== 'running' && job.status !== 'queued') {
      throw new Error(
        `cannot stop job in status ${job.status} (only running/queued)`,
      );
    }
    const handle = this.running.get(jobId);
    job.status = 'cancelled';
    job.error = 'stopped by operator';
    this.log(job, 'stop requested by operator (web UI)', 'warn');
    this.persist(job);
    this.syncBatchAndDefects(job, 'cancelled');
    if (handle) {
      handle.kill();
    } else {
      this.log(job, 'no live process handle (may still be starting)', 'warn');
    }
    return this.jobs.get(jobId)!;
  }

  /**
   * Push worktree branches and open GitHub PRs (`gh pr create`) for each repo
   * that has commits. Operator action — runs outside Grok sandbox.
   */
  createPullRequests(jobId: string): BatchJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    if (job.status === 'running' || job.status === 'queued') {
      throw new Error('job is still running — stop it before creating PRs');
    }
    const worktrees = job.worktrees || [];
    if (!worktrees.length) {
      throw new Error('no worktrees on job — cannot create PRs');
    }

    const batch = getBatch(this.store.db, job.batchId);
    const title =
      batch?.title?.trim() ||
      batch?.goal?.trim() ||
      `defect-drainer ${job.batchId}`;
    const defectLines = (job.defect_ids || [])
      .map((id) => {
        const d = this.store.get(id);
        return d
          ? `- \`${d.id}\`: ${d.title || d.summary || ''}`
          : `- \`${id}\``;
      })
      .join('\n');
    const body = [
      `## Batch ${job.batchId}`,
      ``,
      batch?.goal ? `**Goal:** ${batch.goal}` : '',
      ``,
      `### Defects`,
      defectLines || '- (none listed)',
      ``,
      `---`,
      `_Opened by defect-drainer Create PR_`,
    ]
      .filter(Boolean)
      .join('\n');

    this.log(job, `Create PR: ${worktrees.length} worktree(s)…`);
    const prs = createPullRequestsForWorktrees({
      bindings: worktrees,
      batchId: job.batchId,
      title,
      body,
      base: this.baseConfigFor(job.app_id),
      baseByRepo: this.baseByRepoFor(job.app_id),
      onLog: (line, level) =>
        this.log(job, line, level ?? 'info', 'DefectDrainer'),
    });
    job.prs = prs;
    const created = prs.filter(
      (p) => p.status === 'created' || p.status === 'existing',
    ).length;
    const failed = prs.filter((p) => p.status === 'failed').length;
    this.log(
      job,
      `Create PR done: ${created} PR(s), ${failed} failed, ${prs.length - created - failed} skipped`,
    );
    this.persist(job);
    return this.jobs.get(jobId)!;
  }

  /**
   * Poll GitHub (`gh`) for merge/open/closed state of stored PRs.
   * Operator action — requires `gh` auth and network on the host.
   */
  refreshPullRequests(jobId: string): BatchJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    const prs = job.prs || [];
    if (!prs.length) {
      throw new Error('no PRs on job — create PRs first');
    }
    if (!hasTrackablePrs(prs)) {
      throw new Error('no trackable PRs (all skipped or failed without URL)');
    }
    this.log(job, `Refresh PRs: ${prs.length} row(s)…`);
    job.prs = refreshPullRequestStatuses({
      prs,
      worktrees: job.worktrees,
      onLog: (line, level) =>
        this.log(job, line, level ?? 'info', 'DefectDrainer'),
    });
    const merged = (job.prs || []).filter((p) => p.ghState === 'merged').length;
    const open = (job.prs || []).filter((p) => p.ghState === 'open').length;
    const closed = (job.prs || []).filter((p) => p.ghState === 'closed').length;
    const errs = (job.prs || []).filter((p) => p.ghError).length;
    this.log(
      job,
      `Refresh PRs done: ${open} open, ${merged} merged, ${closed} closed${errs ? `, ${errs} error(s)` : ''}`,
    );
    this.persist(job);
    return this.jobs.get(jobId)!;
  }

  /**
   * Re-run Grok on an existing job's worktrees (same handoff / BRIEF).
   * Refuses if still running. Worktrees must already exist.
   */
  rerun(jobId: string): BatchJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    if (job.status === 'running' || job.status === 'queued') {
      throw new Error('job is still running — stop it first');
    }
    if (job.mode !== 'grok') {
      throw new Error('only grok-mode batch jobs can be re-run via this API');
    }
    const worktrees = job.worktrees || [];
    if (!worktrees.length) {
      throw new Error('no worktrees on job — cannot re-run Grok');
    }
    job.error = undefined;
    job.status = 'queued';
    this.log(job, 're-run requested by operator (web UI)', 'info');
    this.persist(job);
    void this.runGrok(jobId);
    return this.jobs.get(jobId)!;
  }

  private async runGrok(jobId: string): Promise<BatchJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    const handoff = path.join(this.jobsRoot(), jobId);
    const worktrees = job.worktrees || [];
    if (!worktrees.length) {
      job.status = 'failed';
      job.error = 'refusing Grok: worktrees missing';
      this.log(job, job.error, 'error');
      this.persist(job);
      this.syncBatchAndDefects(job, 'failed');
      return job;
    }

    if (this.running.has(jobId)) {
      throw new Error(`job ${jobId} already has a live Grok process`);
    }

    job.status = 'running';
    job.error = undefined;
    this.persist(job);
    setBatchStatus(this.store.db, job.batchId, 'in_progress');
    try {
      const app = getApp(this.store.db, job.app_id);
      const sandbox = resolveGrokSandbox(app);
      this.log(job, `app ${job.app_id} grok_sandbox=${sandbox}`);
      mkdirSync(path.join(handoff, 'fix-evidence'), { recursive: true });
      mkdirSync(path.join(handoff, 'fix-notes'), { recursive: true });
      const handle = spawnGrokBatchFix({
        handoffAbs: handoff,
        batchId: job.batchId,
        defectsRoot: this.store.defectsRoot,
        worktrees,
        sandbox,
        onLog: (line, level, source) =>
          this.log(job, line, level ?? 'info', source ?? 'DefectDrainer'),
      });
      this.running.set(jobId, { kill: handle.kill });
      const result = await handle.promise;
      this.running.delete(jobId);

      const live = this.jobs.get(jobId)!;
      if (live.status === 'cancelled') {
        this.log(
          live,
          `Grok exited after stop (code=${result.code} signal=${result.signal})`,
          'warn',
        );
        this.persist(live);
        // stop() already synced cancelled
        return live;
      }
      if (result.signal || (result.code !== 0 && result.code !== null)) {
        live.status = 'failed';
        live.error = `Grok exited code=${result.code} signal=${result.signal}`;
        this.log(live, live.error, 'error');
        this.persist(live);
        // Still try harvest in case partial evidence was written
        this.harvestFixEvidence(live, handoff);
        this.syncBatchAndDefects(live, 'failed');
        return live;
      }
      live.status = 'completed';
      this.log(live, 'Grok process exited OK — harvesting fix-evidence…');
      this.persist(live);
      this.harvestFixEvidence(live, handoff);
      this.syncBatchAndDefects(live, 'complete');
      this.log(
        live,
        'batch complete — review worktrees; merge when satisfied',
      );
      this.persist(live);
    } catch (err) {
      this.running.delete(jobId);
      const live = this.jobs.get(jobId);
      if (!live) throw err;
      if (live.status === 'cancelled') {
        this.log(live, 'Grok spawn aborted after stop', 'warn');
        this.persist(live);
        return live;
      }
      const msg = err instanceof Error ? err.message : String(err);
      live.status = 'failed';
      live.error = msg;
      this.log(live, msg, 'error');
      this.persist(live);
      this.syncBatchAndDefects(live, 'failed');
    }
    return this.jobs.get(jobId)!;
  }

  /**
   * Keep batch manifest + defect statuses aligned with the job outcome.
   * - complete: leave defects that got fix_evidence as resolved; others stay in_progress
   * - failed/cancelled: reopen in_progress defects that have no fix_evidence
   */
  private syncBatchAndDefects(
    job: BatchJob,
    batchStatus: BatchStatus,
  ): void {
    setBatchStatus(this.store.db, job.batchId, batchStatus);
    for (const id of job.defect_ids) {
      try {
        const d = this.store.get(id);
        if (!d) continue;
        if (batchStatus === 'complete') {
          // harvest may have resolved some; leave others in_progress
          if (d.status === 'in_progress' && !(d.fix_evidence?.length)) {
            // keep in_progress — still needs operator/Grok evidence
          }
          continue;
        }
        // failed / cancelled: free defects that were only marked in_progress for this batch
        if (
          (batchStatus === 'failed' || batchStatus === 'cancelled') &&
          d.status === 'in_progress' &&
          !(d.fix_evidence?.length)
        ) {
          this.store.update(id, { status: 'open' });
          this.log(job, `defect ${id} → open (${batchStatus})`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(job, `status sync ${id}: ${msg}`, 'warn');
      }
    }
    this.log(job, `batch ${job.batchId} → ${batchStatus}`);
  }

  /**
   * Import Grok-written handoff artifacts into SSOT:
   * - fix-evidence/<DEF-id>/* → evidence/<id>/fix-NN + fix_evidence
   * - fix-notes/<DEF-id>.md → resolution text
   * Resolves defect when at least one fix image is present.
   */
  private harvestFixEvidence(job: BatchJob, handoff: string): void {
    const fixRoot = path.join(handoff, 'fix-evidence');
    const notesRoot = path.join(handoff, 'fix-notes');
    let imported = 0;
    let resolved = 0;

    for (const defectId of job.defect_ids) {
      if (!isSafeId(defectId)) continue;
      try {
        const imgDir = path.join(fixRoot, defectId);
        const files: Array<{ filename: string; data: Buffer }> = [];
        if (existsSync(imgDir) && readdirSync(imgDir).length) {
          for (const name of readdirSync(imgDir)) {
            if (name.startsWith('.')) continue;
            const ext = path.extname(name).toLowerCase();
            if (!/^\.(png|jpe?g|webp|gif|heic)$/i.test(ext)) continue;
            const abs = path.join(imgDir, name);
            files.push({
              filename: name,
              data: readFileSync(abs),
            });
          }
        }

        let note = '';
        for (const cand of [
          path.join(notesRoot, `${defectId}.md`),
          path.join(notesRoot, `${defectId}.txt`),
          path.join(fixRoot, defectId, 'NOTES.md'),
          path.join(fixRoot, defectId, 'resolution.md'),
        ]) {
          if (existsSync(cand)) {
            note = readFileSync(cand, 'utf8').trim();
            break;
          }
        }

        if (!files.length && !note) {
          this.log(
            job,
            `harvest ${defectId}: no fix-evidence/ or fix-notes/ — left open`,
            'warn',
          );
          continue;
        }

        let cur = this.store.get(defectId);
        if (!cur) continue;

        if (files.length) {
          cur = this.store.addFixEvidence(defectId, files);
          imported += files.length;
          this.log(
            job,
            `harvest ${defectId}: ${files.length} fix image(s) → evidence/`,
          );
        }

        if ((cur.fix_evidence?.length ?? 0) > 0) {
          this.store.resolve(defectId, {
            resolution:
              note ||
              cur.resolution ||
              `fixed in batch ${job.batchId} (Grok + fix evidence)`,
            fix_evidence: cur.fix_evidence,
          });
          resolved += 1;
          this.log(job, `harvest ${defectId}: resolved with fix_evidence`);
        } else if (note) {
          this.store.update(defectId, {
            resolution: note,
          });
          this.log(
            job,
            `harvest ${defectId}: notes only (no images) — still needs screenshots`,
            'warn',
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(job, `harvest ${defectId} failed: ${msg}`, 'error');
      }
    }

    this.log(
      job,
      `harvest done: ${imported} image(s), ${resolved}/${job.defect_ids.length} resolved`,
    );
  }
}

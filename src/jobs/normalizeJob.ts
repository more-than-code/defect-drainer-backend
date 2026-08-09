import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  clientHintForApp,
  getApp,
  getDefaultAppId,
  resolveAppId,
  resolveGrokSandbox,
  SEEDED_TUTORED_WEBAPP_APP_ID,
} from '../apps.js';
import { envDrainer, envDrainerFlag } from '../env.js';
import { serializeMarkdown } from '../frontmatter.js';
import { jobsDir } from '../paths.js';
import type { DefectStore } from '../store.js';
import { makeDefectId } from '../store.js';
import { spawnGrokNormalize } from './spawnGrokNormalize.js';

export type NormalizeMode = 'grok' | 'local' | 'manual';

export type NormalizeJobStatus =
  | 'queued'
  | 'running'
  | 'waiting_external'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type NormalizeJob = {
  jobId: string;
  defectId: string;
  status: NormalizeJobStatus;
  mode: NormalizeMode;
  comment: string;
  severity: string;
  client: string;
  surface: string;
  app_id: string;
  /** Reporter-selected repo names (Report ticks); empty → app defaults */
  repos: string[];
  /** Intake origin: web-ui | sdk | api | … */
  source: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  defectPath?: string;
  log: string[];
};

export type IntakeInput = {
  comment: string;
  severity?: string;
  client?: string;
  surface?: string;
  area?: string;
  /** Product app this defect belongs to (default from apps registry). */
  app_id?: string;
  /** Origin tag stored on the defect (default screenshot+comment). */
  source?: string;
  /** Repo names the issue relates to (from Report checkboxes). */
  repos?: string[];
  files: Array<{ filename: string; data: Buffer }>;
  /** Force mode for this job (else env). */
  mode?: NormalizeMode;
  /** Pre-assigned id (tests). */
  defectId?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Intake is API-owned: default **local** (structured defect from comment + files).
 * Agent vision normalize is optional (`DEFECT_DRAINER_NORMALIZE_MODE=grok` or per-request mode).
 */
export function resolveNormalizeMode(override?: NormalizeMode): NormalizeMode {
  if (override) return override;
  if (envDrainerFlag('NORMALIZE_GROK')) return 'grok';
  if (envDrainerFlag('NORMALIZE_MANUAL')) return 'manual';
  if (envDrainerFlag('NORMALIZE_LOCAL')) return 'local';
  const m = (envDrainer('NORMALIZE_MODE') ?? 'local').toLowerCase();
  if (m === 'local' || m === 'manual' || m === 'grok') return m;
  return 'local';
}

export class NormalizeJobRunner {
  private jobs = new Map<string, NormalizeJob>();
  private running = new Set<string>();

  constructor(
    private readonly store: DefectStore,
    private readonly dataRoot: string,
  ) {
    mkdirSync(jobsDir(dataRoot), { recursive: true });
    this.hydrateFromDisk();
  }

  /** Reload job.json files so UI/SDK status survives process restart. */
  private hydrateFromDisk(): void {
    const root = jobsDir(this.dataRoot);
    if (!existsSync(root)) return;
    for (const name of readdirSync(root)) {
      if (name.startsWith('.')) continue;
      const jobPath = path.join(root, name, 'job.json');
      if (!existsSync(jobPath)) continue;
      try {
        const raw = JSON.parse(readFileSync(jobPath, 'utf8')) as NormalizeJob;
        if (!raw?.jobId) continue;
        if (!Array.isArray(raw.log)) raw.log = [];
        if (!raw.source) raw.source = 'screenshot+comment';
        if (!raw.app_id) raw.app_id = SEEDED_TUTORED_WEBAPP_APP_ID;
        if (!Array.isArray(raw.repos)) raw.repos = [];
        this.jobs.set(raw.jobId, raw);
      } catch {
        /* skip corrupt handoff */
      }
    }
  }

  list(): NormalizeJob[] {
    return [...this.jobs.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  get(jobId: string): NormalizeJob | undefined {
    return this.jobs.get(jobId);
  }

  private handoffPath(jobId: string): string {
    return path.join(jobsDir(this.dataRoot), jobId);
  }

  private persist(job: NormalizeJob): void {
    this.jobs.set(job.jobId, job);
    const dir = this.handoffPath(job.jobId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'job.json'),
      JSON.stringify(job, null, 2),
      'utf8',
    );
  }

  private log(job: NormalizeJob, line: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    const entry = `[${level}] ${line}`;
    job.log.push(entry);
    if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
    job.updatedAt = nowIso();
    this.persist(job);
    // eslint-disable-next-line no-console
    console.log(`[normalize ${job.jobId}] ${entry}`);
  }

  async enqueue(input: IntakeInput): Promise<NormalizeJob> {
    const comment = input.comment?.trim() ?? '';
    if (!comment && input.files.length === 0) {
      throw new Error('comment or at least one image is required');
    }
    const defectId = input.defectId ?? makeDefectId(comment || 'screenshot');
    const jobId = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const mode = resolveNormalizeMode(input.mode);
    const source =
      input.source?.trim() ||
      (input.files.length ? 'screenshot+comment' : 'comment-only');
    const app_id = resolveAppId(this.store.db, input.app_id);
    const app = getApp(this.store.db, app_id);
    const repos = (input.repos ?? [])
      .map((r) => String(r).trim())
      .filter(Boolean);
    const job: NormalizeJob = {
      jobId,
      defectId,
      status: 'queued',
      mode,
      comment: comment || '(no comment — screenshot only)',
      severity: input.severity?.trim() || 'P2',
      // Operators select app only; client is derived (optional API override still allowed)
      client: input.client?.trim() || clientHintForApp(app),
      surface: input.surface?.trim() || '',
      app_id,
      repos,
      source,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      log: [],
    };

    const handoff = this.handoffPath(jobId);
    mkdirSync(path.join(handoff, 'evidence'), { recursive: true });

    const evidenceNames: string[] = [];
    let n = 1;
    for (const f of input.files) {
      const ext = path.extname(f.filename || '').toLowerCase() || '.png';
      const safeExt = /^\.(png|jpe?g|webp|gif|heic)$/i.test(ext) ? ext : '.png';
      const name = `${String(n).padStart(2, '0')}${safeExt}`;
      writeFileSync(path.join(handoff, 'evidence', name), f.data);
      evidenceNames.push(name);
      n += 1;
    }

    const request = {
      jobId,
      defectId,
      comment: job.comment,
      severity: job.severity,
      client: job.client,
      surface: job.surface,
      area: input.area ?? '',
      app_id: job.app_id,
      source: job.source,
      repos: job.repos,
      reported: today(),
      evidence: evidenceNames.map((name) => `evidence/${name}`),
      createdAt: job.createdAt,
    };
    writeFileSync(
      path.join(handoff, 'request.json'),
      JSON.stringify(request, null, 2),
      'utf8',
    );
    writeFileSync(path.join(handoff, 'BRIEF.md'), buildBrief(request), 'utf8');

    this.persist(job);
    this.log(job, `handoff ready at ${handoff}`);

    // Local is fast and synchronous-enough for tests/UI; grok/manual stay async.
    if (mode === 'local') {
      return this.run(job.jobId);
    }
    void this.run(job.jobId);
    return job;
  }

  async run(jobId: string): Promise<NormalizeJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    if (this.running.has(jobId)) return job;
    this.running.add(jobId);

    try {
      job.status = 'running';
      this.persist(job);

      if (job.mode === 'manual') {
        job.status = 'waiting_external';
        this.log(
          job,
          'MANUAL mode: write defect.md in handoff, then POST /api/jobs/:id/complete',
        );
        return job;
      }

      if (job.mode === 'local') {
        this.writeLocalDefectMd(job);
      } else {
        try {
          const app = getApp(this.store.db, job.app_id);
          await spawnGrokNormalize({
            handoffAbs: this.handoffPath(job.jobId),
            jobId: job.jobId,
            defectId: job.defectId,
            sandbox: resolveGrokSandbox(app),
            onLog: (line, level) => this.log(job, line, level ?? 'info'),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log(job, `grok spawn failed: ${msg}`, 'error');
          // fall back to local so intake is never lost
          this.log(job, 'falling back to local normalize', 'warn');
          this.writeLocalDefectMd(job);
        }
      }

      await this.completeFromHandoff(job.jobId);
      return this.jobs.get(jobId)!;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.status = 'failed';
      job.error = msg;
      this.log(job, msg, 'error');
      this.persist(job);
      return job;
    } finally {
      this.running.delete(jobId);
    }
  }

  private writeLocalDefectMd(job: NormalizeJob): void {
    const handoff = this.handoffPath(job.jobId);
    const request = JSON.parse(
      readFileSync(path.join(handoff, 'request.json'), 'utf8'),
    ) as {
      evidence: string[];
      reported: string;
      area?: string;
      source?: string;
      app_id?: string;
    };
    const source = request.source || job.source || 'screenshot+comment';
    const app_id =
      request.app_id || job.app_id || getDefaultAppId(this.store.db);
    const title =
      job.comment.length > 72 ? `${job.comment.slice(0, 69)}…` : job.comment;
    const evidenceRel = (request.evidence ?? []).map(
      (e) => `evidence/${job.defectId}/${path.basename(e)}`,
    );
    const body = [
      '## Reporter notes',
      '',
      job.comment,
      '',
      '## Screenshot observations',
      '',
      request.evidence?.length
        ? `(local normalize — no vision) ${request.evidence.length} image(s) attached; open evidence for details.`
        : '(no screenshots)',
      '',
      '## Repro',
      '',
      '1. Not provided — inferred from reporter notes only (local normalize).',
      '',
      '## Expected',
      '',
      'Not specified.',
      '',
      '## Actual',
      '',
      job.comment,
      '',
      '## Notes',
      '',
      '- Normalized with `local` mode (no vision agent). Re-run with agent mode for vision pass.',
      '',
      '## Acceptance',
      '',
      '- [ ] Confirm title/summary match the real bug',
      '- [ ] Re-normalize with vision agent if screenshot context is needed',
      '',
      '## Evidence',
      '',
      ...evidenceRel.map((p) => `- \`${p}\``),
      '',
    ].join('\n');

    const md = serializeMarkdown(
      {
        id: job.defectId,
        title,
        app_id,
        severity: job.severity,
        status: 'open',
        area: request.area || guessArea(job.client),
        client: job.client,
        surface: job.surface,
        repos: resolveReposForJob(this.store.db, job),
        labels: ['intake'],
        related: [],
        source,
        key_files: [],
        evidence: evidenceRel,
        fix_evidence: [],
        reported: request.reported || today(),
        summary: job.comment.slice(0, 280),
      },
      body,
    );
    writeFileSync(path.join(handoff, 'defect.md'), md, 'utf8');
    this.log(job, 'wrote local defect.md');
  }

  async completeFromHandoff(jobId: string): Promise<NormalizeJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    const handoff = this.handoffPath(jobId);
    const defectPath = path.join(handoff, 'defect.md');
    if (!existsSync(defectPath)) {
      // if grok wrote nothing, local fallback
      this.log(job, 'defect.md missing — writing local fallback', 'warn');
      this.writeLocalDefectMd(job);
    }
    if (!existsSync(defectPath)) {
      throw new Error('defect.md still missing after fallback');
    }
    const md = readFileSync(defectPath, 'utf8');
    const evDir = path.join(handoff, 'evidence');
    const evidenceFiles = existsSync(evDir)
      ? readdirSync(evDir)
          .filter((n) => !n.startsWith('.'))
          .map((name) => ({
            filename: name,
            absPath: path.join(evDir, name),
          }))
      : [];

    const record = this.store.promoteFromHandoff({
      id: job.defectId,
      defectMarkdown: md,
      evidenceFiles,
    });
    job.status = 'completed';
    job.defectPath = record.path;
    job.error = undefined;
    this.log(job, `promoted → ${record.path}`);
    this.persist(job);
    return job;
  }

  cancel(jobId: string): NormalizeJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`job not found: ${jobId}`);
    if (job.status === 'completed') return job;
    job.status = 'cancelled';
    job.updatedAt = nowIso();
    this.persist(job);
    return job;
  }
}

function guessArea(client: string): string {
  if (client === 'web') return 'webapp';
  if (client === 'mobile') return 'mobile';
  return 'other';
}

/** Prefer reporter ticks; else app repo names; else client heuristic. */
function resolveReposForJob(
  db: import('../db.js').Db,
  job: NormalizeJob,
): string[] {
  if (job.repos?.length) return [...job.repos];
  const app = getApp(db, job.app_id);
  if (app?.repo_entries?.length) {
    return app.repo_entries.map((e) => e.name).filter(Boolean);
  }
  if (app?.repos?.length) return [...app.repos];
  if (job.client === 'web') return ['ttd-webapp', 'ttd-backend'];
  if (job.client === 'mobile') return ['ttd-mobileapp', 'ttd-backend'];
  return [];
}

function buildBrief(request: {
  jobId: string;
  defectId: string;
  comment: string;
  severity: string;
  client: string;
  surface: string;
  reported: string;
  evidence: string[];
  source?: string;
  app_id?: string;
  repos?: string[];
}): string {
  const source = request.source || 'screenshot+comment';
  const app_id = request.app_id || SEEDED_TUTORED_WEBAPP_APP_ID;
  const reposYaml =
    request.repos?.length
      ? request.repos.map((r) => `  - ${r}`).join('\n')
      : '  - ttd-webapp   # zero or more — prefer reporter ticks when listed above';
  return `# Defect normalization brief

## Facts
- Defect inventory for product app_id \`${app_id}\` (not a product user feature).
- Output is a single markdown file with YAML frontmatter for batch-fix later.
- Do **not** edit product code unless explicitly batch-fixing later.

## Decisions already made (do not relitigate)
| Decision | Value |
|----------|--------|
| defect id | \`${request.defectId}\` |
| app_id | \`${app_id}\` |
| status | \`open\` |
| source | \`${source}\` |
| severity default | \`${request.severity}\` |
| client hint | \`${request.client}\` |
| surface hint | \`${request.surface || '(none)'}\` |
| related repos | \`${(request.repos || []).join(', ') || '(app default)'}\` |
| reported | \`${request.reported}\` |

## Reporter comment
${request.comment}

## Evidence files (relative to cwd)
${request.evidence.map((e) => `- ${e}`).join('\n') || '- (none)'}

## Deliverable
Write **\`defect.md\`** in the handoff cwd with:

### Frontmatter (required keys)
\`\`\`yaml
id: ${request.defectId}
title: <one line>
app_id: ${app_id}
severity: P0|P1|P2|P3
status: open
area: webapp|backend|mobile|deploy|www|parity|cross-repo|other
client: web|mobile|unknown
surface: <route or screen if known>
repos:
${reposYaml}
labels: []
related: []
source: ${source}
key_files: []
evidence:
  - evidence/${request.defectId}/01.png   # final store paths after promote; use this id
reported: ${request.reported}
summary: <1-3 sentences>
\`\`\`

### Body sections
1. Reporter notes
2. Screenshot observations
3. Repro
4. Expected
5. Actual
6. Notes
7. Acceptance
8. Evidence (paths)

## Honesty constraints
- Do not invent repro steps, file paths, or root causes you cannot support.
- Prefer \`Notes\` open questions over fabricated certainty.
- Do not start fixing the bug.

## Done
When \`defect.md\` is written: reply \`DONE defect.md\`.
`;
}

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

export type WorktreeBinding = {
  /** Child repo name, e.g. ttd-webapp */
  repo: string;
  /** Primary checkout (must not be edited by the coding agent) */
  primaryAbs: string;
  /** Isolated worktree path for this batch */
  worktreeAbs: string;
  /** Branch created for this batch */
  branch: string;
  /** Remote URL if this primary was cloned from a URL */
  repoUrl?: string;
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Validate and normalize a git remote URL from the UI.
 * Allows https://, http://, ssh://, git@host:path, and local absolute paths.
 */
export function parseGitRepoUrl(raw: string): { url: string; name: string } {
  const url = raw.trim();
  if (!url) throw new Error('repo URL is empty');
  if (url.length > 2048) throw new Error('repo URL too long');
  if (/[\r\n\0]/.test(url)) throw new Error('repo URL must be a single line');
  if (url.includes('..')) throw new Error('repo URL must not contain ..');

  const ok =
    /^https?:\/\//i.test(url) ||
    /^ssh:\/\//i.test(url) ||
    /^git:\/\//i.test(url) ||
    /^git@[^:\s]+:\S+$/.test(url) ||
    (path.isAbsolute(url) && !url.includes('\0'));
  if (!ok) {
    throw new Error(
      'repo URL must be https://, ssh://, git@host:path, or an absolute local path',
    );
  }

  let leaf = url.replace(/\/+$/, '');
  if (leaf.includes(':') && leaf.includes('@') && !leaf.includes('://')) {
    // git@host:org/repo.git
    leaf = leaf.split(':').pop() || leaf;
  } else {
    try {
      if (/^https?:\/\//i.test(leaf) || /^ssh:\/\//i.test(leaf)) {
        leaf = new URL(leaf).pathname;
      }
    } catch {
      /* keep leaf */
    }
  }
  leaf = path.basename(leaf);
  leaf = leaf.replace(/\.git$/i, '') || 'repo';
  if (!/^[A-Za-z0-9._-]+$/.test(leaf)) {
    leaf = leaf.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  }
  return { url, name: leaf };
}

/**
 * Clone (or fetch-update) a remote into clonesRoot/<name>.
 * Returns absolute path used as worktree primary source.
 */
export function ensureCloneFromUrl(
  rawUrl: string,
  clonesRoot: string,
): { name: string; primaryAbs: string; url: string } {
  const { url, name } = parseGitRepoUrl(rawUrl);
  mkdirSync(clonesRoot, { recursive: true });
  const primaryAbs = path.join(clonesRoot, name);

  if (!existsSync(primaryAbs)) {
    try {
      execFileSync('git', ['clone', url, primaryAbs], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 600_000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`git clone failed for ${url}: ${msg}`);
    }
  } else if (isGitRepo(primaryAbs)) {
    try {
      git(primaryAbs, ['remote', 'set-url', 'origin', url]);
      git(primaryAbs, ['fetch', '--all', '--prune']);
    } catch {
      /* offline / no remote — use existing clone */
    }
  } else {
    throw new Error(`clone path exists but is not a git repo: ${primaryAbs}`);
  }

  return { name, primaryAbs, url };
}

/** Resolve one or more UI repo URLs into primaryByRepo map. */
export function primariesFromRepoUrls(
  urls: string[],
  clonesRoot: string,
): Record<string, string> {
  const cleaned = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  if (!cleaned.length) {
    throw new Error('at least one repo URL is required');
  }
  const out: Record<string, string> = {};
  for (const u of cleaned) {
    const { name, primaryAbs } = ensureCloneFromUrl(u, clonesRoot);
    if (out[name] && out[name] !== primaryAbs) {
      throw new Error(`duplicate repo name after parse: ${name}`);
    }
    out[name] = primaryAbs;
  }
  return out;
}

export function isGitRepo(dir: string): boolean {
  try {
    git(dir, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

/** Prefer main, then master, then current HEAD. */
export function resolveBaseRef(primaryAbs: string): string {
  for (const ref of ['main', 'master']) {
    try {
      git(primaryAbs, ['rev-parse', '--verify', ref]);
      return ref;
    } catch {
      /* try next */
    }
  }
  return 'HEAD';
}

/**
 * Create one worktree per repo for a batch fix.
 * Fail-closed: throws if any primary path missing or worktree add fails.
 */
export function createBatchWorktrees(opts: {
  batchId: string;
  /** Absolute parent dir for all worktrees of this job */
  worktreesRoot: string;
  /** Map repo name → absolute primary checkout */
  primaryByRepo: Record<string, string>;
}): WorktreeBinding[] {
  const repos = Object.keys(opts.primaryByRepo).sort();
  if (!repos.length) {
    throw new Error(
      'no product repos resolved for worktrees — set defect.repos and/or app.repos + workspace_root',
    );
  }

  mkdirSync(opts.worktreesRoot, { recursive: true });
  const branch = `defect-drainer/${opts.batchId}`;
  const bindings: WorktreeBinding[] = [];

  for (const repo of repos) {
    const primaryAbs = path.resolve(opts.primaryByRepo[repo]!);
    if (!existsSync(primaryAbs)) {
      throw new Error(`primary checkout missing for ${repo}: ${primaryAbs}`);
    }
    if (!isGitRepo(primaryAbs)) {
      throw new Error(`not a git repo: ${primaryAbs}`);
    }

    const worktreeAbs = path.join(opts.worktreesRoot, repo);
    if (existsSync(worktreeAbs)) {
      // leftover from crashed job — remove worktree registration if possible
      try {
        git(primaryAbs, ['worktree', 'remove', '--force', worktreeAbs]);
      } catch {
        rmSync(worktreeAbs, { recursive: true, force: true });
        try {
          git(primaryAbs, ['worktree', 'prune']);
        } catch {
          /* ignore */
        }
      }
    }

    // Drop stale branch if present (previous failed batch with same id is rare)
    try {
      git(primaryAbs, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      git(primaryAbs, ['branch', '-D', branch]);
    } catch {
      /* branch does not exist */
    }

    const base = resolveBaseRef(primaryAbs);
    try {
      git(primaryAbs, [
        'worktree',
        'add',
        '-b',
        branch,
        worktreeAbs,
        base,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // roll back any worktrees already created in this batch
      removeBatchWorktrees(bindings);
      throw new Error(
        `git worktree add failed for ${repo} (base=${base}, branch=${branch}): ${msg}`,
      );
    }

    bindings.push({
      repo,
      primaryAbs,
      worktreeAbs,
      branch,
    });
  }

  return bindings;
}

/** Attach repo URLs onto bindings when known (by repo name). */
export function attachRepoUrls(
  bindings: WorktreeBinding[],
  urlByRepo: Record<string, string>,
): WorktreeBinding[] {
  return bindings.map((b) => ({
    ...b,
    repoUrl: urlByRepo[b.repo] || b.repoUrl,
  }));
}

export function removeBatchWorktrees(bindings: WorktreeBinding[]): void {
  for (const b of bindings) {
    try {
      if (existsSync(b.worktreeAbs) && isGitRepo(b.primaryAbs)) {
        git(b.primaryAbs, ['worktree', 'remove', '--force', b.worktreeAbs]);
      }
    } catch {
      try {
        rmSync(b.worktreeAbs, { recursive: true, force: true });
        if (isGitRepo(b.primaryAbs)) {
          git(b.primaryAbs, ['worktree', 'prune']);
        }
      } catch {
        /* best effort */
      }
    }
    try {
      if (isGitRepo(b.primaryAbs)) {
        git(b.primaryAbs, ['branch', '-D', b.branch]);
      }
    } catch {
      /* branch may still be checked out elsewhere or missing */
    }
  }
}

/** GitHub PR lifecycle (from `gh pr view` / list) */
export type GhPrState = 'open' | 'merged' | 'closed';

export type CreatePrResult = {
  repo: string;
  branch: string;
  base: string;
  status: 'created' | 'existing' | 'skipped' | 'failed';
  url?: string;
  commits?: number;
  error?: string;
  /** Last known GitHub state (refreshed via `gh`) */
  ghState?: GhPrState;
  ghNumber?: number;
  /** ISO timestamp when merged (from GitHub) */
  mergedAt?: string | null;
  /** When we last polled GitHub for this PR */
  checkedAt?: string;
  ghError?: string;
};

/** Map GitHub `state` field (OPEN|MERGED|CLOSED) to our enum. */
export function mapGithubPrState(raw: unknown): GhPrState | undefined {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (s === 'OPEN') return 'open';
  if (s === 'MERGED') return 'merged';
  if (s === 'CLOSED') return 'closed';
  return undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

type GhPrView = {
  state?: string;
  mergedAt?: string | null;
  number?: number;
  url?: string;
};

/**
 * Injectable `gh … --json` runner (for tests). Default shells out to `gh`.
 */
export type GhJsonRunner = (args: string[], cwd?: string) => unknown;

function defaultGhJson(args: string[], cwd?: string): unknown {
  const out = execFileSync('gh', args, {
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!out) return null;
  return JSON.parse(out) as unknown;
}

function applyGhView(entry: CreatePrResult, view: GhPrView): void {
  const ghState = mapGithubPrState(view.state);
  if (ghState) entry.ghState = ghState;
  if (typeof view.number === 'number') entry.ghNumber = view.number;
  if (view.url) entry.url = view.url;
  if (view.mergedAt !== undefined) {
    entry.mergedAt = view.mergedAt || null;
  } else if (ghState === 'merged') {
    /* keep prior mergedAt if any */
  } else if (ghState === 'open' || ghState === 'closed') {
    entry.mergedAt = null;
  }
  entry.checkedAt = nowIso();
  delete entry.ghError;
}

/**
 * Refresh GitHub lifecycle fields on PR rows that have a URL or head branch.
 * Skipped/failed create rows without a URL are left unchanged.
 */
export function refreshPullRequestStatuses(opts: {
  prs: CreatePrResult[];
  /** Prefer worktree cwd so `gh` resolves the right remote */
  worktrees?: WorktreeBinding[];
  onLog?: (line: string, level?: 'info' | 'warn' | 'error') => void;
  ghJson?: GhJsonRunner;
}): CreatePrResult[] {
  const log = opts.onLog ?? (() => undefined);
  const ghJson = opts.ghJson ?? defaultGhJson;
  const byRepo = new Map(
    (opts.worktrees || []).map((w) => [w.repo, w] as const),
  );
  const out: CreatePrResult[] = [];

  for (const prev of opts.prs) {
    const entry: CreatePrResult = { ...prev };
    const trackable =
      Boolean(entry.url) ||
      entry.status === 'created' ||
      entry.status === 'existing';
    if (!trackable) {
      out.push(entry);
      continue;
    }

    const wt = byRepo.get(entry.repo);
    const cwd =
      wt && existsSync(wt.worktreeAbs)
        ? wt.worktreeAbs
        : wt && existsSync(wt.primaryAbs)
          ? wt.primaryAbs
          : undefined;

    try {
      let view: GhPrView | null = null;
      if (entry.url) {
        view = ghJson(
          [
            'pr',
            'view',
            entry.url,
            '--json',
            'state,mergedAt,number,url',
          ],
          cwd,
        ) as GhPrView;
      } else if (entry.branch) {
        const list = ghJson(
          [
            'pr',
            'list',
            '--head',
            entry.branch,
            '--base',
            entry.base || 'main',
            '--state',
            'all',
            '--json',
            'state,mergedAt,number,url',
            '--limit',
            '1',
          ],
          cwd,
        ) as GhPrView[];
        view = Array.isArray(list) && list[0] ? list[0] : null;
        if (!view) {
          entry.ghError = 'no PR found for branch';
          entry.checkedAt = nowIso();
          out.push(entry);
          log(`${entry.repo}: no PR for ${entry.branch}`, 'warn');
          continue;
        }
      } else {
        out.push(entry);
        continue;
      }

      applyGhView(entry, view || {});
      log(
        `${entry.repo}: ${entry.ghState ?? 'unknown'}${entry.url ? ` ${entry.url}` : ''}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entry.ghError = msg.slice(0, 500);
      entry.checkedAt = nowIso();
      log(`${entry.repo}: refresh failed — ${entry.ghError}`, 'error');
    }
    out.push(entry);
  }

  return out;
}

/** True if any PR row can be polled on GitHub. */
export function hasTrackablePrs(prs: CreatePrResult[] | undefined): boolean {
  return (prs || []).some(
    (p) =>
      Boolean(p.url) || p.status === 'created' || p.status === 'existing',
  );
}

/**
 * For each worktree with commits: commit any dirty tree, push branch, create GitHub PR via `gh`.
 * Requires `gh` auth and network on the host (outside agent sandbox).
 */
export function createPullRequestsForWorktrees(opts: {
  bindings: WorktreeBinding[];
  batchId: string;
  title: string;
  body: string;
  onLog?: (line: string, level?: 'info' | 'warn' | 'error') => void;
}): CreatePrResult[] {
  const log = opts.onLog ?? (() => undefined);
  const results: CreatePrResult[] = [];

  for (const b of opts.bindings) {
    const base = resolveBaseRef(b.primaryAbs);
    const entry: CreatePrResult = {
      repo: b.repo,
      branch: b.branch,
      base,
      status: 'failed',
    };

    try {
      if (!existsSync(b.worktreeAbs) || !isGitRepo(b.worktreeAbs)) {
        entry.error = 'worktree missing';
        entry.status = 'failed';
        results.push(entry);
        log(`${b.repo}: worktree missing`, 'error');
        continue;
      }

      // Commit leftover dirty changes so the PR includes agent edits
      const dirty = git(b.worktreeAbs, ['status', '--porcelain']);
      if (dirty.trim()) {
        log(`${b.repo}: committing dirty worktree…`);
        git(b.worktreeAbs, ['add', '-A']);
        try {
          execFileSync(
            'git',
            [
              'commit',
              '-m',
              `fix: ${opts.title.slice(0, 72)}\n\nBatch ${opts.batchId} via defect-drainer`,
            ],
            {
              cwd: b.worktreeAbs,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              env: {
                ...process.env,
                // PR commits show as DefectDrainer (override with GIT_AUTHOR_* if needed)
                GIT_AUTHOR_NAME:
                  process.env.DEFECT_DRAINER_GIT_NAME ||
                  process.env.GIT_AUTHOR_NAME ||
                  'DefectDrainer',
                GIT_AUTHOR_EMAIL:
                  process.env.DEFECT_DRAINER_GIT_EMAIL ||
                  process.env.GIT_AUTHOR_EMAIL ||
                  'defect-drainer@local',
                GIT_COMMITTER_NAME:
                  process.env.DEFECT_DRAINER_GIT_NAME ||
                  process.env.GIT_COMMITTER_NAME ||
                  'DefectDrainer',
                GIT_COMMITTER_EMAIL:
                  process.env.DEFECT_DRAINER_GIT_EMAIL ||
                  process.env.GIT_COMMITTER_EMAIL ||
                  'defect-drainer@local',
              },
            },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // empty commit after add is fine to skip
          if (!/nothing to commit/i.test(msg)) {
            throw err;
          }
        }
      }

      let commits = 0;
      try {
        commits = Number(
          git(b.worktreeAbs, ['rev-list', '--count', `${base}..HEAD`]),
        );
      } catch {
        commits = Number(
          git(b.worktreeAbs, ['rev-list', '--count', `origin/${base}..HEAD`]),
        );
      }
      entry.commits = commits;
      if (!commits) {
        entry.status = 'skipped';
        entry.error = 'no commits ahead of base';
        results.push(entry);
        log(`${b.repo}: skip — no commits vs ${base}`, 'warn');
        continue;
      }

      log(`${b.repo}: pushing ${b.branch} (${commits} commit(s))…`);
      git(b.worktreeAbs, ['push', '-u', 'origin', `HEAD:${b.branch}`]);

      // Existing PR?
      try {
        const existing = execFileSync(
          'gh',
          [
            'pr',
            'list',
            '--head',
            b.branch,
            '--base',
            base,
            '--json',
            'url,number,state',
            '--limit',
            '1',
          ],
          {
            cwd: b.worktreeAbs,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ).trim();
        const list = JSON.parse(existing || '[]') as Array<{
          url?: string;
          number?: number;
          state?: string;
        }>;
        if (list[0]?.url) {
          entry.status = 'existing';
          entry.url = list[0].url;
          if (typeof list[0].number === 'number') {
            entry.ghNumber = list[0].number;
          }
          entry.ghState = mapGithubPrState(list[0].state) ?? 'open';
          entry.checkedAt = nowIso();
          results.push(entry);
          log(`${b.repo}: PR already exists ${entry.url}`);
          continue;
        }
      } catch {
        /* list failed — try create */
      }

      log(`${b.repo}: creating PR → ${base}…`);
      const url = execFileSync(
        'gh',
        [
          'pr',
          'create',
          '--base',
          base,
          '--head',
          b.branch,
          '--title',
          opts.title.slice(0, 200),
          '--body',
          opts.body,
        ],
        {
          cwd: b.worktreeAbs,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .pop();

      entry.status = 'created';
      entry.url = url;
      entry.ghState = 'open';
      entry.checkedAt = nowIso();
      results.push(entry);
      log(`${b.repo}: PR created ${url}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entry.status = 'failed';
      entry.error = msg.slice(0, 500);
      results.push(entry);
      log(`${b.repo}: PR failed — ${entry.error}`, 'error');
    }
  }

  return results;
}

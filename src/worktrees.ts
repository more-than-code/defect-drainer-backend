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

/** Per-app base: worktrees branch from `<remote>/<branch>`; PRs target `branch`. */
export type BaseConfig = { remote: string; branch: string };

export type BaseRef = {
  /** What to branch the worktree from, e.g. `origin/main`. */
  ref: string;
  /** Bare branch name for `gh pr create --base`, e.g. `main`. */
  branch: string;
  resolvedFrom: 'remote' | 'local' | 'master' | 'head';
};

export const DEFAULT_BASE: BaseConfig = { remote: 'origin', branch: 'main' };

/** Sentinel `base_remote`: use the local checkout branch, not a remote-tracking ref. */
export const LOCAL_BASE_REMOTE = 'local';

export function isLocalBaseRemote(remote: string | undefined): boolean {
  return (remote || '').trim().toLowerCase() === LOCAL_BASE_REMOTE;
}

function refExists(primaryAbs: string, ref: string): boolean {
  try {
    git(primaryAbs, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remote-first so a stale local branch can't silently become the base:
 * `<remote>/<branch>` → local `<branch>` → `master` (only when branch is the
 * default `main`, so existing master repos keep working) → `HEAD`.
 */
export function resolveBaseRef(
  primaryAbs: string,
  base: BaseConfig = DEFAULT_BASE,
): BaseRef {
  const remote = base.remote || DEFAULT_BASE.remote;
  const branch = base.branch || DEFAULT_BASE.branch;

  if (isLocalBaseRemote(remote)) {
    if (refExists(primaryAbs, branch)) {
      return { ref: branch, branch, resolvedFrom: 'local' };
    }
    return { ref: 'HEAD', branch, resolvedFrom: 'head' };
  }

  const remoteRef = `${remote}/${branch}`;
  if (refExists(primaryAbs, remoteRef)) {
    return { ref: remoteRef, branch, resolvedFrom: 'remote' };
  }
  if (refExists(primaryAbs, branch)) {
    return { ref: branch, branch, resolvedFrom: 'local' };
  }
  if (branch === DEFAULT_BASE.branch && refExists(primaryAbs, 'master')) {
    return { ref: 'master', branch: 'master', resolvedFrom: 'master' };
  }
  return { ref: 'HEAD', branch, resolvedFrom: 'head' };
}

/**
 * Best-effort refresh of `<remote>/<branch>` before it is used as a base.
 * Updates remote-tracking refs only — never the working tree or local branches.
 * Swallows failure (offline, no remote) so batch fixes still run.
 */
export function fetchBaseRef(primaryAbs: string, base: BaseConfig): boolean {
  if (isLocalBaseRemote(base.remote)) return false;
  try {
    git(primaryAbs, ['fetch', base.remote, base.branch]);
    return true;
  } catch {
    return false;
  }
}

/**
 * List branch names on a GitHub remote or a local checkout.
 * Used by Settings to populate the per-repo base-branch dropdown.
 */
export function listRepoBranches(opts: {
  source: 'origin' | 'local';
  location: string;
}): { branches: string[]; current?: string } {
  const location = opts.location.trim();
  if (!location) throw new Error('location is required');

  if (opts.source === 'local') {
    if (!path.isAbsolute(location)) {
      throw new Error('local checkout must be an absolute path');
    }
    if (location.includes('\0')) throw new Error('invalid path');
    const abs = path.resolve(location);
    if (!existsSync(abs)) throw new Error(`path not found: ${abs}`);
    if (!isGitRepo(abs)) throw new Error(`not a git repo: ${abs}`);
    const branches = git(abs, [
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads',
    ])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    let current: string | undefined;
    try {
      current = git(abs, ['branch', '--show-current']) || undefined;
    } catch {
      current = undefined;
    }
    return { branches, current };
  }

  const { url } = parseGitRepoUrl(location);
  let raw = '';
  try {
    raw = execFileSync('git', ['ls-remote', '--heads', url], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git ls-remote failed: ${msg}`);
  }
  const branches: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const m = line.match(/refs\/heads\/(\S+)\s*$/);
    if (!m?.[1] || seen.has(m[1])) continue;
    seen.add(m[1]);
    branches.push(m[1]);
  }
  return { branches };
}

export function parseOsascriptFolderPath(stdout: string): string {
  const p = stdout.trim().replace(/\/+$/, '');
  if (!p || p.includes('\0')) throw new Error('invalid folder path');
  const abs = path.resolve(p);
  if (!path.isAbsolute(abs)) throw new Error('invalid folder path');
  return abs;
}

export function isOsascriptUserCancel(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('-128') || /user canceled/i.test(msg);
}

/**
 * Open the host Finder folder picker (macOS only).
 * Blocks until the operator chooses or cancels. No user-controlled script text.
 */
export function chooseLocalFolder(): { path?: string; cancelled?: boolean } {
  if (process.platform !== 'darwin') {
    throw new Error('Finder folder picker is only available on macOS');
  }
  try {
    const raw = execFileSync(
      'osascript',
      [
        '-e',
        'POSIX path of (choose folder with prompt "Select a local git checkout")',
      ],
      {
        encoding: 'utf8',
        timeout: 300_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { path: parseOsascriptFolderPath(raw) };
  } catch (err) {
    if (isOsascriptUserCancel(err)) return { cancelled: true };
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Finder picker failed: ${msg}`);
  }
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
  /** Per-app base (default origin/main). Overridden by baseByRepo. */
  base?: BaseConfig;
  /** Per-repo base when sources differ. */
  baseByRepo?: Record<string, BaseConfig>;
  /** Refresh the remote-tracking ref first (workspace primaries aren't fetched elsewhere). */
  fetchFirst?: boolean;
  onLog?: (line: string, level?: 'info' | 'warn' | 'error') => void;
}): WorktreeBinding[] {
  const log = opts.onLog ?? (() => undefined);
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

    const baseCfg = opts.baseByRepo?.[repo] ?? opts.base ?? DEFAULT_BASE;
    if (opts.fetchFirst || !isLocalBaseRemote(baseCfg.remote)) {
      const ok = fetchBaseRef(primaryAbs, baseCfg);
      log(
        ok
          ? `${repo}: fetched ${baseCfg.remote}/${baseCfg.branch}`
          : `${repo}: fetch of ${baseCfg.remote}/${baseCfg.branch} failed — using refs on disk`,
        ok ? 'info' : 'warn',
      );
    }
    const base = resolveBaseRef(primaryAbs, baseCfg);
    // A fallback means we are NOT on the configured remote base — say so loudly.
    log(
      `${repo}: base ${base.ref} (${base.resolvedFrom}), PR target ${base.branch}`,
      base.resolvedFrom === 'remote' ? 'info' : 'warn',
    );
    try {
      git(primaryAbs, [
        'worktree',
        'add',
        '-b',
        branch,
        worktreeAbs,
        base.ref,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // roll back any worktrees already created in this batch
      removeBatchWorktrees(bindings);
      throw new Error(
        `git worktree add failed for ${repo} (base=${base.ref}, branch=${branch}): ${msg}`,
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
  /** Per-app base (default origin/main). Must match what the worktree was created from. */
  base?: BaseConfig;
  /** Per-repo base when sources differ. */
  baseByRepo?: Record<string, BaseConfig>;
  onLog?: (line: string, level?: 'info' | 'warn' | 'error') => void;
}): CreatePrResult[] {
  const log = opts.onLog ?? (() => undefined);
  const results: CreatePrResult[] = [];

  for (const b of opts.bindings) {
    const resolved = resolveBaseRef(
      b.primaryAbs,
      opts.baseByRepo?.[b.repo] ?? opts.base ?? DEFAULT_BASE,
    );
    // `gh --base` takes a branch name; ref comparisons take the resolved ref.
    const base = resolved.branch;
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

      // resolved.ref is already remote-qualified when it came from the remote,
      // so never prefix it again (that produced `origin/origin/main`).
      let commits = 0;
      try {
        commits = Number(
          git(b.worktreeAbs, ['rev-list', '--count', `${resolved.ref}..HEAD`]),
        );
      } catch {
        commits = Number(
          git(b.worktreeAbs, ['rev-list', '--count', `${base}..HEAD`]),
        );
      }
      entry.commits = commits;
      if (!commits) {
        entry.status = 'skipped';
        entry.error = 'no commits ahead of base';
        results.push(entry);
        log(`${b.repo}: skip — no commits vs ${resolved.ref}`, 'warn');
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

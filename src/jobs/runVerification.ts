import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { AppRepoEntry, VerifyCommand } from '../apps.js';
import type { WorktreeBinding } from '../worktrees.js';

/**
 * Re-run the app's verification commands after a fix job and gate resolution on
 * the result.
 *
 * Why this exists: harvest used to resolve a defect because an image file was
 * present, and the agent's own claims ("6 tests passed") were accepted as prose.
 * Observed 2026-08-17 — a P1 was marked resolved off widget-test renders with
 * the project's real gate never run.
 *
 * The commands are OPERATOR-authored (App Settings), never agent-authored: this
 * runner is not sandboxed, so executing strings written by the coding agent
 * would hand it unsandboxed execution on the host.
 */

export type VerifyResult = {
  repo: string;
  command: string;
  cwd: string;
  /** null when the process was killed (timeout / signal). */
  exit_code: number | null;
  signal: string | null;
  ok: boolean;
  duration_ms: number;
  /** Last lines of combined output — enough to see the failure, not a firehose. */
  output_tail: string;
  skipped_reason?: string;
};

export type VerificationRun = {
  ran: boolean;
  ok: boolean;
  results: VerifyResult[];
  startedAt: string;
  finishedAt: string;
};

/** Repo leaf of a git URL or path: ".../ttd-webapp.git" -> "ttd-webapp". */
function repoLeaf(url: string | undefined): string {
  if (!url) return '';
  return (
    url
      .replace(/\/+$/, '')
      .split('/')
      .pop()
      ?.replace(/\.git$/i, '') ?? ''
  );
}

/**
 * Names that legitimately refer to one worktree.
 *
 * A binding is named by the app's repo ENTRY name on the entries path
 * ("webapp") but by the git URL LEAF on the repo_urls path ("ttd-webapp"), so a
 * verify row configured with either must still match — otherwise the command is
 * silently skipped, which counts as a failure and blocks every resolve.
 */
export function bindingAliases(
  b: WorktreeBinding,
  entries: AppRepoEntry[] = [],
): Set<string> {
  const names = new Set<string>();
  const add = (v: string | undefined) => {
    const t = (v ?? '').trim().toLowerCase();
    if (t) names.add(t);
  };
  add(b.repo);
  add(repoLeaf(b.repoUrl));
  add(path.basename(b.worktreeAbs || ''));
  // Cross-walk through the app's own entry->url mapping; never by substring.
  for (const e of entries) {
    const leaf = repoLeaf(e.url);
    if (
      e.name.trim().toLowerCase() === b.repo.trim().toLowerCase() ||
      (leaf && leaf.toLowerCase() === repoLeaf(b.repoUrl).toLowerCase()) ||
      (leaf && leaf.toLowerCase() === b.repo.trim().toLowerCase())
    ) {
      add(e.name);
      add(leaf);
    }
  }
  return names;
}

const TIMEOUT_MS = 20 * 60 * 1000;
const TAIL_CHARS = 4000;

function tail(s: string): string {
  const t = s.replace(/\r\n/g, '\n').trimEnd();
  return t.length <= TAIL_CHARS ? t : `…\n${t.slice(-TAIL_CHARS)}`;
}

/**
 * Run every command in its worktree. Always returns a record — a command whose
 * repo has no worktree is reported as skipped, not silently dropped.
 */
export function runVerification(opts: {
  commands: VerifyCommand[];
  worktrees: WorktreeBinding[];
  handoffAbs: string;
  /** App repo entries, so a row named "webapp" matches binding "ttd-webapp". */
  repoEntries?: AppRepoEntry[];
  /** Env from a provisioned toolchain, so `flutter`/`dart` resolve. */
  extraEnv?: Record<string, string>;
  onLog: (line: string, level?: 'info' | 'warn' | 'error') => void;
}): VerificationRun {
  const { commands, worktrees, handoffAbs, repoEntries, extraEnv, onLog } = opts;
  const startedAt = new Date().toISOString();
  const results: VerifyResult[] = [];

  for (const entry of commands) {
    const target = entry.repo.trim().toLowerCase();
    const wt = worktrees.find((w) =>
      bindingAliases(w, repoEntries ?? []).has(target),
    );
    if (!wt || !existsSync(wt.worktreeAbs)) {
      const reason = wt
        ? `worktree path missing: ${wt.worktreeAbs}`
        : `no worktree for repo "${entry.repo}" in this job (have: ${
            worktrees.map((w) => w.repo).join(', ') || 'none'
          })`;
      onLog(`verify: SKIP ${entry.repo} — ${reason}`, 'warn');
      results.push({
        repo: entry.repo,
        command: entry.command,
        cwd: wt?.worktreeAbs ?? '',
        exit_code: null,
        signal: null,
        // A command that could not run must not count as a pass.
        ok: false,
        duration_ms: 0,
        output_tail: '',
        skipped_reason: reason,
      });
      continue;
    }

    onLog(`verify: ${entry.repo} $ ${entry.command}`);
    const started = Date.now();
    const proc = spawnSync(entry.command, {
      cwd: wt.worktreeAbs,
      shell: true,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      env: { ...process.env, CI: '1', ...(extraEnv ?? {}) },
      maxBuffer: 32 * 1024 * 1024,
    });
    const duration_ms = Date.now() - started;
    const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
    const signal = proc.signal ? String(proc.signal) : null;
    const ok = proc.status === 0 && !signal;
    results.push({
      repo: entry.repo,
      command: entry.command,
      cwd: wt.worktreeAbs,
      exit_code: proc.status,
      signal,
      ok,
      duration_ms,
      output_tail: tail(out),
    });
    onLog(
      `verify: ${ok ? 'PASS' : 'FAIL'} ${entry.repo} (exit=${proc.status ?? 'killed'}${
        signal ? ` signal=${signal}` : ''
      }, ${(duration_ms / 1000).toFixed(1)}s)`,
      ok ? 'info' : 'warn',
    );
  }

  const run: VerificationRun = {
    ran: results.length > 0,
    ok: results.length > 0 && results.every((r) => r.ok),
    results,
    startedAt,
    finishedAt: new Date().toISOString(),
  };

  try {
    mkdirSync(handoffAbs, { recursive: true });
    writeFileSync(
      path.join(handoffAbs, 'verify.json'),
      `${JSON.stringify(run, null, 2)}\n`,
      'utf8',
    );
  } catch {
    /* evidence file is a convenience; the run record is on the job */
  }

  return run;
}

/** One-line summary for the job log / defect note. */
export function summarizeVerification(run: VerificationRun): string {
  if (!run.ran) return 'no verification commands configured';
  const pass = run.results.filter((r) => r.ok).length;
  const failed = run.results.filter((r) => !r.ok);
  const detail = failed
    .map((r) => `${r.repo}: ${r.skipped_reason ?? `exit ${r.exit_code ?? 'killed'}`}`)
    .join('; ');
  return `${pass}/${run.results.length} verification command(s) passed${
    detail ? ` — ${detail}` : ''
  }`;
}

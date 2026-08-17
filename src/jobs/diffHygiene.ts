import { execFileSync } from 'node:child_process';

import type { WorktreeBinding } from '../worktrees.js';

/**
 * Measure how much of a fix job's diff is reformatting rather than change.
 *
 * A 2026-08-17 fix changed 523 lines across 82 hunks, of which 34 hunks and
 * 146 lines were pure `dart format` reflow of code the fix never needed to
 * touch — the real change was buried in noise, and nothing surfaced it.
 *
 * Advisory only: reformatting is messy, not wrong, so this never blocks a
 * resolve. It is recorded on the job so a reviewer sees it before reading the
 * diff.
 */

export type RepoDiffHygiene = {
  repo: string;
  /** Base commit the worktree sat at before the agent ran. */
  baseSha: string;
  filesChanged: number;
  /** Lines added+removed, whitespace included. */
  changedLines: number;
  /** Changed lines outside pure-reflow hunks — the substantive change. */
  effectiveLines: number;
  /** Lines in hunks whose content is identical once whitespace is stripped. */
  formattingOnlyLines: number;
  hunks: number;
  effectiveHunks: number;
  /** Hunks that only moved code around without changing it. */
  formattingOnlyHunks: number;
  /** formattingOnlyLines / changedLines, 0 when nothing changed. */
  formattingRatio: number;
  error?: string;
};

export type DiffHygieneReport = {
  repos: RepoDiffHygiene[];
  /** True when any repo crossed the noise threshold. */
  noisy: boolean;
};

/** Flag only diffs big enough for the noise to matter. */
const MIN_LINES = 40;
const NOISY_RATIO = 0.25;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Current commit of a worktree, for use as the later diff base. */
export function worktreeHead(worktreeAbs: string): string {
  try {
    return git(worktreeAbs, ['rev-parse', 'HEAD']).trim();
  } catch {
    return '';
  }
}

/**
 * A hunk is pure reflow when its removed and added text are identical once all
 * whitespace is stripped — i.e. the code is the same, only its layout moved.
 *
 * `git diff -w` cannot detect this: it compares line by line, so a formatter
 * joining three lines into one still reads as three deletions and one addition.
 * Measured against a real case, `-w` saw 14% of the churn; this sees 41% of
 * hunks, matching what the diff actually contains.
 */
export type DiffHunk = {
  file: string;
  header: string;
  removed: string[];
  added: string[];
  /** Same code, different layout. */
  reflow: boolean;
};

const stripAll = (ls: string[]) => ls.join('').replace(/\s+/gu, '');

function parseHunks(diff: string): DiffHunk[] {
  const out: DiffHunk[] = [];
  let file = '';
  let cur: DiffHunk | null = null;
  const flush = () => {
    if (cur && (cur.added.length || cur.removed.length)) {
      cur.reflow = stripAll(cur.added) === stripAll(cur.removed);
      out.push(cur);
    }
    cur = null;
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      flush();
      cur = { file, header: line, removed: [], added: [], reflow: false };
      continue;
    }
    // Header lines, not content — `--- a/x` would otherwise read as a deletion.
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      const m = line.match(/^\+\+\+ b\/(.+)$/);
      if (m?.[1]) file = m[1];
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+')) cur.added.push(line.slice(1));
    else if (line.startsWith('-')) cur.removed.push(line.slice(1));
  }
  flush();
  return out;
}

function analyseDiff(diff: string): {
  hunks: number;
  reflowHunks: number;
  changedLines: number;
  reflowLines: number;
  files: Set<string>;
} {
  const parsed = parseHunks(diff);
  const files = new Set(parsed.map((h) => h.file).filter(Boolean));
  let hunks = 0;
  let reflowHunks = 0;
  let changedLines = 0;
  let reflowLines = 0;
  for (const h of parsed) {
    const n = h.added.length + h.removed.length;
    hunks += 1;
    changedLines += n;
    if (h.reflow) {
      reflowHunks += 1;
      reflowLines += n;
    }
  }
  return { hunks, reflowHunks, changedLines, reflowLines, files };
}

/**
 * The actual hunks behind the numbers, for the console's drill-down.
 * Computed on demand from the worktree — diffs are not stored on the job.
 */
export function collectHunks(opts: {
  worktreeAbs: string;
  baseSha: string;
  /** 'reflow' = layout-only hunks; 'all' = everything. */
  kind: 'reflow' | 'all';
  limit?: number;
}): { hunks: DiffHunk[]; total: number; truncated: boolean } {
  const limit = opts.limit ?? 200;
  const diff = git(opts.worktreeAbs, ['diff', '--unified=0', opts.baseSha]);
  const all = parseHunks(diff);
  const picked = opts.kind === 'reflow' ? all.filter((h) => h.reflow) : all;
  return {
    hunks: picked.slice(0, limit),
    total: picked.length,
    truncated: picked.length > limit,
  };
}

export function measureDiffHygiene(opts: {
  worktrees: WorktreeBinding[];
  /** repo -> commit the worktree was at before the agent ran. */
  baseByRepo: Record<string, string>;
  onLog: (line: string, level?: 'info' | 'warn' | 'error') => void;
}): DiffHygieneReport {
  const repos: RepoDiffHygiene[] = [];

  for (const w of opts.worktrees) {
    const baseSha = opts.baseByRepo[w.repo] ?? '';
    const blank: RepoDiffHygiene = {
      repo: w.repo,
      baseSha,
      filesChanged: 0,
      changedLines: 0,
      effectiveLines: 0,
      formattingOnlyLines: 0,
      hunks: 0,
      effectiveHunks: 0,
      formattingOnlyHunks: 0,
      formattingRatio: 0,
    };
    if (!baseSha) {
      repos.push({ ...blank, error: 'no base commit recorded for this worktree' });
      continue;
    }
    try {
      // Diff against the recorded base so committed and uncommitted work both
      // count — agents differ in whether they commit. unified=0 keeps hunks
      // tight so a reflow hunk is not diluted by context lines.
      const diff = git(w.worktreeAbs, ['diff', '--unified=0', baseSha]);
      const a = analyseDiff(diff);
      const entry: RepoDiffHygiene = {
        repo: w.repo,
        baseSha,
        filesChanged: a.files.size,
        changedLines: a.changedLines,
        effectiveLines: a.changedLines - a.reflowLines,
        formattingOnlyLines: a.reflowLines,
        hunks: a.hunks,
        effectiveHunks: a.hunks - a.reflowHunks,
        formattingOnlyHunks: a.reflowHunks,
        formattingRatio: a.changedLines ? a.reflowLines / a.changedLines : 0,
      };
      repos.push(entry);

      if (entry.changedLines >= MIN_LINES && entry.formattingRatio >= NOISY_RATIO) {
        opts.onLog(
          `diff hygiene: ${w.repo} — ${entry.formattingOnlyLines}/${entry.changedLines} changed lines are reformatting only ` +
            `(${entry.formattingOnlyHunks}/${entry.hunks} hunks). Reformatting untouched code buries the real change.`,
          'warn',
        );
      } else if (entry.changedLines) {
        opts.onLog(
          `diff hygiene: ${w.repo} — ${entry.changedLines} line(s) across ${entry.filesChanged} file(s), ${entry.formattingOnlyLines} reformatting only`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      repos.push({ ...blank, error: msg });
      opts.onLog(`diff hygiene: ${w.repo} — could not measure (${msg})`, 'warn');
    }
  }

  return {
    repos,
    noisy: repos.some(
      (r) => r.changedLines >= MIN_LINES && r.formattingRatio >= NOISY_RATIO,
    ),
  };
}

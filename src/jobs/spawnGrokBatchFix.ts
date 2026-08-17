import { spawn, type ChildProcess } from 'node:child_process';
import type { GrokSandboxProfile } from '../apps.js';
import { envDrainer, envDrainerFlag } from '../env.js';
import type { WorktreeBinding } from '../worktrees.js';
import { resolveGrokBuildBin } from './spawnGrokNormalize.js';

export type LogSource = 'DefectDrainer' | 'Grok';

export type SpawnGrokBatchFixOpts = {
  handoffAbs: string;
  batchId: string;
  defectsRoot: string;
  worktrees: WorktreeBinding[];
  /** From App Settings (strict | workspace) */
  sandbox: GrokSandboxProfile;
  /** Pre-provisioned toolchain: prompt lines + env merged into the child. */
  toolchainNotes?: string[];
  toolchainEnv?: Record<string, string>;
  /** Job-scoped custom sandbox profile name (see sandboxProfile.ts). */
  sandboxProfile?: string;
  /** Operator verification commands DD re-runs after this session exits. */
  verifyCommands?: Array<{ repo: string; command: string }>;
  onLog: (
    line: string,
    level?: 'info' | 'warn' | 'error',
    source?: LogSource,
  ) => void;
};

export type SpawnGrokBatchFixHandle = {
  promise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** SIGTERM then SIGKILL after grace; no-op if already exited */
  kill: () => void;
  pid: number | undefined;
};

export function buildBatchFixCliPrompt(input: {
  batchId: string;
  handoffAbs: string;
  defectsRoot: string;
  worktrees: WorktreeBinding[];
  sandbox: GrokSandboxProfile;
  toolchainNotes?: string[];
  verifyCommands?: Array<{ repo: string; command: string }>;
}): string {
  const wtLines = input.worktrees.length
    ? input.worktrees.map(
        (w) =>
          `- ${w.repo}: EDIT ONLY ${w.worktreeAbs} (branch ${w.branch}); NEVER ${w.primaryAbs}`,
      )
    : ['- (none — do not edit product code)'];

  const sandboxNotes =
    input.sandbox === 'workspace'
      ? [
          `SANDBOX: --sandbox workspace (App Settings).`,
          `- Read: host filesystem (iOS Simulator, Xcode, simctl data allowed).`,
          `- Write: cwd (${input.handoffAbs}), ~/.grok/, and temp only.`,
          `- Product code: edit only under cwd/worktrees/…`,
          `- Visual check / fix screenshots: capture under cwd/fix-evidence/<DEF-id>/fix-01.png (handoff-writable).`,
          `- Inventory root ${input.defectsRoot} is readable — open report + **historical fix evidence** paths listed in BRIEF.md.`,
        ]
      : [
          `SANDBOX: --sandbox strict / restrict (App Settings).`,
          `- Read: cwd + system paths only (no ~/Library Simulator data).`,
          `- Write: cwd (${input.handoffAbs}), ~/.grok/, and temp.`,
          `- Product code: edit only under cwd/worktrees/…`,
          `- Historical fix evidence may be unreadable under strict if paths are outside cwd — prefer workspace sandbox for visual history.`,
          `- Inventory updates under ${input.defectsRoot} may be blocked; write new proof to handoff fix-evidence/.`,
        ];

  return [
    `Batch defect fix session for ${input.batchId}.`,
    `Handoff directory (cwd): ${input.handoffAbs}`,
    `Inventory root: ${input.defectsRoot}`,
    ``,
    ...sandboxNotes,
    ...(input.toolchainNotes?.length ? ['', ...input.toolchainNotes] : []),
    ...(input.verifyCommands?.length
      ? [
          ``,
          `VERIFICATION (run by Defect Drainer after you exit — not by you, and not editable):`,
          ...input.verifyCommands.map(
            (v) => `- ${v.repo}: ${v.command}`,
          ),
          `- Every one must exit 0 or NOTHING resolves, however good your screenshots are.`,
          `- Run them yourself in the worktree before claiming DONE; fix what fails.`,
          `- Do not report test results you did not actually observe.`,
        ]
      : []),
    ``,
    `WORKTREE ENFORCEMENT (mandatory):`,
    ...wtLines,
    `- Product edits outside listed worktree paths are forbidden.`,
    `- Do not checkout branches on primary trees. Do not run git commands in primaryAbs.`,
    ``,
    `Read BRIEF.md first. For each defect it lists:`,
    `- report evidence (bug as reported)`,
    `- historical fix evidence (prior proof on the defect SSOT — use as context / regression baseline)`,
    `- what to deliver this run under handoff fix-evidence/ and fix-notes/`,
    ``,
    `TASK:`,
    `1. For each defect: read report + historical fix evidence from BRIEF paths; implement fixes only under worktree paths.`,
    `2. Verify (tests / smoke / visual) inside the worktree checkout; compare to historical fix shots when present.`,
    `3. REQUIRED **new** deliverables under this cwd (backend harvests onto the defect):`,
    `   - fix-evidence/<DEF-id>/fix-01.png (and more images as needed)`,
    `   - fix-notes/<DEF-id>.md  (what changed + how verified; note relation to prior fix if any)`,
    `4. Visual check when sandbox=workspace: Simulator / app screenshots into fix-evidence/.`,
    `5. Do not claim DONE without those **handoff** files for each fixed defect (historical inventory files alone are not enough for this run).`,
    `6. Reply: DONE ${input.batchId}`,
  ].join('\n');
}

/**
 * Spawn Grok for batch fix. Caller MUST have created worktrees first;
 * empty worktrees is a hard error (fail-closed).
 * Returns a handle so the runner can stop the child from the web UI.
 */
export function spawnGrokBatchFix(
  opts: SpawnGrokBatchFixOpts,
): SpawnGrokBatchFixHandle {
  if (!opts.worktrees.length) {
    throw new Error('refusing to spawn agent batch fix without worktrees');
  }

  const sandbox = opts.sandbox === 'workspace' ? 'workspace' : 'strict';
  // A job-scoped profile extends the built-in one; the prompt still describes
  // the base profile's rules, which the custom profile only widens.
  const sandboxArg = opts.sandboxProfile || sandbox;
  const bin = resolveGrokBuildBin();
  const maxTurns = envDrainer('GROK_BATCH_MAX_TURNS') ?? '80';
  const prompt = buildBatchFixCliPrompt({
    batchId: opts.batchId,
    handoffAbs: opts.handoffAbs,
    defectsRoot: opts.defectsRoot,
    worktrees: opts.worktrees,
    sandbox,
    toolchainNotes: opts.toolchainNotes,
    verifyCommands: opts.verifyCommands,
  });

  const args = [
    '-p',
    prompt,
    '--cwd',
    opts.handoffAbs,
    '--sandbox',
    sandboxArg,
    '--always-approve',
    '--max-turns',
    maxTurns,
    '--output-format',
    'plain',
    '--verbatim',
  ];

  if (envDrainerFlag('GROK_BYPASS_PERMISSIONS')) {
    args.push('--permission-mode', 'bypassPermissions');
  }

  const tools = envDrainer('GROK_TOOLS')?.trim();
  if (tools) args.push('--tools', tools);

  opts.onLog(
    `spawning batch fix: ${bin} — ${opts.batchId} sandbox=${sandbox} cwd=${opts.handoffAbs} (${opts.worktrees.length} worktree(s))`,
    'info',
    'DefectDrainer',
  );
  for (const w of opts.worktrees) {
    opts.onLog(
      `worktree ${w.repo} → ${w.worktreeAbs} (${w.branch})`,
      'info',
      'DefectDrainer',
    );
  }

  let child: ChildProcess | null = null;
  let childPid: number | undefined;
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Coalesce Grok stream chunks into complete blocks for the web UI.
   * Do not log token/word fragments — only flush on idle gap, size cap, or process end.
   * All process stdout/stderr is tagged source=Grok.
   */
  const makeBlockLogger = (level: 'info' | 'warn') => {
    let buf = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const IDLE_MS = 450;
    const MAX_BLOCK = 24_000;

    const flush = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const text = buf.replace(/\s+$/u, '');
      buf = '';
      if (!text.trim()) return;
      opts.onLog(text, level, 'Grok');
    };

    return {
      push(chunk: Buffer) {
        // Normalize terminal CR so partial redraws don't fragment oddly
        buf += chunk.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (buf.length >= MAX_BLOCK) {
          flush();
          return;
        }
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, IDLE_MS);
      },
      flush,
    };
  };

  const outLog = makeBlockLogger('info');
  const errLog = makeBlockLogger('warn');

  const promise = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child = spawn(bin, args, {
      cwd: opts.handoffAbs,
      env: {
        ...process.env,
        CI: process.env.CI ?? '1',
        GROK_SANDBOX: sandboxArg,
        ...(opts.toolchainEnv ?? {}),
        DEFECT_DRAINER_WORKTREES: opts.worktrees
          .map((w) => w.worktreeAbs)
          .join(':'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    childPid = child.pid;

    child.stdout?.on('data', (c: Buffer) => outLog.push(c));
    child.stderr?.on('data', (c: Buffer) => errLog.push(c));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      outLog.flush();
      errLog.flush();
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      // Final complete blocks only — no leftover stream fragments
      outLog.flush();
      errLog.flush();
      resolve({ code, signal });
    });
  });

  const kill = () => {
    if (!child || settled || child.killed) return;
    opts.onLog(
      'stop requested — sending SIGTERM to agent process',
      'warn',
      'DefectDrainer',
    );
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    killTimer = setTimeout(() => {
      if (!child || settled) return;
      opts.onLog('Agent still running — SIGKILL', 'warn', 'DefectDrainer');
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 3000);
  };

  return {
    promise,
    kill,
    pid: childPid,
  };
}

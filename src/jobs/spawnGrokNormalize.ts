import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { GrokSandboxProfile } from '../apps.js';
import { envDrainer, envDrainerFlag } from '../env.js';

export type SpawnGrokNormalizeOpts = {
  handoffAbs: string;
  jobId: string;
  defectId: string;
  /** From App Settings (strict | workspace); default strict */
  sandbox?: GrokSandboxProfile;
  onLog: (line: string, level?: 'info' | 'warn' | 'error') => void;
};

/**
 * Resolve Grok Build CLI binary (env override or common Homebrew paths).
 */
export function resolveGrokBuildBin(): string {
  const candidates = [
    process.env.GROK_BUILD_BIN,
    envDrainer('GROK_BIN'),
    process.env.SKETCH_FORGE_GROK_BIN,
    '/opt/homebrew/bin/grok',
    '/opt/homebrew/Caskroom/grok-build/0.2.102/grok-0.2.102-macos-aarch64',
    'grok',
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (c === 'grok') return c;
    if (existsSync(c)) return c;
  }
  return candidates[0] ?? 'grok';
}

export function buildNormalizeCliPrompt(input: {
  jobId: string;
  defectId: string;
  handoffAbs: string;
}): string {
  return [
    `Defect inventory normalization job ${input.jobId} for id "${input.defectId}".`,
    `Your cwd is the handoff directory: ${input.handoffAbs}`,
    `Read BRIEF.md and request.json first. Images are under evidence/ in this directory.`,
    ``,
    `TASK (do exactly this, then stop):`,
    `1. Read the screenshot(s) with the image/read tools if available; describe what is visible factually.`,
    `2. Merge reporter notes from request.json with screenshot observations.`,
    `3. Write a single file defect.md in this handoff directory using the schema in BRIEF.md.`,
    `   - frontmatter id MUST be exactly: ${input.defectId}`,
    `   - status: open`,
    `   - do not invent repro steps you cannot infer; mark unknowns under Notes`,
    `   - do not start fixing product code`,
    `4. When defect.md exists and is non-empty, reply with one line: DONE defect.md`,
  ].join('\n');
}

/**
 * Spawn Grok Build headless so the agent can normalize screenshot+comment → defect.md.
 */
export function spawnGrokNormalize(
  opts: SpawnGrokNormalizeOpts,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const bin = resolveGrokBuildBin();
  const maxTurns = envDrainer('GROK_MAX_TURNS') ?? '20';
  const prompt = buildNormalizeCliPrompt({
    jobId: opts.jobId,
    defectId: opts.defectId,
    handoffAbs: opts.handoffAbs,
  });

  const sandbox =
    opts.sandbox === 'workspace'
      ? 'workspace'
      : opts.sandbox === 'strict'
        ? 'strict'
        : envDrainer('GROK_SANDBOX')?.trim() === 'workspace'
          ? 'workspace'
          : 'strict';

  const args = [
    '-p',
    prompt,
    '--cwd',
    opts.handoffAbs,
    '--sandbox',
    sandbox,
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
  if (tools) {
    args.push('--tools', tools);
  }

  opts.onLog(
    `spawning: ${bin} -p … --cwd ${opts.handoffAbs} --sandbox ${sandbox}`,
    'info',
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(bin, args, {
      cwd: opts.handoffAbs,
      env: {
        ...process.env,
        CI: process.env.CI ?? '1',
        GROK_SANDBOX: sandbox,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const pipe = (chunk: Buffer, level: 'info' | 'warn') => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        const t = line.trimEnd();
        if (t) opts.onLog(t, level);
      }
    };

    child.stdout?.on('data', (c) => pipe(c, 'info'));
    child.stderr?.on('data', (c) => pipe(c, 'warn'));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      opts.onLog(`spawn error: ${err.message}`, 'error');
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      opts.onLog(
        `grok process exited code=${code} signal=${signal ?? 'none'}`,
        code === 0 ? 'info' : 'warn',
      );
      resolve({ code, signal });
    });
  });
}

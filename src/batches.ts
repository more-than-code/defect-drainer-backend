import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './db.js';
import { jsonArray, nowIso, parseJsonArray } from './db.js';
import type { DefectRecord } from './store.js';
import { isSafeId } from './store.js';

/**
 * Contract files a repo uses to state its own rules — mandatory gates, skills,
 * conventions. The brief used to describe only DD's rules, so an agent learned
 * a repo's gates only if it thought to look. In a 2026-08-17 comparison of two
 * independent fixes of the same defect, the one that verified properly did so
 * solely because it read AGENTS.md on its own initiative.
 */
const CONTRACT_FILES = ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md'] as const;

function contractFilesIn(worktreeAbs: string): string[] {
  return CONTRACT_FILES.filter((f) => existsSync(path.join(worktreeAbs, f)));
}

/** Absolute inventory path for evidence relative paths (e.g. evidence/DEF-…/fix-01.png). */
function inventoryEvidenceAbs(defectsRoot: string, rel: string): string {
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  return path.join(defectsRoot, norm);
}

export type BatchStatus =
  | 'planned'
  | 'in_progress'
  | 'complete'
  | 'cancelled'
  | 'failed';

export type BatchRecord = {
  id: string;
  title: string;
  app_id: string;
  goal: string;
  status: BatchStatus;
  defect_ids: string[];
  created: string;
  path: string;
  mode?: string;
  handoff?: string;
};

const SAFE_BATCH_ID = /^BATCH-[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export function isSafeBatchId(id: string): boolean {
  return SAFE_BATCH_ID.test(id);
}

export function makeBatchId(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const suffix = Math.random().toString(36).slice(2, 7);
  return `BATCH-${y}${m}${d}-${suffix}`;
}

export function writeBatchManifest(
  db: Db,
  input: {
    id: string;
    title: string;
    app_id: string;
    goal: string;
    status: BatchStatus;
    defect_ids: string[];
    mode?: string;
  },
): BatchRecord {
  if (!isSafeBatchId(input.id)) throw new Error(`invalid batch id: ${input.id}`);
  for (const id of input.defect_ids) {
    if (!isSafeId(id)) throw new Error(`invalid defect id: ${id}`);
  }
  const created = new Date().toISOString().slice(0, 10);
  const ts = nowIso();
  db.prepare(
    `INSERT INTO batches (id, app_id, title, goal, status, defect_ids_json, mode, created, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, goal=excluded.goal, status=excluded.status,
       defect_ids_json=excluded.defect_ids_json, mode=excluded.mode, updated_at=excluded.updated_at`,
  ).run(
    input.id,
    input.app_id,
    input.title,
    input.goal,
    input.status,
    jsonArray(input.defect_ids),
    input.mode ?? null,
    created,
    ts,
  );
  return {
    id: input.id,
    title: input.title,
    app_id: input.app_id,
    goal: input.goal,
    status: input.status,
    defect_ids: input.defect_ids,
    created,
    path: `sqlite:batches/${input.id}`,
    mode: input.mode,
  };
}

export function listBatches(db: Db): BatchRecord[] {
  const rows = db
    .prepare(
      `SELECT id, app_id, title, goal, status, defect_ids_json, mode, created
       FROM batches ORDER BY created DESC, id DESC`,
    )
    .all() as Array<{
    id: string;
    app_id: string;
    title: string;
    goal: string;
    status: string;
    defect_ids_json: string;
    mode: string | null;
    created: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    app_id: r.app_id,
    title: r.title,
    goal: r.goal,
    status: r.status as BatchStatus,
    defect_ids: parseJsonArray(r.defect_ids_json),
    created: r.created,
    path: `sqlite:batches/${r.id}`,
    mode: r.mode || undefined,
  }));
}

export function getBatch(db: Db, id: string): BatchRecord | null {
  if (!isSafeBatchId(id)) return null;
  const r = db
    .prepare(
      `SELECT id, app_id, title, goal, status, defect_ids_json, mode, created
       FROM batches WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        app_id: string;
        title: string;
        goal: string;
        status: string;
        defect_ids_json: string;
        mode: string | null;
        created: string;
      }
    | undefined;
  if (!r) return null;
  return {
    id: r.id,
    app_id: r.app_id,
    title: r.title,
    goal: r.goal,
    status: r.status as BatchStatus,
    defect_ids: parseJsonArray(r.defect_ids_json),
    created: r.created,
    path: `sqlite:batches/${r.id}`,
    mode: r.mode || undefined,
  };
}

/** Update only status (and updated_at) for an existing batch manifest. */
export function setBatchStatus(
  db: Db,
  id: string,
  status: BatchStatus,
): BatchRecord | null {
  const cur = getBatch(db, id);
  if (!cur) return null;
  return writeBatchManifest(db, {
    id: cur.id,
    title: cur.title,
    app_id: cur.app_id,
    goal: cur.goal,
    status,
    defect_ids: cur.defect_ids,
    mode: cur.mode,
  });
}

/**
 * Pull the `## Acceptance` checklist out of a defect body.
 *
 * Normalize writes these criteria at intake (`jobs/normalizeJob.ts`) and until
 * now nothing read them back, so the agent fixing the defect never saw what
 * "fixed" was defined to mean. Returns the list items only; an empty result
 * means the defect never carried criteria.
 */
export function acceptanceCriteria(body: string | undefined): string[] {
  if (!body) return [];
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s+acceptance\b/i.test(l.trim()));
  if (start < 0) return [];
  const out: string[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) break; // next section ends the block
    if (!line) continue;
    // "- [ ] text" / "- [x] text" / "- text" / "1. text"
    const item = line
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^\[[ xX]\]\s*/, '')
      .trim();
    if (item) out.push(item);
  }
  return out;
}

export function buildBatchFixBrief(input: {
  batch: BatchRecord;
  defects: DefectRecord[];
  defectsRoot: string;
  /** App Settings: strict | workspace */
  grok_sandbox?: 'strict' | 'workspace';
  worktrees?: Array<{
    repo: string;
    primaryAbs: string;
    worktreeAbs: string;
    branch: string;
  }>;
}): string {
  const sandbox = input.grok_sandbox === 'workspace' ? 'workspace' : 'strict';
  const lines = [
    `# Batch agent fix — ${input.batch.id}`,
    ``,
    `## Goal`,
    input.batch.goal,
    ``,
    `## App`,
    `\`${input.batch.app_id}\``,
    ``,
    `## Agent sandbox (App Settings)`,
    sandbox === 'workspace'
      ? [
          `- Profile: **workspace** — host reads allowed (iOS Simulator / simctl).`,
          `- Writes only under handoff cwd + temp. Put post-fix screenshots in \`fix-evidence/<DEF-id>/fix-01.png\`.`,
        ].join('\n')
      : [
          `- Profile: **strict** (restrict) — no reliable Simulator access.`,
          `- Code-only in worktrees; operator attaches fix_evidence in console if needed.`,
        ].join('\n'),
    ``,
    `## HARD isolation (enforced by operator — do not violate)`,
    `- Product code edits are **only** allowed inside the **worktree paths** listed below.`,
    `- An app may have **multiple repos**; decide which worktree(s) need changes for each defect.`,
    `- **Never** edit primary checkouts (the "primary" paths). Other agents may own those trees.`,
    `- Branch name for this batch: use the worktree branch already checked out (do not switch primary).`,
    `- Inventory SSOT is SQLite + evidence files under \`${input.defectsRoot}/evidence\`.`,
    `- **Read** report + historical fix evidence from inventory (paths listed per defect below).`,
    `- **Write** new fix proof under handoff \`fix-evidence/\` (this job only); backend harvests onto the defect after the run.`,
    ``,
  ];

  if (input.worktrees?.length) {
    lines.push(`## Worktrees (edit ONLY these product paths)`);
    lines.push(``);
    for (const w of input.worktrees) {
      lines.push(`### ${w.repo}`);
      lines.push(`- **worktree (EDIT HERE):** \`${w.worktreeAbs}\``);
      lines.push(`- **branch:** \`${w.branch}\``);
      lines.push(`- **primary (DO NOT EDIT):** \`${w.primaryAbs}\``);
      const contracts = contractFilesIn(w.worktreeAbs);
      if (contracts.length) {
        lines.push(
          `- **read first — this repo's own rules:** ${contracts
            .map((f) => `\`${path.join(w.worktreeAbs, f)}\``)
            .join(', ')}`,
        );
        lines.push(
          `  They define that repo's mandatory gates, skills and conventions.`,
        );
        lines.push(
          `  They bind you as much as this brief; where stricter, they win.`,
        );
      }
      lines.push(``);
    }
  } else {
    lines.push(
      `## Worktrees`,
      ``,
      `**NONE — refuse to edit product code.** Worktree setup failed or was skipped.`,
      ``,
    );
  }

  lines.push(
    `## Rules`,
    `- Fix **only** the listed defects.`,
    `- Prefer minimal, verified fixes with tests inside the worktree.`,
    `- Use **historical fix evidence** (if listed) as context: prior proof of what “fixed” looked like; do not ignore regressions.`,
    ``,
    `## New fix evidence this run (REQUIRED — handoff paths, sandbox-writable)`,
    `Backend imports these after the run onto the **defect** SSOT. Do **not** rely on writing inventory directly.`,
    ``,
    `For **each** defect id you claim fixed:`,
    `1. Screenshots (png/jpg/webp): \`fix-evidence/<DEF-id>/fix-01.png\`, \`fix-02.png\`, …`,
    `2. Short resolution text: \`fix-notes/<DEF-id>.md\` (what changed + how verified).`,
    ``,
    `Without **new** images under this job's \`fix-evidence/<DEF-id>/\`, harvest will not update the defect for this run.`,
    ``,
    `## Defects (${input.defects.length})`,
    ``,
  );
  for (const d of input.defects) {
    lines.push(`### ${d.id}`);
    lines.push(`- **title:** ${d.title}`);
    lines.push(`- **severity:** ${d.severity}`);
    lines.push(`- **status:** ${d.status}`);
    lines.push(`- **summary:** ${d.summary}`);
    if (d.surface) lines.push(`- **surface:** ${d.surface}`);
    if (d.repos?.length) {
      lines.push(`- **related repos:** ${d.repos.join(', ')}`);
    }
    if (d.resolution) {
      lines.push(`- **prior resolution note (historical):** ${d.resolution}`);
    }
    const acceptance = acceptanceCriteria(d.body);
    if (acceptance.length) {
      lines.push(
        `- **acceptance criteria (THE BAR — address each one in fix-notes):**`,
      );
      for (const a of acceptance) lines.push(`  - [ ] ${a}`);
    }
    if (d.evidence?.length) {
      lines.push(`- **report evidence (intake — read for bug context):**`);
      for (const e of d.evidence) {
        const abs = inventoryEvidenceAbs(input.defectsRoot, e);
        lines.push(`  - rel: \`${e}\``);
        lines.push(`  - abs: \`${abs}\``);
      }
    }
    if (d.fix_evidence?.length) {
      lines.push(
        `- **historical fix evidence (owned by defect SSOT — read for prior proof / regressions):**`,
      );
      for (const e of d.fix_evidence) {
        const abs = inventoryEvidenceAbs(input.defectsRoot, e);
        lines.push(`  - rel: \`${e}\``);
        lines.push(`  - abs: \`${abs}\``);
      }
    } else {
      lines.push(
        `- **historical fix evidence:** (none yet — first fix run or never harvested)`,
      );
    }
    lines.push(
      `- **deliver this run:** \`fix-evidence/${d.id}/fix-01.png\` + \`fix-notes/${d.id}.md\``,
    );
    lines.push(``);
  }
  lines.push(`## Done`);
  lines.push(
    `When code fixes are in worktrees and **this job's** fix-evidence/notes exist for each fixed defect: reply \`DONE ${input.batch.id}\`.`,
  );
  lines.push(``);
  return lines.join('\n');
}

# Verification hardening — what shipped, what is left

Companion to [`workflow.md`](./workflow.md) → *Verification: who decides a fix is real*.
That doc describes how the system behaves today; this one records **why** it was
built and **what is deliberately not done**, so the next person does not have to
rediscover either.

Live status is tracked at the umbrella `tasks/todo.md`. Task files are
deliberately unversioned (backend `fe536d8` stopped tracking `tasks/`), so the
reasoning that must survive lives here instead.

## The failure that started it

`DEF-20260817-mobile-chat-composer-still-shows-the-sti-yav9` (P1) was marked
**resolved** because a PNG existed in the handoff. The agent's fix notes claimed
"6 passed" and "flutter analyze — no issues"; nothing re-ran either. Harvest
resolved on file existence alone.

Cross-checking that fix against an independent fix of the same defect found
**four** issues in one direction and **three** in the other — neither agent was
dishonest, and neither was sufficient on its own.

## Shipped

| # | Change | Where |
|---|---|---|
| 1 | Verification commands re-run by DD; only DD's result counts | `jobs/runVerification.ts`, Settings, Jobs panel |
| 2 | Baseline run before the agent, so pre-existing red is attributable | `jobs/runVerification.ts` (`judgeVerification`), `jobs/batchJob.ts` |
| 3 | Acceptance criteria from the defect body rendered in BRIEF.md | `batches.ts` (`acceptanceCriteria`) |
| 4 | Agent toolchain: pinned SDK cloned into the handoff | `jobs/provisionToolchain.ts` |
| 5 | Job-scoped Simulator write grant | `jobs/sandboxProfile.ts` |
| 6 | BRIEF names each worktree's own contract files (AGENTS.md / CLAUDE.md) | `batches.ts` (`contractFilesIn`) |

Design decisions worth not re-litigating:

- **Operator-authored commands.** DD's runner is not sandboxed. Executing
  command strings written by the coding agent would hand it unsandboxed
  execution on the host. The agent is told the commands and expected to run
  them; it cannot author or edit them.
- **Unrunnable is never excused.** A command that could not run (bad repo name,
  missing worktree) blocks even when the baseline failed identically, so a typo
  cannot silently disable a check.
- **Contract files are listed, not assumed.** The brief prints the absolute
  path of each contract file that actually exists in that worktree, and says
  that where the repo's rules are stricter than DD's, the repo wins. Repos
  without one (e.g. `ttd-deploy`) simply get no such line.
- **Repo-name aliasing.** Worktree bindings are named by app entry name on the
  entries path (`webapp`) and by git URL leaf on the `repo_urls` path
  (`ttd-webapp`). `bindingAliases()` resolves both through the app's own
  entry→url mapping — never by substring.

## Not done, and why

### No diff-hygiene check
Compare `git diff` against `git diff -w` at harvest. One 2026-08-17 fix touched
400 lines across 41 hunks, of which **34 hunks and 162 lines were pure
`dart format` reflow** of code the fix never needed to touch. Mechanically
detectable, currently invisible.

### No second-pass reviewer
Diffing a fix against the defect's acceptance criteria and the repo's
conventions would have caught most of the seven cross-check findings without
either agent getting smarter.

### Detector re-run gate (parked)
Tag a verify command with the defect `source` that filed it, so the check that
caught the bug must pass again before resolve. Needs a third verdict —
*not applicable* — for a source-gated check in a batch with no such defect,
and an unrecognised source must count as a failure so a typo cannot disable it.

**Parked because no detector here runs unattended.** The tutored parity harness
needs a browser and a dev server. Revive when a detector gains a headless mode,
or when one is added that already has it (lint sweep, a11y scan, source-diff
checks).

### Reporter kind: human vs agent (parked)
`reporter` is empty on all 31 defects; `source` only hints (`parity-*` vs
`console`, and `console` does not prove a human wrote it). Recording
human-vs-agent at intake would let real user-observed pain sort apart from
machine findings, which are sometimes noise — a re-review produced two
"mobile-only Pin/Rename" findings that did not reproduce on a second pass.

## Detector blind spots are defects too

While fixing the P1 above, a user-facing copy bug shipped inside a gap in the
*detector*: the tutored parity gate's i18n drift check excludes multi-line
source entries (54 of them), so a string telling users to tap a deleted button
passed every automated check. Harness gaps deserve defect records of their own,
or they keep shipping bugs no agent is equipped to see.

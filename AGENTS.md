# defect-drainer-backend

**Folder:** `backend/` · **Git name:** `defect-drainer-backend`

**Retired as the live API.** Use `../backend-go` (`defect-drainer serve`). This package is rollback only (`pnpm dev` after stopping Go). Framing: `docs/workflow.md`.

- Inventory SSOT: **SQLite** in `.data/` + umbrella `../evidence/` — do not invent a second store
- Env: `DEFECT_DRAINER_*` (legacy `DEFECT_CHANNEL_*` still read)
- App `repo_entries[]`: `base_source` (`origin` \| `local`) + `base_branch` per repo; `POST /api/git/branches` and `POST /api/git/choose-folder` (macOS Finder) serve Settings
- Defects expose `created_at` (ISO UTC) and `reporter` (who filed); `source` is how it was detected
- Cross-repo plans: `/Users/joe/workspace/defect-drainer/tasks/todo.md`
- Local tasks: `tasks/todo.md` (this package only)
- Run (rollback only): stop Go, then `pnpm dev` → `127.0.0.1:8788`

## Session ownership (worktree)

**If `SESSION.md` exists at this repo root, read it at session start**
(or before the first edit). It defines session ownership and off-limits paths.
If absent, ignore this section — normal primary-tree work.

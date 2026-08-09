# defect-drainer-backend

**Folder:** `backend/` · **Git name:** `defect-drainer-backend`

Harness API: inventory + AI coding-agent batch-fix jobs + PR actions. Framing: `../docs/workflow.md` (runner-agnostic product language).

- Inventory SSOT: **SQLite** in `.data/` + umbrella `../evidence/` — do not invent a second store
- Env: `DEFECT_DRAINER_*` (legacy `DEFECT_CHANNEL_*` still read)
- Cross-repo plans: `/Users/joe/workspace/defect-drainer/tasks/todo.md`
- Local tasks: `tasks/todo.md` (this package only)
- Run: `pnpm dev` → `127.0.0.1:8788`

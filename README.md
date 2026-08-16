# defect-drainer-backend

**In-workspace path:** `backend/`  
**Git repo name (when initialized):** `defect-drainer-backend`

**Harness API** for the defect-drainer umbrella: inventory (intake, defects, evidence), **AI coding-agent batch-fix jobs** (worktrees, logs, stop/re-run), and host **PR** actions. Product language is runner-agnostic — see umbrella [`docs/workflow.md`](../docs/workflow.md).

SQLite SSOT: `backend/.data/defect-drainer.db`. Evidence binaries under umbrella `../evidence/`.

## Run

```bash
cd /Users/joe/workspace/defect-drainer/backend
pnpm install
pnpm dev          # http://127.0.0.1:8788
```

| Variable | Default |
|----------|---------|
| `DEFECTS_ROOT` | umbrella root (parent of `backend/`) |
| `DEFECT_DRAINER_DATA` | `backend/.data` |
| `DEFECT_DRAINER_HOST` | `127.0.0.1` |
| `DEFECT_DRAINER_PORT` | `8788` |
| `DEFECT_DRAINER_NORMALIZE_MODE` | `local` (API-structured intake; set `grok` only if vision normalize wanted) |

Legacy `DEFECT_CHANNEL_*` names are still **read** if `DEFECT_DRAINER_*` is unset.

**SSOT:** SQLite at `backend/.data/defect-drainer.db` (apps, defects, batches).  
**Evidence files:** still under `evidence/<id>/` (binary on disk).  
One-time import from legacy markdown / `apps/registry.json` on first boot when tables are empty.

Apps: **per product surface**, multi-repo URLs; seeded Tutored Webapp + Mobileapp.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/analytics` | Phase A SQL analytics (`app_id?`) — defect mix, prompt_use, jobs |
| `GET` | `/api/search` | Multi-artifact search (OpenSearch if configured, else FTS) |
| `GET` | `/api/search/status` | OpenSearch enabled/reachable + outbox depth |
| `POST` | `/api/search/flush` | Drain search_outbox |
| `POST` | `/api/search/reindex` | Full reindex SSOT → OpenSearch |

**Phase B OpenSearch (optional):**

```bash
pnpm search:up          # podman compose — :9200
export DEFECT_DRAINER_OPENSEARCH_URL=http://127.0.0.1:9200
# optional: DEFECT_DRAINER_OPENSEARCH_INDEX=defect-drainer-artifacts
pnpm dev
curl -X POST http://127.0.0.1:8788/api/search/reindex
```
| `GET` | `/api/apps` | List apps + default |
| `POST` | `/api/apps` | Create app (onboarding) — generates `app_` + hash id |
| `GET` | `/api/apps/:id` | One app |
| `PATCH` | `/api/apps/:id` | Settings: `repo_url` / `repo_urls`, name, repos, … |
| `DELETE` | `/api/apps/:id` | Remove app from registry (defects kept) |

Batches:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/batches` | List batch manifests + batch jobs |
| `POST` | `/api/batches` | Create batch from `defect_ids`; optional coding-agent fix session |
| `GET` | `/api/batch-jobs/:id` | Batch job status / log |

`POST` body:

```json
{
  "app_id": "tutored",
  "defect_ids": ["DEF-…"],
  "goal": "optional",
  "mode": "grok",
  "start_fix": true,
  "repo_url": "https://github.com/org/ttd-webapp.git",
  "repo_urls": ["https://…/a.git", "https://…/b.git"]
}
```

`repo_url` / `repo_urls` come from the console. When set, backend **clones** into `backend/.data/clones/<name>/` then creates worktrees. When omitted, falls back to app `workspace_root` local checkouts.

**Worktree isolation (enforced when `start_fix: true`):**

1. Prefer `repo_url(s)` → clone/fetch under `.data/clones/`; else defect `repos` + app `workspace_root`.
2. `git worktree add -b defect-drainer/<BATCH-id> …/<jobId>/worktrees/<repo> <main|master>` per repo.
3. The agent job is **refused** if worktree setup fails or list is empty (fail-closed).
4. BRIEF lists **worktree (EDIT)** vs **primary (DO NOT EDIT)**.
5. Worktrees are **not** auto-merged/removed after the agent exits — review then merge `defect-drainer/BATCH-…` yourself.
6. **Create PR** (`POST /api/batch-jobs/:id/create-prs`) opens GitHub PRs via host `gh` and stores `job.prs[]` (`created` | `existing` | `skipped` | `failed` + optional `url`).
7. **Refresh PRs** (`POST /api/batch-jobs/:id/refresh-prs`) polls GitHub with `gh pr view` / `list` and sets lifecycle fields on each trackable PR: `ghState` (`open` | `merged` | `closed`), `mergedAt`, `checkedAt`. Console shows chips on Jobs (and aggregates on Defects). Does **not** auto-resolve defects when PRs merge.

Env: `DEFECT_PRODUCT_WORKSPACE_ROOT` fallback if registry has no `workspace_root`.

**Agent sandbox (default `strict`):**

Headless coding-agent jobs run with an OS sandbox profile. Names below match the current default runner’s CLI flags (implementation detail).

| Env | Default | Meaning |
|-----|---------|---------|
| `DEFECT_DRAINER_GROK_SANDBOX` | `strict` | Sandbox profile: `strict` \| `workspace` |
| `DEFECT_DRAINER_GROK_BYPASS_PERMISSIONS` | off | Set `1` to loosen agent permission prompts (host-runner specific) |

Under `strict`, kernel write is limited to **cwd** (handoff + `worktrees/`), agent state dirs, and temp. Primary product checkouts are outside cwd → **not writable**. Inventory is also outside cwd → the agent may not update defect files; use console for `fix_evidence` / resolve if needed.

**Fix-backed-by-evidence:**

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/defects/:id/fix-evidence` | Upload post-fix images → `fix-NN.ext` |
| `POST` | `/api/defects/:id/resolve` | Requires `fix_evidence` (JSON paths or multipart files) |

Report screenshots = `evidence`. Fix proof = `fix_evidence`. Resolve without fix proof → 400.

```bash
DEFECT_DRAINER_NORMALIZE_LOCAL=1 pnpm dev
```

## Tests

```bash
node ./node_modules/tsx/dist/cli.mjs --test test/**/*.test.ts
node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

## Operator UI

Use sibling **`console/`** (`defect-drainer-console`) — Vite app proxies to this API in dev.

## Related

- Umbrella: `../README.md`, `../HANDOFF.md`, `../AGENTS.md`
- Console: `../console/README.md`

## License

MIT — see [LICENSE](./LICENSE).

import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Db } from './db.js';
import { jsonArray, nowIso, parseJsonArray } from './db.js';
import { envDrainer } from './env.js';

export type AppBaseSource = 'origin' | 'local';

/** Named repo for an app (Settings). Name is shown on Report ticks. */
export type AppRepoEntry = {
  name: string;
  /** GitHub URL when base_source is origin; absolute checkout path when local. */
  url: string;
  /** Worktree source for this repo. Default inferred from url. */
  base_source?: AppBaseSource;
  /** Branch this repo's worktrees branch from / PRs target. */
  base_branch?: string;
};

/**
 * Coding-agent sandbox profile for this app.
 * - `strict` (restrict): read CWD+system; write handoff/temp — code-only, no Simulator host access
 * - `workspace`: read everywhere (Simulator ok); write still handoff/temp/`~/.grok`
 */
export type GrokSandboxProfile = 'strict' | 'workspace';

export type AppRecord = {
  /** Platform id: app_ + 16 hex chars (unique, immutable) */
  id: string;
  name: string;
  description?: string;
  /** @deprecated internal only — not user-facing; clones live under backend .data */
  workspace_root?: string;
  /** Repo display names (also used on defects.repos). Derived from repo_entries. */
  repos?: string[];
  /** Preferred: name + url pairs from Settings */
  repo_entries?: AppRepoEntry[];
  repo_url?: string;
  repo_urls?: string[];
  /** Per-app agent sandbox (App Settings). Default strict. API: grok_sandbox. */
  grok_sandbox?: GrokSandboxProfile;
  /** Remote whose tracking ref batch worktrees branch from. Default `origin`. */
  base_remote?: string;
  /** Branch batch worktrees branch from, and the PR target. Default `main`. */
  base_branch?: string;
  default?: boolean;
};

export function parseBaseSource(
  v: unknown,
  fallback: AppBaseSource = 'origin',
): AppBaseSource {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  if (s === 'local') return 'local';
  if (s === 'origin' || s === 'github') return 'origin';
  return fallback;
}

function inferBaseSource(url: string, explicit?: unknown): AppBaseSource {
  if (explicit !== undefined && explicit !== null && String(explicit).trim()) {
    return parseBaseSource(explicit);
  }
  const u = url.trim();
  if (u.startsWith('/') || u.startsWith('file://')) return 'local';
  return 'origin';
}

/** Git ref names we are willing to pass to git/gh: no spaces, no option-looking values. */
export function parseGitRefName(v: unknown, fallback: string): string {
  const s = String(v ?? '').trim();
  if (!s) return fallback;
  if (!/^[A-Za-z0-9._\/-]{1,120}$/.test(s)) return fallback;
  if (s.startsWith('-') || s.includes('..') || s.endsWith('/')) return fallback;
  return s;
}

/** Accept CLI names plus UI alias "restrict" → strict. */
export function parseGrokSandbox(v: unknown): GrokSandboxProfile {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  if (s === 'workspace') return 'workspace';
  if (s === 'strict' || s === 'restrict' || s === 'restricted') return 'strict';
  return 'strict';
}

/**
 * Resolve sandbox for an agent spawn: app setting, else env default, else strict.
 * Env: DEFECT_DRAINER_GROK_SANDBOX (legacy DEFECT_CHANNEL_GROK_SANDBOX still read).
 */
export function resolveGrokSandbox(
  app?: AppRecord | null,
): GrokSandboxProfile {
  if (app?.grok_sandbox) return parseGrokSandbox(app.grok_sandbox);
  return parseGrokSandbox(envDrainer('GROK_SANDBOX'));
}

export function nameFromRepoUrl(url: string): string {
  const leaf = url.replace(/\/+$/, '').split('/').pop() || 'repo';
  return leaf.replace(/\.git$/i, '') || 'repo';
}

type RepoEntryInput = {
  name?: string;
  url?: string;
  base_source?: string;
  base_branch?: string;
};

/** Normalize API/settings rows into unique name→url entries. */
export function normalizeRepoEntries(
  entries: Array<RepoEntryInput | string>,
): AppRepoEntry[] {
  const out: AppRepoEntry[] = [];
  for (const e of entries) {
    if (typeof e === 'string') {
      const url = e.trim();
      if (!url) continue;
      out.push({
        name: nameFromRepoUrl(url),
        url,
        base_source: inferBaseSource(url),
      });
      continue;
    }
    const url = String(e?.url ?? '').trim();
    const name =
      String(e?.name ?? '').trim() || (url ? nameFromRepoUrl(url) : '');
    if (!name && !url) continue;
    const branch = parseGitRefName(e?.base_branch, '');
    out.push({
      name: name || nameFromRepoUrl(url),
      url,
      base_source: inferBaseSource(url, e?.base_source),
      ...(branch ? { base_branch: branch } : {}),
    });
  }
  const byName = new Map<string, AppRepoEntry>();
  for (const e of out) byName.set(e.name, e);
  return [...byName.values()];
}

/**
 * Read apps.repo_urls_json which may be:
 * - object entries `[{name,url}, …]`
 * - legacy string urls `["https://…"]`
 * - empty + repos_json names only
 */
export function parseStoredRepoEntries(
  repo_urls_json: string | null | undefined,
  repo_url: string | null | undefined,
  repos_json: string | null | undefined,
): AppRepoEntry[] {
  const names = parseJsonArray(repos_json);
  let raw: unknown = [];
  try {
    raw = repo_urls_json ? JSON.parse(repo_urls_json) : [];
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) raw = [];

  if ((raw as unknown[]).length > 0) {
    const first = (raw as unknown[])[0];
    if (typeof first === 'object' && first !== null) {
      return normalizeRepoEntries(
        (raw as Array<Record<string, unknown>>).map((o) => ({
          name: String(o.name ?? o.repo ?? ''),
          url: String(o.url ?? o.repo_url ?? ''),
          base_source:
            o.base_source !== undefined ? String(o.base_source) : undefined,
          base_branch:
            o.base_branch !== undefined ? String(o.base_branch) : undefined,
        })),
      );
    }
    const urls = (raw as unknown[]).map(String).map((s) => s.trim()).filter(Boolean);
    if (repo_url?.trim()) urls.unshift(repo_url.trim());
    const uniq = [...new Set(urls)];
    return uniq.map((url, i) => ({
      name: names[i] || nameFromRepoUrl(url),
      url,
    }));
  }

  if (repo_url?.trim()) {
    return [
      { name: names[0] || nameFromRepoUrl(repo_url), url: repo_url.trim() },
      ...names.slice(1).map((name) => ({ name, url: '' })),
    ];
  }

  return names.map((name) => ({ name, url: '' }));
}

function persistRepoColumns(entries: AppRepoEntry[]): {
  repos_json: string;
  repo_url: string | null;
  repo_urls_json: string;
} {
  const clean = normalizeRepoEntries(entries);
  const names = clean.map((e) => e.name);
  const withUrl = clean.filter((e) => e.url);
  return {
    repos_json: jsonArray(names),
    repo_url: withUrl.length === 1 ? withUrl[0]!.url : null,
    repo_urls_json: JSON.stringify(
      clean.map((e) => ({
        name: e.name,
        url: e.url,
        base_source: e.base_source ?? inferBaseSource(e.url),
        ...(e.base_branch ? { base_branch: e.base_branch } : {}),
      })),
    ),
  };
}

/** app_ + 16 lowercase hex */
const SAFE_APP_ID = /^app_[a-f0-9]{16}$/;

export function appIdFromSeed(seed: string): string {
  const hex = createHash('sha256')
    .update(`defect-drainer:app:${seed}`)
    .digest('hex')
    .slice(0, 16);
  return `app_${hex}`;
}

export const SEEDED_TUTORED_WEBAPP_APP_ID = appIdFromSeed('tutored-webapp');
export const SEEDED_TUTORED_MOBILE_APP_ID = appIdFromSeed('tutored-mobileapp');
/** @deprecated use SEEDED_TUTORED_WEBAPP_APP_ID */
export const SEEDED_TUTORED_APP_ID = SEEDED_TUTORED_WEBAPP_APP_ID;

const LEGACY_UMBRELLA_HASH = appIdFromSeed('tutored');

const LEGACY_APP_IDS: Record<string, string> = {
  tutored: SEEDED_TUTORED_WEBAPP_APP_ID,
  'tutored-webapp': SEEDED_TUTORED_WEBAPP_APP_ID,
  'tutored-web': SEEDED_TUTORED_WEBAPP_APP_ID,
  'tutored-mobileapp': SEEDED_TUTORED_MOBILE_APP_ID,
  'tutored-mobile': SEEDED_TUTORED_MOBILE_APP_ID,
  [LEGACY_UMBRELLA_HASH]: SEEDED_TUTORED_WEBAPP_APP_ID,
};

export function isSafeAppId(id: string): boolean {
  return SAFE_APP_ID.test(id);
}

export function generateAppId(): string {
  return `app_${randomBytes(8).toString('hex')}`;
}

export function canonicalizeAppId(id: string): string {
  const t = (id || '').trim();
  if (!t) return SEEDED_TUTORED_WEBAPP_APP_ID;
  if (LEGACY_APP_IDS[t]) return LEGACY_APP_IDS[t]!;
  return t;
}

export function seededApps(): AppRecord[] {
  return [
    {
      id: SEEDED_TUTORED_WEBAPP_APP_ID,
      name: 'Tutored Webapp',
      description:
        'Tutored web product — repos: ttd-webapp, ttd-backend (Grok picks fix surface)',
      workspace_root: '/Users/joe/workspace/tutored',
      repos: ['ttd-webapp', 'ttd-backend'],
      repo_entries: [
        { name: 'ttd-webapp', url: '' },
        { name: 'ttd-backend', url: '' },
      ],
      default: true,
    },
    {
      id: SEEDED_TUTORED_MOBILE_APP_ID,
      name: 'Tutored Mobileapp',
      description:
        'Tutored mobile product — repos: ttd-mobileapp, ttd-backend (Grok picks fix surface)',
      workspace_root: '/Users/joe/workspace/tutored',
      repos: ['ttd-mobileapp', 'ttd-backend'],
      repo_entries: [
        { name: 'ttd-mobileapp', url: '' },
        { name: 'ttd-backend', url: '' },
      ],
      default: false,
    },
  ];
}

export function clientHintForApp(app: AppRecord | undefined): string {
  if (!app) return 'unknown';
  const names = app.repo_entries?.map((e) => e.name) ?? app.repos ?? [];
  const blob = `${app.name} ${names.join(' ')}`.toLowerCase();
  if (blob.includes('mobile')) return 'mobile';
  if (blob.includes('web')) return 'web';
  return 'unknown';
}

type AppRow = {
  id: string;
  name: string;
  description: string | null;
  workspace_root: string | null;
  repos_json: string;
  repo_url: string | null;
  repo_urls_json: string;
  grok_sandbox?: string | null;
  base_remote?: string | null;
  base_branch?: string | null;
  is_default: number;
};

function rowToApp(row: AppRow): AppRecord {
  const entries = parseStoredRepoEntries(
    row.repo_urls_json,
    row.repo_url,
    row.repos_json,
  );
  const urls = entries.map((e) => e.url).filter(Boolean);
  const names = entries.map((e) => e.name).filter(Boolean);
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    workspace_root: row.workspace_root ?? undefined,
    repos: names.length ? names : parseJsonArray(row.repos_json),
    repo_entries: entries,
    repo_url: urls.length === 1 ? urls[0] : undefined,
    repo_urls: urls.length > 1 ? urls : undefined,
    grok_sandbox: parseGrokSandbox(row.grok_sandbox),
    base_remote: parseGitRefName(row.base_remote, 'origin'),
    base_branch: parseGitRefName(row.base_branch, 'main'),
    default: !!row.is_default,
  };
}

const APP_SELECT = `id, name, description, workspace_root, repos_json, repo_url, repo_urls_json, grok_sandbox, base_remote, base_branch, is_default`;

export function listApps(db: Db): AppRecord[] {
  const rows = db
    .prepare(
      `SELECT ${APP_SELECT}
       FROM apps ORDER BY is_default DESC, name ASC`,
    )
    .all() as AppRow[];
  return rows.map(rowToApp);
}

export function ensureSeededApps(db: Db): void {
  const count = (
    db.prepare('SELECT COUNT(*) AS c FROM apps').get() as { c: number }
  ).c;
  if (count > 0) return;
  const ts = nowIso();
  const ins = db.prepare(`
    INSERT INTO apps (
      id, name, description, workspace_root, repos_json, repo_url, repo_urls_json,
      grok_sandbox, base_remote, base_branch, is_default, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const a of seededApps()) {
    ins.run(
      a.id,
      a.name,
      a.description ?? null,
      a.workspace_root ?? null,
      jsonArray(a.repos ?? []),
      a.repo_url ?? null,
      jsonArray(a.repo_urls ?? []),
      parseGrokSandbox(a.grok_sandbox),
      parseGitRefName(a.base_remote, 'origin'),
      parseGitRefName(a.base_branch, 'main'),
      a.default ? 1 : 0,
      ts,
      ts,
    );
  }
}

export function getDefaultAppId(db: Db): string {
  const row = db
    .prepare(
      `SELECT id FROM apps WHERE is_default = 1 LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (row?.id) return row.id;
  const any = db.prepare(`SELECT id FROM apps ORDER BY name LIMIT 1`).get() as
    | { id: string }
    | undefined;
  return any?.id ?? SEEDED_TUTORED_WEBAPP_APP_ID;
}

export function getApp(db: Db, appId: string): AppRecord | undefined {
  const id = canonicalizeAppId(appId);
  const row = db
    .prepare(`SELECT ${APP_SELECT} FROM apps WHERE id = ?`)
    .get(id) as AppRow | undefined;
  return row ? rowToApp(row) : undefined;
}

export function resolveAppId(db: Db, input: string | undefined): string {
  const id = canonicalizeAppId(input ?? getDefaultAppId(db));
  if (!isSafeAppId(id)) throw new Error(`invalid app_id: ${input}`);
  if (!getApp(db, id)) throw new Error(`unknown app_id: ${input}`);
  return id;
}

export function getAppRepoUrls(app: AppRecord | undefined): string[] {
  if (!app) return [];
  if (app.repo_entries?.length) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const e of app.repo_entries) {
      const u = e.url?.trim();
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
    if (out.length) return out;
  }
  const list = [
    ...(app.repo_urls ?? []),
    ...(app.repo_url ? [app.repo_url] : []),
  ]
    .flatMap((s) => s.split(/[\n,]+/))
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  return list.filter((u) => {
    if (seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

function entriesFromAppInput(input: {
  repo_entries?: Array<RepoEntryInput | string>;
  repos?: string[];
  repo_url?: string | null;
  repo_urls?: string[] | null;
}): AppRepoEntry[] {
  if (input.repo_entries !== undefined) {
    return normalizeRepoEntries(input.repo_entries);
  }
  const urls = [
    ...(input.repo_urls ?? []),
    ...(input.repo_url ? [input.repo_url] : []),
  ]
    .flatMap((s) => String(s).split(/[\n,]+/))
    .map((s) => s.trim())
    .filter(Boolean);
  if (urls.length) {
    const names = (input.repos ?? []).map((r) => String(r).trim()).filter(Boolean);
    return urls.map((url, i) => ({
      name: names[i] || nameFromRepoUrl(url),
      url,
    }));
  }
  if (input.repos?.length) {
    return input.repos
      .map((r) => String(r).trim())
      .filter(Boolean)
      .map((name) => ({ name, url: '' }));
  }
  return [];
}

export function createApp(
  db: Db,
  input: {
    name: string;
    description?: string;
    workspace_root?: string;
    repos?: string[];
    repo_entries?: Array<RepoEntryInput | string>;
    repo_url?: string;
    repo_urls?: string[];
    grok_sandbox?: GrokSandboxProfile | string;
    base_remote?: string;
    base_branch?: string;
    default?: boolean;
  },
): AppRecord {
  const name = (input.name || '').trim();
  if (!name) throw new Error('name is required');
  if (name.length > 120) throw new Error('name too long');

  const id = generateAppId();
  const cols = persistRepoColumns(entriesFromAppInput(input));
  const grok_sandbox =
    input.grok_sandbox !== undefined
      ? parseGrokSandbox(input.grok_sandbox)
      : parseGrokSandbox(envDrainer('GROK_SANDBOX'));

  const makeDefault =
    input.default === true ||
    !(
      db.prepare('SELECT COUNT(*) AS c FROM apps WHERE is_default = 1').get() as {
        c: number;
      }
    ).c;

  if (makeDefault) {
    db.prepare('UPDATE apps SET is_default = 0').run();
  }

  const ts = nowIso();
  db.prepare(
    `INSERT INTO apps (
      id, name, description, workspace_root, repos_json, repo_url, repo_urls_json,
      grok_sandbox, base_remote, base_branch, is_default, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    (input.description || '').trim() || null,
    (input.workspace_root || '').trim() || null,
    cols.repos_json,
    cols.repo_url,
    cols.repo_urls_json,
    grok_sandbox,
    parseGitRefName(input.base_remote, 'origin'),
    parseGitRefName(input.base_branch, 'main'),
    makeDefault ? 1 : 0,
    ts,
    ts,
  );

  return getApp(db, id)!;
}

export function updateAppSettings(
  db: Db,
  appId: string,
  patch: {
    name?: string;
    description?: string;
    workspace_root?: string;
    repos?: string[];
    repo_entries?: Array<RepoEntryInput | string> | null;
    repo_url?: string | null;
    repo_urls?: string[] | null;
    grok_sandbox?: GrokSandboxProfile | string;
    base_remote?: string;
    base_branch?: string;
    default?: boolean;
  },
): AppRecord {
  const id = canonicalizeAppId(appId);
  const cur = getApp(db, id);
  if (!cur) throw new Error(`unknown app_id: ${appId}`);

  const next = { ...cur };
  if (patch.name !== undefined) next.name = String(patch.name).trim() || cur.name;
  if (patch.description !== undefined) {
    next.description = String(patch.description).trim() || undefined;
  }
  if (patch.workspace_root !== undefined) {
    next.workspace_root = String(patch.workspace_root).trim() || undefined;
  }
  if (patch.grok_sandbox !== undefined) {
    next.grok_sandbox = parseGrokSandbox(patch.grok_sandbox);
  }
  if (patch.base_remote !== undefined) {
    next.base_remote = parseGitRefName(patch.base_remote, 'origin');
  }
  if (patch.base_branch !== undefined) {
    next.base_branch = parseGitRefName(patch.base_branch, 'main');
  }

  let entries: AppRepoEntry[] = cur.repo_entries?.length
    ? [...cur.repo_entries]
    : entriesFromAppInput({
        repos: cur.repos,
        repo_url: cur.repo_url,
        repo_urls: cur.repo_urls,
      });

  if (patch.repo_entries !== undefined) {
    entries =
      patch.repo_entries === null
        ? []
        : normalizeRepoEntries(patch.repo_entries);
  } else if (patch.repo_urls !== undefined || patch.repo_url !== undefined) {
    const urls =
      patch.repo_urls !== undefined
        ? (patch.repo_urls ?? [])
            .flatMap((s) => String(s).split(/[\n,]+/))
            .map((s) => s.trim())
            .filter(Boolean)
        : patch.repo_url
          ? [String(patch.repo_url).trim()].filter(Boolean)
          : [];
    const names =
      patch.repos !== undefined
        ? patch.repos.map((r) => String(r).trim()).filter(Boolean)
        : entries.map((e) => e.name);
    entries = urls.length
      ? urls.map((url, i) => ({
          name: names[i] || nameFromRepoUrl(url),
          url,
        }))
      : names.map((name) => ({ name, url: '' }));
  } else if (patch.repos !== undefined) {
    entries = patch.repos
      .map((r, i) => ({
        name: String(r).trim(),
        url: entries[i]?.url ?? '',
      }))
      .filter((e) => e.name);
  }

  next.repo_entries = entries;
  next.repos = entries.map((e) => e.name);
  const urls = entries.map((e) => e.url).filter(Boolean);
  next.repo_url = urls.length === 1 ? urls[0] : undefined;
  next.repo_urls = urls.length > 1 ? urls : undefined;

  if (patch.default === true) {
    db.prepare('UPDATE apps SET is_default = 0').run();
    next.default = true;
  } else if (patch.default === false) {
    next.default = false;
  }

  const cols = persistRepoColumns(entries);
  const ts = nowIso();
  db.prepare(
    `UPDATE apps SET
      name = ?, description = ?, workspace_root = ?, repos_json = ?,
      repo_url = ?, repo_urls_json = ?, grok_sandbox = ?, base_remote = ?,
      base_branch = ?, is_default = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.name,
    next.description ?? null,
    next.workspace_root ?? null,
    cols.repos_json,
    cols.repo_url,
    cols.repo_urls_json,
    parseGrokSandbox(next.grok_sandbox),
    parseGitRefName(next.base_remote, 'origin'),
    parseGitRefName(next.base_branch, 'main'),
    next.default ? 1 : 0,
    ts,
    id,
  );

  return getApp(db, id)!;
}

export function deleteApp(db: Db, appId: string): void {
  const id = canonicalizeAppId(appId);
  if (!isSafeAppId(id)) throw new Error(`invalid app_id: ${appId}`);
  const cur = getApp(db, id);
  if (!cur) throw new Error(`unknown app_id: ${appId}`);
  const wasDefault = !!cur.default;
  db.prepare('DELETE FROM apps WHERE id = ?').run(id);
  if (wasDefault) {
    const next = db
      .prepare('SELECT id FROM apps ORDER BY name LIMIT 1')
      .get() as { id: string } | undefined;
    if (next) {
      db.prepare('UPDATE apps SET is_default = 1 WHERE id = ?').run(next.id);
    }
  }
}

export function resolvePrimaryRepos(
  db: Db,
  opts: {
    app_id: string;
    defectRepos: string[][];
  },
): Record<string, string> {
  const app = getApp(db, opts.app_id);
  const names = new Set<string>();
  for (const list of opts.defectRepos) {
    for (const r of list) {
      const n = r.trim();
      if (n) names.add(n);
    }
  }
  if (!names.size && app?.repos?.length) {
    for (const r of app.repos) names.add(r);
  }

  const workspace =
    app?.workspace_root?.trim() ||
    process.env.DEFECT_PRODUCT_WORKSPACE_ROOT?.trim() ||
    '';

  if (!workspace) {
    throw new Error(
      `app ${opts.app_id} has no local workspace_root and no repo URLs — set repo URL(s) in Settings`,
    );
  }

  const out: Record<string, string> = {};
  for (const repo of names) {
    const abs = path.isAbsolute(repo)
      ? repo
      : path.resolve(workspace, repo);
    out[path.basename(repo)] = abs;
  }
  return out;
}

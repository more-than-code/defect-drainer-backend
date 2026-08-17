import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  createBatchWorktrees,
  fetchBaseRef,
  isGitRepo,
  isOsascriptUserCancel,
  listRepoBranches,
  parseOsascriptFolderPath,
  removeBatchWorktrees,
  resolveBaseRef,
} from '../src/worktrees.js';

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
}

describe('batch worktrees', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wt-'));
  const primaryA = path.join(root, 'repo-a');
  const primaryB = path.join(root, 'repo-b');
  const wtRoot = path.join(root, 'worktrees');

  after(() => rmSync(root, { recursive: true, force: true }));

  it('creates isolated worktrees on a dedicated branch', () => {
    initRepo(primaryA);
    initRepo(primaryB);
    assert.equal(isGitRepo(primaryA), true);

    const bindings = createBatchWorktrees({
      batchId: 'BATCH-20260808-test1',
      worktreesRoot: wtRoot,
      primaryByRepo: {
        'repo-a': primaryA,
        'repo-b': primaryB,
      },
    });

    assert.equal(bindings.length, 2);
    for (const b of bindings) {
      assert.ok(existsSync(b.worktreeAbs));
      assert.ok(isGitRepo(b.worktreeAbs));
      assert.equal(b.branch, 'defect-drainer/BATCH-20260808-test1');
      const head = git(b.worktreeAbs, ['rev-parse', '--abbrev-ref', 'HEAD']);
      assert.equal(head, b.branch);
      // primary still on main
      assert.equal(git(b.primaryAbs, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    }

    // write only in worktree
    writeFileSync(path.join(bindings[0]!.worktreeAbs, 'fix.txt'), 'ok\n');
    assert.equal(existsSync(path.join(primaryA, 'fix.txt')), false);

    removeBatchWorktrees(bindings);
    assert.equal(existsSync(bindings[0]!.worktreeAbs), false);
  });
});

describe('worktree base ref', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wt-base-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  /** Clone of a local bare "origin" — no network. */
  function repoWithRemote(name: string): { clone: string; bare: string } {
    const seed = path.join(root, `${name}-seed`);
    const bare = path.join(root, `${name}.git`);
    const clone = path.join(root, name);
    initRepo(seed);
    git(seed, ['checkout', '-b', 'dev']);
    writeFileSync(path.join(seed, 'dev.txt'), 'dev\n');
    git(seed, ['add', '.']);
    git(seed, ['commit', '-m', 'dev commit']);
    git(seed, ['checkout', 'main']);
    execFileSync('git', ['clone', '--bare', seed, bare], { encoding: 'utf8' });
    execFileSync('git', ['clone', bare, clone], { encoding: 'utf8' });
    git(clone, ['config', 'user.email', 'test@example.com']);
    git(clone, ['config', 'user.name', 'Test']);
    return { clone, bare };
  }

  it('prefers the remote-tracking ref over a stale local branch', () => {
    const { clone, bare } = repoWithRemote('remote-wins');

    // Advance origin/main, then fetch: origin/main moves, local main stays put.
    const other = path.join(root, 'remote-wins-push');
    execFileSync('git', ['clone', bare, other], { encoding: 'utf8' });
    git(other, ['config', 'user.email', 'test@example.com']);
    git(other, ['config', 'user.name', 'Test']);
    writeFileSync(path.join(other, 'newer.txt'), 'newer\n');
    git(other, ['add', '.']);
    git(other, ['commit', '-m', 'newer on origin/main']);
    git(other, ['push', 'origin', 'main']);
    git(clone, ['fetch', 'origin']);

    const localMain = git(clone, ['rev-parse', 'main']);
    const originMain = git(clone, ['rev-parse', 'origin/main']);
    assert.notEqual(localMain, originMain, 'local main is stale by construction');

    const base = resolveBaseRef(clone, { remote: 'origin', branch: 'main' });
    assert.equal(base.ref, 'origin/main');
    assert.equal(base.branch, 'main');
    assert.equal(base.resolvedFrom, 'remote');

    // The worktree must start from the remote commit, not the stale local one.
    const wtRoot = path.join(root, 'wt-remote');
    const bindings = createBatchWorktrees({
      batchId: 'BATCH-20260817-remote',
      worktreesRoot: wtRoot,
      primaryByRepo: { 'remote-wins': clone },
      base: { remote: 'origin', branch: 'main' },
    });
    assert.equal(
      git(bindings[0]!.worktreeAbs, ['rev-parse', 'HEAD']),
      originMain,
    );
    removeBatchWorktrees(bindings);
  });

  it('honours a configured base branch', () => {
    const { clone } = repoWithRemote('dev-base');
    const base = resolveBaseRef(clone, { remote: 'origin', branch: 'dev' });
    assert.equal(base.ref, 'origin/dev');
    assert.equal(base.branch, 'dev', 'PR target follows the configured branch');

    const bindings = createBatchWorktrees({
      batchId: 'BATCH-20260817-dev',
      worktreesRoot: path.join(root, 'wt-dev'),
      primaryByRepo: { 'dev-base': clone },
      base: { remote: 'origin', branch: 'dev' },
    });
    assert.equal(
      git(bindings[0]!.worktreeAbs, ['rev-parse', 'HEAD']),
      git(clone, ['rev-parse', 'origin/dev']),
    );
    removeBatchWorktrees(bindings);
  });

  it('falls back to the local branch when there is no remote', () => {
    const solo = path.join(root, 'no-remote');
    initRepo(solo);
    const base = resolveBaseRef(solo, { remote: 'origin', branch: 'main' });
    assert.equal(base.ref, 'main');
    assert.equal(base.resolvedFrom, 'local');
    assert.equal(base.branch, 'main');
  });

  it('falls back to master only when base branch is the default', () => {
    const legacy = path.join(root, 'master-repo');
    mkdirSync(legacy, { recursive: true });
    git(legacy, ['init', '-b', 'master']);
    git(legacy, ['config', 'user.email', 'test@example.com']);
    git(legacy, ['config', 'user.name', 'Test']);
    writeFileSync(path.join(legacy, 'README.md'), '# legacy\n');
    git(legacy, ['add', '.']);
    git(legacy, ['commit', '-m', 'init']);

    const dflt = resolveBaseRef(legacy, { remote: 'origin', branch: 'main' });
    assert.equal(dflt.ref, 'master');
    assert.equal(dflt.resolvedFrom, 'master');

    // A deliberately configured branch must not silently become master.
    const explicit = resolveBaseRef(legacy, {
      remote: 'origin',
      branch: 'release',
    });
    assert.equal(explicit.resolvedFrom, 'head');
    assert.equal(explicit.branch, 'release');
  });

  it('local base uses the checkout branch, not origin', () => {
    const { clone } = repoWithRemote('local-base');

    const other = path.join(root, 'local-base-push');
    execFileSync('git', ['clone', path.join(root, 'local-base.git'), other], {
      encoding: 'utf8',
    });
    git(other, ['config', 'user.email', 'test@example.com']);
    git(other, ['config', 'user.name', 'Test']);
    writeFileSync(path.join(other, 'newer.txt'), 'newer\n');
    git(other, ['add', '.']);
    git(other, ['commit', '-m', 'newer on origin/main']);
    git(other, ['push', 'origin', 'main']);
    git(clone, ['fetch', 'origin']);

    const localMain = git(clone, ['rev-parse', 'main']);
    const originMain = git(clone, ['rev-parse', 'origin/main']);
    assert.notEqual(localMain, originMain);

    const base = resolveBaseRef(clone, { remote: 'local', branch: 'main' });
    assert.equal(base.ref, 'main');
    assert.equal(base.resolvedFrom, 'local');
    assert.equal(fetchBaseRef(clone, { remote: 'local', branch: 'main' }), false);

    const bindings = createBatchWorktrees({
      batchId: 'BATCH-20260817-local',
      worktreesRoot: path.join(root, 'wt-local'),
      primaryByRepo: { 'local-base': clone },
      base: { remote: 'local', branch: 'main' },
    });
    assert.equal(
      git(bindings[0]!.worktreeAbs, ['rev-parse', 'HEAD']),
      localMain,
    );
    removeBatchWorktrees(bindings);
  });

  it('lists local heads and prefers per-repo base', () => {
    const solo = path.join(root, 'list-local');
    initRepo(solo);
    git(solo, ['checkout', '-b', 'dev']);
    writeFileSync(path.join(solo, 'dev.txt'), 'dev\n');
    git(solo, ['add', '.']);
    git(solo, ['commit', '-m', 'dev']);
    const listed = listRepoBranches({ source: 'local', location: solo });
    assert.ok(listed.branches.includes('main'));
    assert.ok(listed.branches.includes('dev'));
    assert.equal(listed.current, 'dev');

    const bindings = createBatchWorktrees({
      batchId: 'BATCH-20260817-per-repo',
      worktreesRoot: path.join(root, 'wt-per-repo'),
      primaryByRepo: { 'list-local': solo },
      base: { remote: 'origin', branch: 'main' },
      baseByRepo: { 'list-local': { remote: 'local', branch: 'dev' } },
    });
    assert.equal(
      git(bindings[0]!.worktreeAbs, ['rev-parse', 'HEAD']),
      git(solo, ['rev-parse', 'dev']),
    );
    removeBatchWorktrees(bindings);
  });

  it('parses Finder POSIX paths and treats AppleScript -128 as cancel', () => {
    assert.equal(
      parseOsascriptFolderPath('/Users/joe/workspace/tutored/ttd-webapp/\n'),
      '/Users/joe/workspace/tutored/ttd-webapp',
    );
    assert.throws(() => parseOsascriptFolderPath(''));
    assert.equal(
      isOsascriptUserCancel(new Error('osascript: User canceled. (-128)')),
      true,
    );
    assert.equal(isOsascriptUserCancel(new Error('boom')), false);
  });
});

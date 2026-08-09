import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  createBatchWorktrees,
  isGitRepo,
  removeBatchWorktrees,
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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseGitRepoUrl } from '../src/worktrees.js';

describe('parseGitRepoUrl', () => {
  it('parses https and git@ forms', () => {
    assert.equal(
      parseGitRepoUrl('https://github.com/acme/ttd-webapp.git').name,
      'ttd-webapp',
    );
    assert.equal(
      parseGitRepoUrl('git@github.com:acme/ttd-backend.git').name,
      'ttd-backend',
    );
  });

  it('rejects empty and path traversal', () => {
    assert.throws(() => parseGitRepoUrl(''), /empty/);
    assert.throws(() => parseGitRepoUrl('https://x/../y'), /\.\./);
  });
});

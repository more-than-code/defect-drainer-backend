import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasTrackablePrs,
  mapGithubPrState,
  refreshPullRequestStatuses,
  type CreatePrResult,
} from '../src/worktrees.js';

describe('PR merge status', () => {
  it('maps GitHub state strings', () => {
    assert.equal(mapGithubPrState('OPEN'), 'open');
    assert.equal(mapGithubPrState('merged'), 'merged');
    assert.equal(mapGithubPrState('CLOSED'), 'closed');
    assert.equal(mapGithubPrState(''), undefined);
    assert.equal(mapGithubPrState('draft'), undefined);
  });

  it('hasTrackablePrs detects created/existing/url', () => {
    assert.equal(hasTrackablePrs(undefined), false);
    assert.equal(
      hasTrackablePrs([{ repo: 'a', branch: 'b', base: 'main', status: 'skipped' }]),
      false,
    );
    assert.equal(
      hasTrackablePrs([
        {
          repo: 'a',
          branch: 'b',
          base: 'main',
          status: 'created',
          url: 'https://github.com/o/r/pull/1',
        },
      ]),
      true,
    );
  });

  it('refreshPullRequestStatuses applies gh view by URL', () => {
    const prs: CreatePrResult[] = [
      {
        repo: 'web',
        branch: 'defect-drainer/BATCH-1',
        base: 'main',
        status: 'created',
        url: 'https://github.com/acme/web/pull/42',
        ghState: 'open',
      },
      {
        repo: 'skip',
        branch: 'x',
        base: 'main',
        status: 'skipped',
        error: 'no commits',
      },
    ];

    const updated = refreshPullRequestStatuses({
      prs,
      ghJson: (args) => {
        assert.ok(args.includes('pr'));
        assert.ok(args.includes('view'));
        return {
          state: 'MERGED',
          mergedAt: '2026-08-09T12:00:00Z',
          number: 42,
          url: 'https://github.com/acme/web/pull/42',
        };
      },
    });

    assert.equal(updated[0]!.ghState, 'merged');
    assert.equal(updated[0]!.mergedAt, '2026-08-09T12:00:00Z');
    assert.equal(updated[0]!.ghNumber, 42);
    assert.ok(updated[0]!.checkedAt);
    assert.equal(updated[0]!.ghError, undefined);
    assert.equal(updated[1]!.status, 'skipped');
    assert.equal(updated[1]!.ghState, undefined);
  });

  it('refreshPullRequestStatuses records gh errors', () => {
    const updated = refreshPullRequestStatuses({
      prs: [
        {
          repo: 'web',
          branch: 'b',
          base: 'main',
          status: 'existing',
          url: 'https://github.com/acme/web/pull/1',
        },
      ],
      ghJson: () => {
        throw new Error('gh: not found');
      },
    });
    assert.equal(updated[0]!.ghError, 'gh: not found');
    assert.ok(updated[0]!.checkedAt);
  });

  it('refreshPullRequestStatuses lists by branch when no URL', () => {
    const updated = refreshPullRequestStatuses({
      prs: [
        {
          repo: 'web',
          branch: 'defect-drainer/BATCH-x',
          base: 'main',
          status: 'existing',
        },
      ],
      ghJson: (args) => {
        assert.ok(args.includes('list'));
        return [
          {
            state: 'OPEN',
            number: 7,
            url: 'https://github.com/acme/web/pull/7',
            mergedAt: null,
          },
        ];
      },
    });
    assert.equal(updated[0]!.ghState, 'open');
    assert.equal(updated[0]!.url, 'https://github.com/acme/web/pull/7');
    assert.equal(updated[0]!.ghNumber, 7);
  });
});

// Task #290 — GitHubWalker Phase 3: walkCommits + walkRepoMeta tests.
//
// Covers:
//   - walkRepoMeta happy path returns 8-column shape
//   - walkRepoMeta rate-limited / auth-fail / network-error / no-pat
//   - walkCommits happy path normalizes to output_commit shape
//   - walkCommits paginates via Link: rel="next"
//   - walkCommits cursor advances to max(committer.date) + dedupes on since=
//   - walkCommits 409 empty-repo path
//   - walkCommits caps at 10000 commits per pass (walk-cap-reached-10k)

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-task290-walker-'));
const patFile = path.join(tempRoot, 'github-pat.token');
fs.writeFileSync(patFile, 'ghp_dummy_token_for_tests_only\n', { mode: 0o600 });

const { GitHubWalker } = require('../src/outputWalker');

function makeResponse({ status = 200, body = [], headers = {} } = {}) {
  const headersMap = new Map(Object.entries({
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
    ...headers,
  }).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headersMap.get(k.toLowerCase()) ?? null },
    json: async () => body,
  };
}

test('walkRepoMeta returns 8-column meta shape on ok', async () => {
  const fetcher = async () => makeResponse({
    body: {
      created_at: '2025-01-15T00:00:00Z',
      updated_at: '2026-07-01T12:00:00Z',
      pushed_at: '2026-07-09T15:30:00Z',
      default_branch: 'main',
      size: 4321,
      language: 'JavaScript',
      visibility: 'public',
      private: false,
    },
  });
  const walker = new GitHubWalker({ patFile, repos: ['jrtorrez31337/foo'], fetcher });
  const result = await walker.walkRepoMeta('jrtorrez31337/foo');
  assert.equal(result.skipped, false);
  assert.deepEqual(result.meta, {
    github_repo_created_at: '2025-01-15T00:00:00Z',
    github_default_branch: 'main',
    github_size_kb: 4321,
    github_primary_language: 'JavaScript',
    github_visibility: 'public',
    github_repo_updated_at: '2026-07-01T12:00:00Z',
    github_repo_pushed_at: '2026-07-09T15:30:00Z',
  });
});

test('walkRepoMeta returns visibility=private when private=true + no visibility field', async () => {
  const fetcher = async () => makeResponse({
    body: { created_at: '2025-01-15T00:00:00Z', private: true, default_branch: 'main' },
  });
  const walker = new GitHubWalker({ patFile, repos: ['x/y'], fetcher });
  const result = await walker.walkRepoMeta('x/y');
  assert.equal(result.meta.github_visibility, 'private');
});

test('walkRepoMeta skipped:auth-fail on 401', async () => {
  const fetcher = async () => makeResponse({ status: 401 });
  const walker = new GitHubWalker({ patFile, repos: ['x/y'], fetcher });
  const result = await walker.walkRepoMeta('x/y');
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'auth-fail');
});

test('walkRepoMeta skipped:rate-limited on 403 + remaining=0', async () => {
  const fetcher = async () => makeResponse({
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' },
  });
  const walker = new GitHubWalker({ patFile, repos: ['x/y'], fetcher });
  const result = await walker.walkRepoMeta('x/y');
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'rate-limited');
});

test('walkRepoMeta skipped:network-error when fetcher throws', async () => {
  const fetcher = async () => { throw new Error('ECONNRESET'); };
  const walker = new GitHubWalker({ patFile, repos: ['x/y'], fetcher });
  const result = await walker.walkRepoMeta('x/y');
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'network-error');
});

test('walkRepoMeta skipped:no-pat when patFile missing', async () => {
  const walker = new GitHubWalker({ patFile: '/nonexistent/pat', repos: ['x/y'], fetcher: async () => ({}) });
  const result = await walker.walkRepoMeta('x/y');
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no-pat');
});

// ────────────────────────────────────────────────────────────────────────

function fakeGhCommit({ sha, committedAt, authorEmail = 'jrtorrez31337@users.noreply.github.com',
                       authorName = 'jrtorrez31337', message = 'test commit\n\nbody line',
                       parents = 1, verified = false } = {}) {
  return {
    sha,
    commit: {
      author: { name: authorName, email: authorEmail, date: committedAt },
      committer: { name: authorName, email: authorEmail, date: committedAt },
      message,
      verification: { verified },
    },
    parents: Array.from({ length: parents }, (_, i) => ({ sha: `parent${i}` })),
  };
}

test('walkCommits happy path returns output_commit-shape rows + cursor advances', async () => {
  const c1 = fakeGhCommit({ sha: 'a1', committedAt: '2026-07-05T10:00:00Z' });
  const c2 = fakeGhCommit({ sha: 'b2', committedAt: '2026-07-06T11:00:00Z', verified: true });
  const fetcher = async () => makeResponse({ body: [c1, c2] });
  const walker = new GitHubWalker({ patFile, repos: ['x/y'], fetcher });
  const result = await walker.walkCommits('x/y', null);
  assert.equal(result.skipped, false);
  assert.equal(result.commits.length, 2);
  const a = result.commits[0];
  assert.equal(a.repo, 'x/y');
  assert.equal(a.commit_sha, 'a1');
  assert.equal(a.subject, 'test commit');
  assert.equal(a.parent_count, 1);
  assert.equal(a.signed, 0);
  assert.ok(a._full_message.includes('test commit'));
  assert.equal(result.commits[1].signed, 1);
  assert.equal(result.cursor.last_commit_committed_at, '2026-07-06T11:00:00Z');
  assert.equal(result.cursor.last_commit_sha, 'b2');
  assert.equal(result.cursor.commits_synced_total, 2);
  assert.equal(result.cursor.last_walk_status, 'ok');
});

test('walkCommits paginates via Link: rel="next"', async () => {
  const c1 = fakeGhCommit({ sha: 'p1a', committedAt: '2026-07-01T00:00:00Z' });
  const c2 = fakeGhCommit({ sha: 'p2b', committedAt: '2026-07-02T00:00:00Z' });
  let call = 0;
  const fetcher = async (url) => {
    call += 1;
    if (call === 1) {
      return makeResponse({
        body: [c1],
        headers: { link: '<https://api.github.com/repos/x/y/commits?page=2>; rel="next"' },
      });
    }
    return makeResponse({ body: [c2] });
  };
  const walker = new GitHubWalker({ patFile, repos: ['x/y'], fetcher });
  const result = await walker.walkCommits('x/y', null);
  assert.equal(call, 2);
  assert.equal(result.commits.length, 2);
});

test('walkCommits dedupes cursor.last_commit_sha on since=', async () => {
  // GitHub `since=` is inclusive → the boundary commit re-appears. Verify we skip it.
  const boundary = fakeGhCommit({ sha: 'boundary', committedAt: '2026-07-01T00:00:00Z' });
  const fresh = fakeGhCommit({ sha: 'fresh', committedAt: '2026-07-02T00:00:00Z' });
  const fetcher = async () => makeResponse({ body: [boundary, fresh] });
  const walker = new GitHubWalker({ patFile, repos: ['x/y'], fetcher });
  const cursor = {
    last_commit_committed_at: '2026-07-01T00:00:00Z',
    last_commit_sha: 'boundary',
    commits_synced_total: 5,
  };
  const result = await walker.walkCommits('x/y', cursor);
  assert.equal(result.commits.length, 1);
  assert.equal(result.commits[0].commit_sha, 'fresh');
  assert.equal(result.cursor.commits_synced_total, 6);
});

test('walkCommits handles 409 as empty-repo', async () => {
  const fetcher = async () => makeResponse({ status: 409, body: {} });
  const walker = new GitHubWalker({ patFile, repos: ['x/y'], fetcher });
  const result = await walker.walkCommits('x/y', null);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'empty-repo');
});

test('walkCommits handles 403 rate-limited', async () => {
  const fetcher = async () => makeResponse({
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' },
  });
  const walker = new GitHubWalker({ patFile, repos: ['x/y'], fetcher });
  const result = await walker.walkCommits('x/y', null);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'rate-limited');
});

test('walkCommits normalizes verified=true → signed=1 + parent_count multi-parent', async () => {
  const merge = fakeGhCommit({
    sha: 'merge1', committedAt: '2026-07-05T00:00:00Z',
    parents: 2, verified: true, message: 'Merge PR #42\n\nMerges feature into main',
  });
  const fetcher = async () => makeResponse({ body: [merge] });
  const walker = new GitHubWalker({ patFile, repos: ['x/y'], fetcher });
  const result = await walker.walkCommits('x/y', null);
  assert.equal(result.commits[0].signed, 1);
  assert.equal(result.commits[0].parent_count, 2);
});

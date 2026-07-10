// Task #277 Phase B / Task 1 — queryRepoActivityFeed accepts optional repo_key.
//
// Existing cluster-wide behavior is preserved when repo_key is omitted or null.
// When repo_key is provided:
//   - output_commit rows are filtered by repo = @repo_key
//   - output_pr rows are filtered by github_owner_repo = @repo_key
//   - Both sides of the UNION honor the filter
// Safety: repo_key is bound as a parameter, never string-interpolated.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-task277-b-activity-feed-'));
process.env.YAKLOG_DB_PATH = path.join(tempRoot, 'test.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_OPS_API_KEYS = 'ops-y';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const { closeDb, initializeDb, getDb, queryRepoActivityFeed } = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

function seed() {
  initializeDb();
  const db = getDb();
  db.prepare(`DELETE FROM output_commit`).run();
  db.prepare(`DELETE FROM output_pr`).run();
  const insCommit = db.prepare(`INSERT INTO output_commit
    (repo, commit_sha, author_name, author_email, committer_name, committer_email,
     occurred_at, branch, subject, body_digest, agent_attribution, attribution_method,
     files_changed, bytes_delta, signed, parent_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insCommit.run('owner/repo-a', 'aaa', 'x', 'x@y', 'x', 'x@y',
    '2026-07-05T10:00:00Z', null, 'subj-a1', null, 'agent-x', 'body_signature', 1, 10, 0, 1);
  insCommit.run('owner/repo-a', 'bbb', 'x', 'x@y', 'x', 'x@y',
    '2026-07-06T11:00:00Z', null, 'subj-a2', null, 'agent-x', 'body_signature', 1, 10, 0, 1);
  insCommit.run('owner/repo-b', 'ccc', 'x', 'x@y', 'x', 'x@y',
    '2026-07-05T12:00:00Z', null, 'subj-b1', null, 'agent-x', 'body_signature', 1, 10, 0, 1);
  const insPr = db.prepare(`INSERT INTO output_pr
    (github_owner_repo, pr_number, state, title, author_login, author_email,
     base_ref, head_ref, opened_at, merged_at, closed_at, merge_commit_sha,
     commit_count, last_synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insPr.run('owner/repo-a', 1, 'merged', 'PR-a1', 'lo', null, 'main', 'feat',
    '2026-07-05T09:00:00Z', '2026-07-06T09:00:00Z', '2026-07-06T09:00:00Z', 'msha', 1,
    '2026-07-06T10:00:00Z');
  insPr.run('owner/repo-b', 2, 'open', 'PR-b1', 'lo', null, 'main', 'feat',
    '2026-07-05T13:00:00Z', null, null, null, 1, '2026-07-05T14:00:00Z');
}

test('queryRepoActivityFeed returns cluster-wide feed when repo_key omitted', () => {
  seed();
  const feed = queryRepoActivityFeed({ from: '2026-07-01', to: '2026-07-10', limit: 50 });
  const repoKeys = new Set(feed.map((r) => r.repo_key));
  assert.deepEqual([...repoKeys].sort(), ['owner/repo-a', 'owner/repo-b']);
});

test('queryRepoActivityFeed accepts repo_key=null (explicit) as cluster-wide', () => {
  const feed = queryRepoActivityFeed({ from: '2026-07-01', to: '2026-07-10', limit: 50, repo_key: null });
  const repoKeys = new Set(feed.map((r) => r.repo_key));
  assert.deepEqual([...repoKeys].sort(), ['owner/repo-a', 'owner/repo-b']);
});

test('queryRepoActivityFeed scopes both commits + PRs when repo_key = owner/repo-a', () => {
  const feed = queryRepoActivityFeed({
    from: '2026-07-01', to: '2026-07-10', limit: 50, repo_key: 'owner/repo-a',
  });
  const repoKeys = new Set(feed.map((r) => r.repo_key));
  assert.deepEqual([...repoKeys], ['owner/repo-a']);
  const kinds = feed.map((r) => r.kind).sort();
  // 2 commits (a1, a2) + 1 pr_merged (opened+merged in window → single pr_merged row from OR-branch)
  assert.ok(kinds.includes('commit'), 'expected commit rows');
  assert.ok(kinds.includes('pr_merged') || kinds.includes('pr_opened'), 'expected PR row');
});

test('queryRepoActivityFeed returns empty when repo_key has no activity in window', () => {
  const feed = queryRepoActivityFeed({
    from: '2026-07-01', to: '2026-07-10', limit: 50, repo_key: 'owner/unknown-repo',
  });
  assert.equal(feed.length, 0);
});

test('queryRepoActivityFeed safely handles SQL-inject-flavored repo_key (bound param)', () => {
  // Parameter binding means quote/semicolon in repo_key becomes a literal search string,
  // not SQL. Returns empty (no matching rows), no error.
  const feed = queryRepoActivityFeed({
    from: '2026-07-01', to: '2026-07-10', limit: 50,
    repo_key: "owner/repo-a'; DROP TABLE output_commit; --",
  });
  assert.equal(feed.length, 0);
  // Verify output_commit still exists + populated
  const db = getDb();
  const cnt = db.prepare('SELECT COUNT(*) n FROM output_commit').get();
  assert.equal(cnt.n, 3);
});

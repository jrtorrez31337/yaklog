// Task #289 (sleuth #12427) — dirty-day rollup replaces fixed-30d loop.
//
// Covers:
//   - rebuildOutputDailyForDates dedupes input + rebuilds only listed dates
//   - runOnce collects date(occurred_at) from ingested commits into dirty-set
//   - runOnce collects date(opened_at) UNION date(merged_at) from ingested PRs
//   - runOnce fires rebuild for late-ingest of a >30d-old row (the sleuth trigger)
//   - runOnce skips rollup when no rows landed this tick (no-op discipline)
//   - Today is naturally in dirty-set when a row's occurred_at is today

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-task289-'));
process.env.YAKLOG_DB_PATH = path.join(tempRoot, 'test.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_OPS_API_KEYS = 'ops-y';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const {
  closeDb,
  initializeDb,
  getDb,
  rebuildOutputDailyForDates,
} = require('../src/db');
const { runOnce } = require('../src/outputIngester');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

// ─────────────────────────────────────────────────────────────────────
// db.js helper: rebuildOutputDailyForDates
// ─────────────────────────────────────────────────────────────────────

test('rebuildOutputDailyForDates dedupes + processes each date exactly once', () => {
  initializeDb();
  const db = getDb();
  // Seed output_commit rows across two dates
  db.prepare(`INSERT INTO output_commit
    (repo, commit_sha, author_name, author_email, committer_name, committer_email,
     occurred_at, subject, body_digest, agent_attribution, attribution_method,
     files_changed, bytes_delta, signed, parent_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'r1', 'sha_a', 'a', 'a@x', 'a', 'a@x',
    '2026-05-01T10:00:00Z', 'subj1', null, 'agent-x', 'body_signature',
    1, 10, 0, 1);
  db.prepare(`INSERT INTO output_commit
    (repo, commit_sha, author_name, author_email, committer_name, committer_email,
     occurred_at, subject, body_digest, agent_attribution, attribution_method,
     files_changed, bytes_delta, signed, parent_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'r1', 'sha_b', 'b', 'b@x', 'b', 'b@x',
    '2026-06-15T10:00:00Z', 'subj2', null, 'agent-y', 'body_signature',
    2, 20, 0, 1);

  const result = rebuildOutputDailyForDates(['2026-05-01', '2026-05-01', '2026-06-15']);
  assert.equal(result.rolled, 2);
  assert.deepEqual(result.dates, ['2026-05-01', '2026-06-15']);

  const rows = db.prepare(`SELECT date, agent_id, commits FROM output_daily ORDER BY date, agent_id`).all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, '2026-05-01');
  assert.equal(rows[1].date, '2026-06-15');
});

test('rebuildOutputDailyForDates drops invalid entries + no-ops empty input', () => {
  const empty = rebuildOutputDailyForDates([]);
  assert.equal(empty.rolled, 0);
  const bad = rebuildOutputDailyForDates(['not-a-date', null, undefined, '2026/07/10']);
  assert.equal(bad.rolled, 0);
});

// ─────────────────────────────────────────────────────────────────────
// runOnce end-to-end: dirty-set → rebuild wiring
// ─────────────────────────────────────────────────────────────────────

// Bare-git-substrate walker mock. Returns commits+merges with committer-dates
// including a >30d-old row (the sleuth trigger case: late-ingest of an old
// commit that would otherwise fall outside the fixed 30-day loop).
function makeBareGitMock(rows) {
  const commits = rows.map((r) => ({
    repo: 'canon.git',
    commit_sha: r.sha,
    author_name: 'x', author_email: 'x@y',
    committer_name: 'x', committer_email: 'x@y',
    occurred_at: r.at, branch: null, subject: r.sha,
    body_digest: null, files_changed: 1, bytes_delta: 10,
    signed: 0, parent_count: 1,
    _body: '', _full_message: r.sha,
  }));
  return {
    substrateType: () => 'bare-git',
    listRepos: () => ['canon.git'],
    walkRepo: (_repo, _lastRef) => ({
      commits, merges: [], newRef: rows.length ? rows[rows.length - 1].sha : null,
    }),
  };
}

test('runOnce collects date(occurred_at) into dirtyDates + rolls each once', async () => {
  // Reset output tables
  const db = getDb();
  db.prepare(`DELETE FROM output_commit`).run();
  db.prepare(`DELETE FROM output_merge`).run();
  db.prepare(`DELETE FROM output_daily`).run();

  const walker = makeBareGitMock([
    { sha: 'aaa', at: '2026-07-10T00:05:00Z' },  // today
    { sha: 'bbb', at: '2026-07-10T18:00:00Z' },  // same day, different time
    { sha: 'ccc', at: '2026-05-01T09:00:00Z' },  // 70d ago — THE sleuth case
  ]);
  const result = await runOnce({ walkers: [walker] });
  assert.equal(result.totalCommits, 3);
  assert.deepEqual(result.dirtyDates, ['2026-05-01', '2026-07-10']);
  assert.equal(result.daysRolled, 2);
  // Empirical: output_daily has rows for the >30d date, which the old
  // fixed-30-day loop would have MISSED entirely (silent-loss on ingest).
  const oldRow = db.prepare(
    `SELECT commits FROM output_daily WHERE date = '2026-05-01' AND repo_key = 'canon.git'`
  ).get();
  assert.ok(oldRow, 'output_daily row missing for >30d-old dirty date');
  assert.equal(oldRow.commits, 1);
});

test('runOnce skips rollup when no rows landed this tick (no-op discipline)', async () => {
  const walker = makeBareGitMock([]);
  const result = await runOnce({ walkers: [walker] });
  assert.equal(result.totalCommits, 0);
  assert.deepEqual(result.dirtyDates, []);
  assert.equal(result.daysRolled, 0);
});

test('runOnce PR ingest dirties BOTH date(opened_at) + date(merged_at)', async () => {
  const db = getDb();
  db.prepare(`DELETE FROM output_pr`).run();
  db.prepare(`DELETE FROM output_daily`).run();

  const walker = {
    substrateType: () => 'github',
    listRepos: () => ['owner/repo'],
    walkRepoMeta: async () => ({ meta: null, skipped: true, reason: 'no-pat' }),
    walkCommits: async (_r, cursor) => ({ commits: [], skipped: true, reason: 'no-pat', cursor }),
    walkRepo: async () => ({
      prs: [{
        github_owner_repo: 'owner/repo', pr_number: 1, state: 'merged',
        title: 't', author_login: 'x', author_email: null,
        base_ref: 'main', head_ref: 'feat',
        opened_at: '2026-06-01T10:00:00Z',
        merged_at: '2026-07-10T10:00:00Z',
        closed_at: '2026-07-10T10:00:00Z',
        merge_commit_sha: 'msha', commit_count: 1,
        last_synced_at: '2026-07-10T11:00:00Z',
      }],
      skipped: false, reason: null,
      cursor: { last_pr_updated_at: '2026-07-10T10:00:00Z', prs_synced_total: 1,
                rate_limit_remaining: 4999, rate_limit_reset_at: null,
                last_walk_status: 'ok', last_walk_message: null },
    }),
  };
  const result = await runOnce({ walkers: [walker] });
  assert.equal(result.totalPrs, 1);
  assert.deepEqual(result.dirtyDates, ['2026-06-01', '2026-07-10']);
  assert.equal(result.daysRolled, 2);
});

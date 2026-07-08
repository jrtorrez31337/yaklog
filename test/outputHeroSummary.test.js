// ADR-0041 P1a — GET /api/v1/output/hero-summary endpoint tests.
// Contract locked at plexus-ui #11975 + s345 #11973:
//   - R1: repos_governed_total (all-time) + repo_count_active_window (window)
//   - R2: pr_merged_count_cumulative (lifetime, picker-invariant)
//   - Consolidation: attribution_integrity_pct (% attributed) + attribution_gap_count
//   - COVERAGE: attributed_agents (excludes 'unattributed' by construction)
//   - OUTCOME/operational: pending_bare_git_requests
//   - Time-lock proof: cluster_operating_since (MIN(messages.created_at))
//
// Coverage:
//   1. Endpoint returns 8-field shape (all cross-tier-safe fields present)
//   2. R1 expose-both: repos_governed_total ≥ repo_count_active_window
//   3. R2 lifetime is picker-invariant (same value across different windows)
//   4. Attribution %↔count parity: pct == round((total-gaps)/total * 100)
//   5. attributed_agents excludes 'unattributed' bucket
//   6. cluster_operating_since matches MIN(messages.created_at)
//   7. pending_bare_git_requests reflects listPendingBareGitRequests()
//   8. Fold-B tier-parity: response body contains ZERO tier-gated field keys
//   9. Empty-state safe: zero data → integrity_pct = 100, others = 0

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-hero-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-alice';
process.env.YAKLOG_OPS_API_KEYS = 'ops-key-hero';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const {
  closeDb,
  initializeDb,
  getDb,
  rollupOutputWindow,
  insertBareGitRequest,
  insertMessage,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// Seed a mix of commits/PRs across 2 dates + 3 repos + bus messages + a pending mint.
test.before(() => {
  const db = initializeDb();

  // 3 distinct repos ever governed; only 2 active in the [2026-07-01, 2026-07-03] window.
  const insertCommit = db.prepare(`INSERT INTO output_commit (
    repo, commit_sha, author_name, author_email, committer_name, committer_email,
    occurred_at, subject, agent_attribution, attribution_method
  ) VALUES (?, ?, 'Alice', 'a@x', 'Alice', 'a@x', ?, ?, ?, ?)`);
  // repo1: 5 commits on 2026-07-01 (3 alice attributed, 2 null_fallback)
  for (let i = 0; i < 3; i += 1) insertCommit.run('repo1.git', `a-${i}`, '2026-07-01T10:00:00Z', 'm', 'agent-alice', 'co_authored_by');
  for (let i = 0; i < 2; i += 1) insertCommit.run('repo1.git', `n-${i}`, '2026-07-01T10:00:00Z', 'm', null, 'null_fallback');
  // repo2: 2 commits on 2026-07-02 (bob)
  for (let i = 0; i < 2; i += 1) insertCommit.run('repo2.git', `b-${i}`, '2026-07-02T10:00:00Z', 'm', 'agent-bob', 'co_authored_by');
  // repo-old: 1 commit far outside window (proves repos_governed_total picks it up but active_window does not)
  insertCommit.run('repo-old.git', 'x-0', '2026-05-01T10:00:00Z', 'm', 'agent-alice', 'co_authored_by');

  // 2 merged PRs total (both lifetime-eligible)
  const insertPR = db.prepare(`INSERT INTO output_pr (
    github_owner_repo, pr_number, state, title, author_login, author_email,
    base_ref, head_ref, opened_at, merged_at, closed_at, last_synced_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insertPR.run('jon/repo1', 1, 'closed', 'PR1', 'alice-gh', 'a@x', 'main', 'f1',
    '2026-07-01T09:00:00Z', '2026-07-02T09:00:00Z', '2026-07-02T09:00:00Z', '2026-07-02T09:05:00Z');
  insertPR.run('jon/repo2', 2, 'closed', 'PR2', 'bob-gh', 'b@x', 'main', 'f2',
    '2026-04-01T09:00:00Z', '2026-04-02T09:00:00Z', '2026-04-02T09:00:00Z', '2026-04-02T09:05:00Z');

  // Rollup dates that seeded commits landed on so output_daily has rows.
  rollupOutputWindow({ daysBack: 120, endDateExclusive: '2026-07-04' });

  // Seed a couple of bus messages to give MIN(created_at) a real value.
  insertMessage({ channel: 'handoff', sender: 'agent-alice', body: 'first message' });
  insertMessage({ channel: 'status', sender: 'agent-bob', body: 'second message' });

  // Seed a pending bare-git-request.
  insertBareGitRequest({ repo_name: 'test-hero-pending', requested_by: 'agent-alice', purpose: 'test' });
});

// ── 1. endpoint returns 8-field cross-tier-safe shape ─────────────────────

test('GET /output/hero-summary — returns all 8 cross-tier-safe fields', async () => {
  const res = await request(app).get('/api/v1/output/hero-summary?from=2026-07-01&to=2026-07-03');
  assert.equal(res.statusCode, 200);
  const b = res.body;
  // Contract fields per plexus-ui #11975
  assert.ok('repos_governed_total' in b);
  assert.ok('repo_count_active_window' in b);
  assert.ok('pr_merged_count_cumulative' in b);
  assert.ok('attribution_integrity_pct' in b);
  assert.ok('attribution_gap_count' in b);
  assert.ok('attributed_agents' in b);
  assert.ok('pending_bare_git_requests' in b);
  assert.ok('cluster_operating_since' in b);
});

// ── 2. R1 expose-both discipline ──────────────────────────────────────────

test('GET /output/hero-summary — R1: repos_governed_total >= repo_count_active_window', async () => {
  const res = await request(app).get('/api/v1/output/hero-summary?from=2026-07-01&to=2026-07-03');
  const b = res.body;
  // Substrate reality: repo_key is polymorphic — bare-git path (repo1.git, repo2.git,
  // repo-old.git) AND github_owner_repo (jon/repo1, jon/repo2) both appear as distinct
  // rows in output_daily. All-time distinct = 5. This matches the "under governance"
  // substrate primitive per s345 #11973 (governance-scope proof, not window-activity).
  assert.equal(b.repos_governed_total, 5);
  assert.equal(b.repo_count_active_window, 3);      // repo1.git + repo2.git + jon/repo1 (PR1 opened+merged in window)
  assert.ok(b.repos_governed_total >= b.repo_count_active_window);
});

// ── 3. R2 lifetime is picker-invariant (window-independent) ───────────────

test('GET /output/hero-summary — R2: pr_merged_count_cumulative is picker-invariant', async () => {
  const narrow = await request(app).get('/api/v1/output/hero-summary?from=2026-07-01&to=2026-07-03');
  const wide = await request(app).get('/api/v1/output/hero-summary?from=2026-01-01&to=2026-12-31');
  assert.equal(narrow.body.pr_merged_count_cumulative, wide.body.pr_merged_count_cumulative);
  assert.equal(narrow.body.pr_merged_count_cumulative, 2);
});

// ── 4. Attribution %↔count parity (Call 1 consolidation invariant) ────────

test('GET /output/hero-summary — attribution %↔count parity holds', async () => {
  const res = await request(app).get('/api/v1/output/hero-summary?from=2026-07-01&to=2026-07-03');
  const b = res.body;
  // Recompute expected: total_commits = 5 (repo1 window) + 2 (repo2) = 7; null_fallback = 2
  // integrity_pct = round((7-2)/7 * 100) = 71
  assert.equal(b.attribution_gap_count, 2);
  assert.equal(b.attribution_integrity_pct, 71);
});

// ── 5. attributed_agents excludes 'unattributed' by construction ──────────

test('GET /output/hero-summary — attributed_agents excludes unattributed', async () => {
  const res = await request(app).get('/api/v1/output/hero-summary?from=2026-07-01&to=2026-07-03');
  // Substrate: agent_id includes bare-git author (agent-alice, agent-bob) AND
  // github_owner_repo author_login (alice-gh from PR1 opened+merged in window).
  // 'unattributed' bucket excluded per db.js:1491. bob-gh's PR2 is in April → outside window.
  assert.equal(res.body.attributed_agents, 3);
});

// ── 6. cluster_operating_since matches MIN(messages.created_at) ───────────

test('GET /output/hero-summary — cluster_operating_since is bus-first-message anchor', async () => {
  const res = await request(app).get('/api/v1/output/hero-summary?from=2026-07-01&to=2026-07-03');
  const minRow = getDb().prepare(`SELECT MIN(created_at) AS since FROM messages`).get();
  assert.equal(res.body.cluster_operating_since, minRow.since);
});

// ── 7. pending_bare_git_requests matches list helper ──────────────────────

test('GET /output/hero-summary — pending_bare_git_requests reflects listPendingBareGitRequests', async () => {
  const res = await request(app).get('/api/v1/output/hero-summary?from=2026-07-01&to=2026-07-03');
  assert.equal(res.body.pending_bare_git_requests, 1); // seeded 1 pending mint
});

// ── 8. Fold-B-by-construction: NO tier-gated field keys ───────────────────

test('GET /output/hero-summary — Fold-B: response contains ZERO tier-gated field keys', async () => {
  const res = await request(app).get('/api/v1/output/hero-summary?from=2026-07-01&to=2026-07-03');
  const forbiddenKeys = [
    'dollar_per_merged_pr', 'dollar_per_pr_merged', 'dollar_per_agent_cycle',
    'pr_merge_rate', 'time_to_merge_hours',
    'coord_msgs_per_pr', 'tool_invocations_per_pr', 'agents_engaged_per_pr',
    'commit_count', 'merge_count', 'pr_opened_count',   // raw activity-volume tier-gated
    'cost_usd', 'tokens_input', 'tokens_output',
    'pace', 'velocity', 'throughput_rate',
  ];
  for (const key of forbiddenKeys) {
    assert.ok(!(key in res.body),
      `hero-summary must not carry tier-gated field ${key}; found in response body`);
  }
});

// ── 9. Empty-state safe (integrity_pct = 100 when no commits) ─────────────

test('GET /output/hero-summary — empty window: integrity_pct=100 (no gaps to have)', async () => {
  const res = await request(app).get('/api/v1/output/hero-summary?from=2020-01-01&to=2020-01-31');
  assert.equal(res.body.attribution_gap_count, 0);
  assert.equal(res.body.attribution_integrity_pct, 100);
  assert.equal(res.body.attributed_agents, 0);
  assert.equal(res.body.repo_count_active_window, 0);
  // Lifetime fields unaffected by empty window (picker-invariant):
  assert.equal(res.body.pr_merged_count_cumulative, 2);
  assert.equal(res.body.repos_governed_total, 5);
});

// ── 10. Period preset (?period=30d) accepted ──────────────────────────────

test('GET /output/hero-summary — accepts ?period=30d', async () => {
  const res = await request(app).get('/api/v1/output/hero-summary?period=30d');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.period, '30d');
  assert.ok(res.body.from);
  assert.ok(res.body.to);
});

// ── 11. Invalid date shape → 400 ──────────────────────────────────────────

test('GET /output/hero-summary — invalid date → 400 ValidationError', async () => {
  const res = await request(app).get('/api/v1/output/hero-summary?from=not-a-date&to=2026-07-03');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'ValidationError');
});

// ── 12. _metadata envelope present per Task #258 canon ────────────────────

test('GET /output/hero-summary — carries _metadata envelope', async () => {
  const res = await request(app).get('/api/v1/output/hero-summary?period=30d');
  assert.ok(res.body._metadata);
  assert.ok(typeof res.body._metadata.as_of_unix === 'number');
  assert.equal(res.body._metadata.computed_empty_period, false);
});

// Task #288 — Trajectory Lens endpoint tests
// Sister-shape outputHeroSummary.test.js seeding pattern.
//
// Coverage:
//   1. queryOutputDailyTrajectory pure-fn: running-sum monotonic per key
//   2. Continuous points across zero-activity dates (curve renders flat, not gap)
//   3. top_n ranking by final cumulative
//   4. Unattributed filtered by default (agent pivot)
//   5. Repo pivot dimension works
//   6. Endpoint returns valid shape with _metadata
//   7. Fold-B classification — response has OUTCOME-class only (no ratio/velocity)
//   8. Malformed pivot/metric → 400

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-traj-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-alice';
process.env.YAKLOG_OPS_API_KEYS = 'ops-key-traj';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const {
  closeDb, initializeDb, getDb, rollupOutputWindow,
  queryOutputDailyTrajectory,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// Seed 3 agents × 3 dates × 2 repos, plus an unattributed row
test.before(() => {
  const db = initializeDb();
  const insertCommit = db.prepare(`INSERT INTO output_commit (
    repo, commit_sha, author_name, author_email, committer_name, committer_email,
    occurred_at, subject, agent_attribution, attribution_method
  ) VALUES (?, ?, 'X', 'x@x', 'X', 'x@x', ?, 'm', ?, 'co_authored_by')`);

  // date 2026-07-01: alice=5 in repo1, bob=2 in repo1
  for (let i = 0; i < 5; i += 1) insertCommit.run('repo1.git', `a1-${i}`, '2026-07-01T10:00:00Z', 'agent-alice');
  for (let i = 0; i < 2; i += 1) insertCommit.run('repo1.git', `b1-${i}`, '2026-07-01T10:00:00Z', 'agent-bob');

  // date 2026-07-02: alice=3 in repo2, unattributed=1 in repo1
  for (let i = 0; i < 3; i += 1) insertCommit.run('repo2.git', `a2-${i}`, '2026-07-02T10:00:00Z', 'agent-alice');
  const insertCommitNull = db.prepare(`INSERT INTO output_commit (
    repo, commit_sha, author_name, author_email, committer_name, committer_email,
    occurred_at, subject, agent_attribution, attribution_method
  ) VALUES (?, ?, 'X', 'x@x', 'X', 'x@x', ?, 'm', NULL, 'null_fallback')`);
  insertCommitNull.run('repo1.git', 'u2-0', '2026-07-02T10:00:00Z');

  // date 2026-07-04 (skips 2026-07-03 — zero-activity gap): carol=4 in repo1
  for (let i = 0; i < 4; i += 1) insertCommit.run('repo1.git', `c4-${i}`, '2026-07-04T10:00:00Z', 'agent-carol');

  rollupOutputWindow({ daysBack: 10, endDateExclusive: '2026-07-05' });
});

test('queryOutputDailyTrajectory — agent pivot returns running sum per key', () => {
  const r = queryOutputDailyTrajectory({
    from: '2026-07-01', to: '2026-07-04',
    pivot: 'agent', metric: 'commits', top_n: 5,
  });
  assert.equal(r.pivot, 'agent');
  assert.equal(r.metric, 'commits');
  assert.ok(r.series.length >= 2, 'at least alice + bob (unattributed excluded by default)');
  const alice = r.series.find((s) => s.key === 'agent-alice');
  assert.ok(alice, 'alice series present');
  // Alice: +5 on 2026-07-01, +3 on 2026-07-02, 0 on 2026-07-03, 0 on 2026-07-04 → cumulative 5, 8, 8, 8
  const values = alice.points.map((p) => p.value_cumulative);
  assert.deepEqual(values, [5, 8, 8, 8]);
});

test('trajectory — continuous points across zero-activity dates (curve flat, not gap)', () => {
  const r = queryOutputDailyTrajectory({
    from: '2026-07-01', to: '2026-07-04',
    pivot: 'agent', metric: 'commits',
  });
  const alice = r.series.find((s) => s.key === 'agent-alice');
  // 4 points for 4 dates (inclusive both ends) — even though 2026-07-03 has zero activity
  assert.equal(alice.points.length, 4);
  const dates = alice.points.map((p) => p.date);
  assert.deepEqual(dates, ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']);
});

test('trajectory — monotonic non-decreasing (running sum property)', () => {
  const r = queryOutputDailyTrajectory({
    from: '2026-07-01', to: '2026-07-04',
    pivot: 'agent', metric: 'commits',
  });
  for (const s of r.series) {
    let last = -1;
    for (const p of s.points) {
      assert.ok(p.value_cumulative >= last, `${s.key} monotonic: ${last} → ${p.value_cumulative}`);
      last = p.value_cumulative;
    }
  }
});

test('trajectory — top_n ranks by final cumulative', () => {
  const r = queryOutputDailyTrajectory({
    from: '2026-07-01', to: '2026-07-04',
    pivot: 'agent', metric: 'commits', top_n: 2,
  });
  assert.equal(r.series.length, 2);
  // Alice final=8; Carol final=4; Bob final=2 → top_n=2 keeps alice+carol
  const keys = r.series.map((s) => s.key);
  assert.ok(keys.includes('agent-alice'));
  assert.ok(keys.includes('agent-carol'));
  assert.equal(r._metadata.top_n, 2);
});

test('trajectory — unattributed excluded by default (agent pivot)', () => {
  const r = queryOutputDailyTrajectory({
    from: '2026-07-01', to: '2026-07-04',
    pivot: 'agent', metric: 'commits', top_n: 10,
  });
  assert.ok(!r.series.some((s) => s.key === 'unattributed'), 'unattributed dropped');
});

test('trajectory — include_unattributed=true surfaces unattributed bucket', () => {
  const r = queryOutputDailyTrajectory({
    from: '2026-07-01', to: '2026-07-04',
    pivot: 'agent', metric: 'commits', top_n: 10,
    include_unattributed: true,
  });
  assert.ok(r.series.some((s) => s.key === 'unattributed'));
});

test('trajectory — repo pivot dimension works', () => {
  const r = queryOutputDailyTrajectory({
    from: '2026-07-01', to: '2026-07-04',
    pivot: 'repo', metric: 'commits', top_n: 5,
  });
  assert.equal(r.pivot, 'repo');
  const repo1 = r.series.find((s) => s.key === 'repo1.git');
  assert.ok(repo1);
  // repo1 receives: 5+2=7 on 07-01, +1 on 07-02, 0 on 07-03, +4 on 07-04
  // Note: null-attr commits are counted at repo-tier (unlike agent-tier which drops them)
  const values = repo1.points.map((p) => p.value_cumulative);
  assert.deepEqual(values, [7, 8, 8, 12]);
});

test('endpoint GET /trajectory returns valid shape with _metadata', async () => {
  const r = await request(app).get('/api/v1/output/trajectory')
    .query({ from: '2026-07-01', to: '2026-07-04', pivot: 'agent', metric: 'commits' });
  assert.equal(r.status, 200);
  assert.equal(r.body.pivot, 'agent');
  assert.equal(r.body.metric, 'commits');
  assert.ok(Array.isArray(r.body.series));
  assert.ok(r.body._metadata);
  assert.ok(typeof r.body._metadata.as_of_unix === 'number');
});

test('endpoint — Fold-B tier-safety: response has OUTCOME-class only, no ratio/velocity', async () => {
  const r = await request(app).get('/api/v1/output/trajectory')
    .query({ from: '2026-07-01', to: '2026-07-04', pivot: 'agent', metric: 'commits' });
  // Response body should have NO ratio-tier keys — cumulative-count only.
  const body = JSON.stringify(r.body);
  const ratioTierKeys = ['dollar_per_', 'per_hour', 'per_agent_cycle', '_rate', 'ratio', 'velocity'];
  for (const k of ratioTierKeys) {
    assert.ok(!body.includes(k), `Fold-B: response contains ratio-tier key '${k}'`);
  }
});

test('endpoint — malformed pivot → 400', async () => {
  const r = await request(app).get('/api/v1/output/trajectory')
    .query({ from: '2026-07-01', to: '2026-07-04', pivot: 'bogus', metric: 'commits' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'ValidationError');
});

test('endpoint — malformed metric → 400', async () => {
  const r = await request(app).get('/api/v1/output/trajectory')
    .query({ from: '2026-07-01', to: '2026-07-04', pivot: 'agent', metric: 'bogus' });
  assert.equal(r.status, 400);
});

// Task #277 Phase B / Task 2 — optional repo_key filter.

test('queryOutputDailyTrajectory — repo_key filter scopes agent series to that repo', () => {
  const r = queryOutputDailyTrajectory({
    from: '2026-07-01', to: '2026-07-04',
    pivot: 'agent', metric: 'commits', top_n: 5,
    repo_key: 'repo2.git',
  });
  // repo2.git only has alice (3 commits on 07-02); bob + carol drop
  assert.equal(r.series.length, 1);
  assert.equal(r.series[0].key, 'agent-alice');
  assert.deepEqual(r.series[0].points.map((p) => p.value_cumulative), [0, 3, 3, 3]);
});

test('queryOutputDailyTrajectory — repo_key filter with pivot=repo returns single-repo series', () => {
  const r = queryOutputDailyTrajectory({
    from: '2026-07-01', to: '2026-07-04',
    pivot: 'repo', metric: 'commits', top_n: 5,
    repo_key: 'repo1.git',
  });
  assert.equal(r.series.length, 1);
  assert.equal(r.series[0].key, 'repo1.git');
  // repo1: 5+2=7 on 07-01, +1 (unattr) on 07-02, 0 on 07-03, +4 (carol) on 07-04
  assert.deepEqual(r.series[0].points.map((p) => p.value_cumulative), [7, 8, 8, 12]);
});

test('queryOutputDailyTrajectory — repo_key=null (default) preserves cluster-wide behavior', () => {
  const r = queryOutputDailyTrajectory({
    from: '2026-07-01', to: '2026-07-04',
    pivot: 'repo', metric: 'commits', top_n: 5,
    repo_key: null,
  });
  const keys = r.series.map((s) => s.key).sort();
  assert.deepEqual(keys, ['repo1.git', 'repo2.git']);
});

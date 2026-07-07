// CP17.B query endpoint tests per PLAN-CP17-CLUSTER-REPO-SUBSTRATE.md §5.
//
// Coverage:
//   rebuildOutputDailyForDate (idempotency + attribution bucket)
//   rollupOutputWindow (multi-day driver)
//   GET /summary                 (aggregate math vs direct query)
//   GET /heatmap                 (cells + scale + filters)
//   GET /list                    (per-repo aggregates + enrichment)
//   GET /:repo_key/detail        (drill-in shape)
//   GET /by-agent/:agent_id      (cross-repo view)
//   GET /agents-in-window        (Task 6 dropdown enum)
//   POST /ops/output-rollup/backfill (Task 2 backfill lifecycle)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp17b-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-alice';
process.env.YAKLOG_OPS_API_KEYS = 'ops-key-cp17b';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb, initializeDb, rebuildOutputDailyForDate, rollupOutputWindow, getDb } = require('../src/db');

const authOps = { Authorization: 'Bearer ops-key-cp17b' };

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// Seed output_commit, output_merge, output_pr fixture rows across 3 dates.
test.before(() => {
  const db = initializeDb();
  const insertCommit = db.prepare(`INSERT INTO output_commit (
    repo, commit_sha, author_name, author_email, committer_name, committer_email,
    occurred_at, subject, agent_attribution, attribution_method
  ) VALUES (?, ?, 'Alice', 'a@x', 'Alice', 'a@x', ?, ?, ?, 'test')`);
  // 2026-07-01: 5 commits on repo1 (3 alice, 2 unattributed) + 2 commits on repo2 (both bob)
  for (let i = 0; i < 3; i += 1) insertCommit.run('repo1.git', `a-2601-${i}`, '2026-07-01T10:00:00Z', `msg ${i}`, 'agent-alice');
  for (let i = 0; i < 2; i += 1) insertCommit.run('repo1.git', `n-2601-${i}`, '2026-07-01T10:00:00Z', `msg ${i}`, null);
  for (let i = 0; i < 2; i += 1) insertCommit.run('repo2.git', `b-2601-${i}`, '2026-07-01T10:00:00Z', `msg ${i}`, 'agent-bob');
  // 2026-07-02: 4 commits on repo1 (all alice)
  for (let i = 0; i < 4; i += 1) insertCommit.run('repo1.git', `a-2602-${i}`, '2026-07-02T10:00:00Z', `msg ${i}`, 'agent-alice');
  // 2026-07-03: 1 commit on repo3 (alice)
  insertCommit.run('repo3.git', 'a-2603-0', '2026-07-03T10:00:00Z', 'msg', 'agent-alice');

  // output_merge: 1 merge on repo1 on 2026-07-02 (alice)
  db.prepare(`INSERT INTO output_merge (
    repo, merge_commit_sha, target_branch, occurred_at, merged_by_agent, attribution_method
  ) VALUES (?, ?, ?, ?, ?, 'test')`).run('repo1.git', 'merge-2602-0', 'main', '2026-07-02T11:00:00Z', 'agent-alice');

  // output_pr: 1 opened on 2026-07-01, merged on 2026-07-02
  db.prepare(`INSERT INTO output_pr (
    github_owner_repo, pr_number, state, title, author_login, author_email,
    base_ref, head_ref, opened_at, merged_at, closed_at, last_synced_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'jon/repo1', 1, 'closed', 'PR1', 'alice-gh', 'a@x',
    'main', 'feature', '2026-07-01T09:00:00Z', '2026-07-02T09:00:00Z', '2026-07-02T09:00:00Z',
    '2026-07-02T09:05:00Z',
  );
});

// ── rebuildOutputDailyForDate (Task 1 unit tests) ─────────────────────────

test('rebuildOutputDailyForDate — bucket alice + null → attribution_gaps', () => {
  const r = rebuildOutputDailyForDate('2026-07-01');
  assert.equal(r.date, '2026-07-01');
  assert.ok(r.rows >= 2);  // at least alice + unattributed buckets
  const rows = getDb().prepare(
    `SELECT * FROM output_daily WHERE date = ? ORDER BY agent_id`
  ).all('2026-07-01');
  const alice = rows.find(x => x.agent_id === 'agent-alice');
  const bob = rows.find(x => x.agent_id === 'agent-bob');
  const unattributed = rows.find(x => x.agent_id === 'unattributed');
  assert.ok(alice); assert.equal(alice.commits, 3); assert.equal(alice.attribution_gaps, 0);
  assert.ok(bob); assert.equal(bob.commits, 2);
  assert.ok(unattributed); assert.equal(unattributed.commits, 2);
  assert.equal(unattributed.attribution_gaps, 2);  // count of null-attribution commits
});

test('rebuildOutputDailyForDate — idempotent (rerun same date yields identical rows)', () => {
  const before = getDb().prepare(`SELECT COUNT(*) AS n FROM output_daily WHERE date = ?`).get('2026-07-01').n;
  rebuildOutputDailyForDate('2026-07-01');
  const after = getDb().prepare(`SELECT COUNT(*) AS n FROM output_daily WHERE date = ?`).get('2026-07-01').n;
  assert.equal(before, after);
});

test('rebuildOutputDailyForDate — merges roll into (repo, agent) row', () => {
  rebuildOutputDailyForDate('2026-07-02');
  const row = getDb().prepare(
    `SELECT * FROM output_daily WHERE date = ? AND repo_key = ? AND agent_id = ?`
  ).get('2026-07-02', 'repo1.git', 'agent-alice');
  assert.ok(row);
  assert.equal(row.commits, 4);
  assert.equal(row.merges, 1);
});

test('rebuildOutputDailyForDate — PR opened_at vs merged_at buckets separately', () => {
  rebuildOutputDailyForDate('2026-07-01');  // opened_at
  rebuildOutputDailyForDate('2026-07-02');  // merged_at
  const opened = getDb().prepare(
    `SELECT SUM(prs_opened) AS n FROM output_daily WHERE date = ? AND repo_key = ?`
  ).get('2026-07-01', 'jon/repo1');
  const merged = getDb().prepare(
    `SELECT SUM(prs_merged) AS n FROM output_daily WHERE date = ? AND repo_key = ?`
  ).get('2026-07-02', 'jon/repo1');
  assert.equal(opened.n, 1);
  assert.equal(merged.n, 1);
});

test('rebuildOutputDailyForDate — invalid date shape → throws', () => {
  assert.throws(() => rebuildOutputDailyForDate('not-a-date'), /YYYY-MM-DD/);
  assert.throws(() => rebuildOutputDailyForDate('2026/07/01'), /YYYY-MM-DD/);
});

test('rollupOutputWindow — 3-day window covers all seeded dates', () => {
  const result = rollupOutputWindow({ daysBack: 30, endDateExclusive: '2026-07-04' });
  assert.equal(result.window_days, 30);
  assert.equal(result.rolled, 30);
  // Verify seeded dates present
  const dates = getDb().prepare(
    `SELECT DISTINCT date FROM output_daily ORDER BY date`
  ).all().map(r => r.date);
  assert.ok(dates.includes('2026-07-01'));
  assert.ok(dates.includes('2026-07-02'));
  assert.ok(dates.includes('2026-07-03'));
});

test('rollupOutputWindow — invalid daysBack rejects', () => {
  assert.throws(() => rollupOutputWindow({ daysBack: 0 }), /1..365/);
  assert.throws(() => rollupOutputWindow({ daysBack: 366 }), /1..365/);
  assert.throws(() => rollupOutputWindow({ daysBack: 'abc' }), /1..365/);
});

// ── /api/v1/plexus/public/repos/* (public reads) ──────────────────────────

test('GET /repos/summary — aggregate over from/to window', async () => {
  const res = await request(app).get('/api/v1/plexus/public/repos/summary?from=2026-07-01&to=2026-07-03');
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.commit_count > 0);
  assert.equal(res.body.from, '2026-07-01');
  assert.equal(res.body.to, '2026-07-03');
  // engaged_agents excludes 'unattributed' bucket; includes commit-attribution
  // (agent-alice, agent-bob) + PR author_login (alice-gh) per Task 1 PR-v1 design.
  assert.equal(res.body.engaged_agents, 3);  // agent-alice + agent-bob + alice-gh (PR)
  // attribution_gap_count aggregates the null-attribution commits
  assert.ok(res.body.attribution_gap_count >= 2);
});

test('GET /repos/summary — period=7d default resolver', async () => {
  const res = await request(app).get('/api/v1/plexus/public/repos/summary?period=7d');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.period, '7d');
  assert.ok(res.body.from);
  assert.ok(res.body.to);
});

test('GET /repos/summary — invalid from/to → 400', async () => {
  const res = await request(app).get('/api/v1/plexus/public/repos/summary?from=nope&to=nope');
  assert.equal(res.statusCode, 400);
});

test('GET /repos/heatmap — cells + scale', async () => {
  const res = await request(app).get('/api/v1/plexus/public/repos/heatmap?from=2026-07-01&to=2026-07-03&dim=commits');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dim, 'commits');
  assert.ok(Array.isArray(res.body.cells));
  assert.ok(res.body.scale);
  assert.ok(Number.isFinite(res.body.scale.min));
  assert.ok(Number.isFinite(res.body.scale.max));
  assert.ok(Number.isFinite(res.body.scale.p95));
});

test('GET /repos/heatmap — filter_repo narrows correctly', async () => {
  const all = await request(app).get('/api/v1/plexus/public/repos/heatmap?from=2026-07-01&to=2026-07-03&dim=commits');
  const filtered = await request(app).get('/api/v1/plexus/public/repos/heatmap?from=2026-07-01&to=2026-07-03&dim=commits&filter_repo=repo1.git');
  const sumAll = all.body.cells.reduce((a, c) => a + (c.value || 0), 0);
  const sumFiltered = filtered.body.cells.reduce((a, c) => a + (c.value || 0), 0);
  assert.ok(sumFiltered <= sumAll);
  assert.ok(sumFiltered > 0);
});

test('GET /repos/heatmap — filter_agent narrows correctly', async () => {
  const res = await request(app).get('/api/v1/plexus/public/repos/heatmap?from=2026-07-01&to=2026-07-03&dim=commits&filter_agent=agent-alice');
  assert.equal(res.statusCode, 200);
  // Should include alice commits (3+4+1=8) not bob (2) or unattributed (2)
  const total = res.body.cells.reduce((a, c) => a + (c.value || 0), 0);
  assert.equal(total, 8);
});

test('GET /repos/heatmap — invalid dim → 400', async () => {
  const res = await request(app).get('/api/v1/plexus/public/repos/heatmap?from=2026-07-01&to=2026-07-03&dim=nope');
  assert.equal(res.statusCode, 400);
});

test('GET /repos/list — per-repo aggregates + type enrichment', async () => {
  const res = await request(app).get('/api/v1/plexus/public/repos/list?from=2026-07-01&to=2026-07-03');
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.repos));
  const repo1 = res.body.repos.find(r => r.repo_key === 'repo1.git');
  assert.ok(repo1);
  // repo1: 5 (07-01) + 4 (07-02) = 9 commits
  assert.equal(repo1.commit_count, 9);
  // type = bare-git (not in output_repo table)
  assert.equal(repo1.type, 'bare-git');
});

test('GET /repos/list — github type enrichment via output_repo', async () => {
  // Seed output_repo entry for jon/repo1
  await request(app).post('/api/v1/ops/output/repos')
    .set(authOps)
    .send({ github_owner_repo: 'jon/repo1' });
  const res = await request(app).get('/api/v1/plexus/public/repos/list?from=2026-07-01&to=2026-07-03');
  const gh = res.body.repos.find(r => r.repo_key === 'jon/repo1');
  assert.ok(gh);
  assert.equal(gh.type, 'github');
  assert.equal(gh.registered, true);
});

test('GET /repos/:repo_key/detail — per-repo drill-in', async () => {
  const res = await request(app).get('/api/v1/plexus/public/repos/repo1.git/detail?from=2026-07-01&to=2026-07-03');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.repo_key, 'repo1.git');
  assert.ok(Array.isArray(res.body.timeline));
  assert.ok(Array.isArray(res.body.agents));
  assert.ok(Array.isArray(res.body.commits));
  assert.ok(Array.isArray(res.body.prs));
  // agents list: alice + unattributed for repo1
  const alice = res.body.agents.find(a => a.agent_id === 'agent-alice');
  assert.ok(alice);
  assert.equal(alice.commit_count, 7);  // 3 + 4
});

test('GET /repos/by-agent/:agent_id — cross-repo view', async () => {
  const res = await request(app).get('/api/v1/plexus/public/repos/by-agent/agent-alice?from=2026-07-01&to=2026-07-03');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.agent_id, 'agent-alice');
  assert.ok(Array.isArray(res.body.repos));
  // alice touched repo1 (7 commits) + repo3 (1 commit)
  const repoKeys = res.body.repos.map(r => r.repo_key).sort();
  assert.deepEqual(repoKeys, ['repo1.git', 'repo3.git']);
});

test('GET /repos/agents-in-window — Task 6 dropdown enumeration', async () => {
  const res = await request(app).get('/api/v1/plexus/public/repos/agents-in-window?from=2026-07-01&to=2026-07-03');
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.agents));
  // 'unattributed' excluded per canon
  const ids = res.body.agents.map(a => a.agent_id);
  assert.ok(ids.includes('agent-alice'));
  assert.ok(ids.includes('agent-bob'));
  assert.ok(!ids.includes('unattributed'), 'unattributed bucket must be excluded from agent-filter enum');
  // Sorted by commit_count DESC
  for (let i = 1; i < res.body.agents.length; i += 1) {
    assert.ok(res.body.agents[i - 1].commit_count >= res.body.agents[i].commit_count);
  }
});

test('GET /repos/agents-in-window — limit param bounded', async () => {
  const res = await request(app).get('/api/v1/plexus/public/repos/agents-in-window?from=2026-07-01&to=2026-07-03&limit=999');
  assert.equal(res.statusCode, 200);
  // limit is capped internally at 500; server just enforces bound, doesn't 400
});

// ── POST /ops/output-rollup/backfill (Task 2) ────────────────────────────

test('POST /ops/output/output-rollup/backfill — happy path', async () => {
  const res = await request(app)
    .post('/api/v1/ops/output/output-rollup/backfill')
    .set(authOps)
    .send({ days_back: 7, end_date_exclusive: '2026-07-04' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.window_days, 7);
  assert.equal(res.body.days_rolled, 7);
  assert.ok(Number.isFinite(res.body.output_daily_rows));
  assert.ok(res.body.actor.startsWith('ops:'));
});

test('POST /ops/output/output-rollup/backfill — 400 on invalid days_back', async () => {
  const res = await request(app)
    .post('/api/v1/ops/output/output-rollup/backfill')
    .set(authOps)
    .send({ days_back: 0 });
  assert.equal(res.statusCode, 400);
});

test('POST /ops/output/output-rollup/backfill — 401/403 without ops-key', async () => {
  const res = await request(app)
    .post('/api/v1/ops/output/output-rollup/backfill')
    .set({ Authorization: 'Bearer tok-alice' })
    .send({ days_back: 7 });
  assert.ok(res.statusCode === 401 || res.statusCode === 403);
});

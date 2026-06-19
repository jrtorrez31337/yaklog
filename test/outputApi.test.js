// CP13.3 / ADR-0032 Phase 1.3 — output API endpoint tests
//
// 7 endpoints (5 public + 2 ops-key gated) + SERVER-SIDE Fold B HARD GATE
// enforcement verification (s345 #9234 §5.6 canonical: activity-numerator
// ratios never emit at buyer or investor audience regardless of client
// request).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp133-api-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_OPS_API_KEYS = 'ops-y';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb, initializeDb } = require('../src/db');

// ── seed substrate: cost_daily + messages + output_commit + output_merge ──

test.before(() => {
  const db = initializeDb();
  const today = new Date().toISOString().slice(0, 10);
  // Cost: $100 today
  db.prepare(`INSERT INTO cost_daily (date, agent_id, model, cost_usd, computed_at)
    VALUES (?, ?, 'claude', 100.0, datetime('now'))`).run(today, 'yaklog-dev-agent');
  // Messages: 50 from 2 agents in last 30d
  const insertMsg = db.prepare(`INSERT INTO messages (channel, sender, body, created_at)
    VALUES ('handoff', ?, 'test', datetime('now'))`);
  for (let i = 0; i < 30; i += 1) insertMsg.run('yaklog-dev-agent');
  for (let i = 0; i < 20; i += 1) insertMsg.run('parch-agent');
  // Output commits: 10 (5 attributed, 5 null-fallback) + 2 merges
  const insertCommit = db.prepare(`INSERT INTO output_commit (
    repo, commit_sha, author_name, author_email, committer_name, committer_email,
    occurred_at, subject, agent_attribution, attribution_method
  ) VALUES ('yaklog.git', ?, 'Jon', 'j@x', 'Jon', 'j@x', datetime('now'), ?, ?, ?)`);
  for (let i = 0; i < 5; i += 1) {
    insertCommit.run(`attrib-${i}`, `commit ${i}`, 'yaklog-dev-agent', 'co_authored_by');
  }
  for (let i = 0; i < 5; i += 1) {
    insertCommit.run(`null-${i}`, `commit ${i}`, null, 'null_fallback');
  }
  const insertMerge = db.prepare(`INSERT INTO output_merge (
    repo, merge_commit_sha, target_branch, occurred_at, merged_by_agent
  ) VALUES ('yaklog.git', ?, 'main', datetime('now'), ?)`);
  insertMerge.run('m1', 'yaklog-dev-agent');
  insertMerge.run('m2', 'parch-agent');
});

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ── GET /ratios with Fold B HARD GATE ─────────────────────────────────────

test('GET /api/v1/output/ratios?audience=buyer returns ONLY cross-tier-safe ratios', async () => {
  const res = await request(app).get('/api/v1/output/ratios?audience=buyer');
  assert.equal(res.status, 200);
  assert.equal(res.body._audience, 'buyer');
  // Cross-tier-safe present
  assert.ok('dollar_per_merged_pr' in res.body);
  assert.ok('dollar_per_agent_cycle' in res.body);
  // PRACTITIONER-ONLY stripped at substrate level
  assert.ok(!('coord_messages_per_merged_pr' in res.body),
    'Fold B HARD GATE: coord_messages_per_merged_pr MUST NOT emit at buyer');
  assert.ok(!('tool_invocations_per_merged_pr' in res.body),
    'Fold B HARD GATE: tool_invocations_per_merged_pr MUST NOT emit at buyer');
  assert.ok(!('agents_engaged_per_merged_pr' in res.body),
    'Fold B HARD GATE: agents_engaged_per_merged_pr MUST NOT emit at buyer');
});

test('GET /api/v1/output/ratios?audience=investor strips activity-numerator (Fold B HARD GATE)', async () => {
  const res = await request(app).get('/api/v1/output/ratios?audience=investor');
  assert.equal(res.status, 200);
  assert.equal(res.body._audience, 'investor');
  assert.ok(!('coord_messages_per_merged_pr' in res.body),
    'Fold B HARD GATE: investor audience MUST NOT receive activity-numerator');
  assert.ok(!('tool_invocations_per_merged_pr' in res.body));
  assert.ok(!('agents_engaged_per_merged_pr' in res.body));
});

test('GET /api/v1/output/ratios?audience=practitioner returns ALL ratios (Phase 1: 5 of 7)', async () => {
  const res = await request(app).get('/api/v1/output/ratios?audience=practitioner');
  assert.equal(res.status, 200);
  assert.equal(res.body._audience, 'practitioner');
  for (const expected of [
    'dollar_per_merged_pr',
    'dollar_per_agent_cycle',
    'coord_messages_per_merged_pr',
    'tool_invocations_per_merged_pr',
    'agents_engaged_per_merged_pr',
  ]) {
    assert.ok(expected in res.body, `practitioner lens should include ${expected}`);
  }
});

test('GET /api/v1/output/ratios computes $/merged-PR correctly ($100 / 2 merges = $50)', async () => {
  const res = await request(app).get('/api/v1/output/ratios?audience=practitioner');
  assert.equal(res.body.dollar_per_merged_pr, 50);
  assert.equal(res.body._merges, 2);
  assert.equal(res.body._cost_usd, 100);
});

test('GET /api/v1/output/ratios default audience is buyer (s345 #9234 Criterion 5)', async () => {
  const res = await request(app).get('/api/v1/output/ratios');
  assert.equal(res.body._audience, 'buyer');
  assert.ok(!('coord_messages_per_merged_pr' in res.body));
});

test('GET /api/v1/output/ratios rejects invalid audience', async () => {
  const res = await request(app).get('/api/v1/output/ratios?audience=ceo');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'ValidationError');
});

// ── GET /composition ──────────────────────────────────────────────────────

test('GET /api/v1/output/composition?by=agent returns per-agent rows', async () => {
  const res = await request(app).get('/api/v1/output/composition?by=agent');
  assert.equal(res.status, 200);
  assert.equal(res.body.by, 'agent');
  assert.ok(Array.isArray(res.body.rows));
  const yaklogDev = res.body.rows.find((r) => r.agent_id === 'yaklog-dev-agent');
  assert.ok(yaklogDev);
  assert.equal(yaklogDev.merges, 1);
  assert.equal(yaklogDev.coord_msgs, 30);
});

test('GET /api/v1/output/composition?by=repo returns per-repo rows', async () => {
  const res = await request(app).get('/api/v1/output/composition?by=repo');
  assert.equal(res.status, 200);
  assert.equal(res.body.by, 'repo');
  const yaklogRepo = res.body.rows.find((r) => r.repo === 'yaklog.git');
  assert.ok(yaklogRepo);
  assert.equal(yaklogRepo.commits, 10);
  assert.equal(yaklogRepo.merges, 2);
});

test('GET /api/v1/output/composition rejects invalid by', async () => {
  const res = await request(app).get('/api/v1/output/composition?by=nonsense');
  assert.equal(res.status, 400);
});

// ── GET /coverage-gap ─────────────────────────────────────────────────────

test('GET /api/v1/output/coverage-gap reports null_fallback count + sample', async () => {
  const res = await request(app).get('/api/v1/output/coverage-gap');
  assert.equal(res.status, 200);
  assert.equal(res.body.total_commits, 10);
  assert.equal(res.body.null_fallback_count, 5);
  assert.equal(res.body.co_authored_by_count, 5);
  assert.equal(res.body.null_fallback_pct, 50);
  assert.ok(Array.isArray(res.body.sample));
  assert.equal(res.body.sample.length, 5, 'sample should include all 5 null-fallback commits');
});

// ── GET /merges ───────────────────────────────────────────────────────────

test('GET /api/v1/output/merges?agent=<id> returns per-agent merge list', async () => {
  const res = await request(app).get('/api/v1/output/merges?agent=yaklog-dev-agent');
  assert.equal(res.status, 200);
  assert.equal(res.body.agent, 'yaklog-dev-agent');
  assert.equal(res.body.rows.length, 1);
  assert.equal(res.body.rows[0].merge_commit_sha, 'm1');
});

test('GET /api/v1/output/merges requires agent query param', async () => {
  const res = await request(app).get('/api/v1/output/merges');
  assert.equal(res.status, 400);
});

// ── GET /anomalies ────────────────────────────────────────────────────────

test('GET /api/v1/output/anomalies returns spike detection shape', async () => {
  const res = await request(app).get('/api/v1/output/anomalies');
  assert.equal(res.status, 200);
  assert.ok('today_cost_usd' in res.body);
  assert.ok('prior_mean_usd' in res.body);
  assert.ok('threshold' in res.body);
  assert.ok('is_spike' in res.body);
  assert.equal(res.body.threshold, 2.0);
});

test('GET /api/v1/output/anomalies rejects invalid threshold', async () => {
  const res = await request(app).get('/api/v1/output/anomalies?threshold=-1');
  assert.equal(res.status, 400);
});

// ── OPS: PUT /attribution (ops-key gated) ─────────────────────────────────

test('PUT /api/v1/ops/output/attribution rejects without ops-key', async () => {
  const res = await request(app)
    .put('/api/v1/ops/output/attribution')
    .send({ repo: 'yaklog.git', commit_sha: 'attrib-0', agent_attribution: 'new-agent' });
  assert.equal(res.status, 401);
});

test('PUT /api/v1/ops/output/attribution updates with valid ops-key', async () => {
  const res = await request(app)
    .put('/api/v1/ops/output/attribution')
    .set('Authorization', 'Bearer ops-y')
    .send({ repo: 'yaklog.git', commit_sha: 'attrib-0', agent_attribution: 'corrected-agent' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.updated, 1);
  // Verify the row actually changed
  const row = initializeDb().prepare('SELECT agent_attribution, attribution_method FROM output_commit WHERE commit_sha = ?').get('attrib-0');
  assert.equal(row.agent_attribution, 'corrected-agent');
  assert.equal(row.attribution_method, 'operator_override');
});

test('PUT /api/v1/ops/output/attribution returns 404 for nonexistent commit', async () => {
  const res = await request(app)
    .put('/api/v1/ops/output/attribution')
    .set('Authorization', 'Bearer ops-y')
    .send({ repo: 'nonexistent.git', commit_sha: 'no-such-sha', agent_attribution: 'x' });
  assert.equal(res.status, 404);
});

test('PUT /api/v1/ops/output/attribution rejects malformed body', async () => {
  const res = await request(app)
    .put('/api/v1/ops/output/attribution')
    .set('Authorization', 'Bearer ops-y')
    .send({ repo: 'yaklog.git' });  // missing commit_sha
  assert.equal(res.status, 400);
});

// ── OPS: POST /ingest ────────────────────────────────────────────────────

test('POST /api/v1/ops/output/ingest rejects without ops-key', async () => {
  const res = await request(app).post('/api/v1/ops/output/ingest');
  assert.equal(res.status, 401);
});

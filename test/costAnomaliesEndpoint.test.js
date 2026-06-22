// CP16 Pillar 2: cost-anomalies endpoint tests per parch #10268 ratify of
// PLAN-CP16-SERVER-SIDE-COMPUTE-MIGRATION §6.
// Tests auth boundary + dim/period/threshold validation + canonical anomaly
// detection semantics (today-vs-mean7d ratio + spike threshold + severity).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-costanom-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

const auth = require('../src/middleware/auth');
const costAnomaliesRoute = require('../src/costAnomaliesRoute');
const { closeDb, getDb, upsertCostDaily } = require('../src/db');

const app = express();
app.use(express.json());
app.use('/api/v1/cost', auth, costAnomaliesRoute);

const VALID_TOKEN = 'test-key';
const validAuth = { Authorization: `Bearer ${VALID_TOKEN}` };

function ymd(d) { return d.toISOString().slice(0, 10); }

// Seed cost_daily with 7d window: today + 6 prior days.
test.before(() => {
  const today = new Date();
  // agent-a: steady 1.0 USD/day for prior 6 days, 5.0 USD today (spike 5x)
  // agent-b: steady 2.0 USD/day across all 7 days (no spike; ratio 1.0)
  // agent-c: 3.0 USD prior, 4.0 USD today (mild 4/2.43 ≈ 1.65 ratio; not spike at threshold 2.0)
  for (let i = 6; i >= 0; i--) {
    const d = ymd(new Date(today.getTime() - i * 86400_000));
    upsertCostDaily({
      date: d, agent_id: 'agent-a', model: 'opus-4-7',
      cost_usd: i === 0 ? 5.0 : 1.0, tokens_input: 100, tokens_output: 100,
    });
    upsertCostDaily({
      date: d, agent_id: 'agent-b', model: 'opus-4-7',
      cost_usd: 2.0, tokens_input: 100, tokens_output: 100,
    });
    upsertCostDaily({
      date: d, agent_id: 'agent-c', model: 'opus-4-7',
      cost_usd: i === 0 ? 4.0 : 3.0, tokens_input: 100, tokens_output: 100,
    });
  }
});

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test('GET /anomalies: missing Bearer → 401', async () => {
  const r = await request(app).get('/api/v1/cost/anomalies');
  assert.equal(r.statusCode, 401);
});

test('GET /anomalies: invalid Bearer → 401', async () => {
  const r = await request(app).get('/api/v1/cost/anomalies').set({ Authorization: 'Bearer bogus' });
  assert.equal(r.statusCode, 401);
});

test('GET /anomalies: invalid period → 400', async () => {
  const r = await request(app).get('/api/v1/cost/anomalies?period=14d').set(validAuth);
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /period/);
});

test('GET /anomalies: invalid dim → 400', async () => {
  const r = await request(app).get('/api/v1/cost/anomalies?dim=evil_dim').set(validAuth);
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /dim/);
});

test('GET /anomalies: invalid threshold (< 1) → 400', async () => {
  const r = await request(app).get('/api/v1/cost/anomalies?threshold=0.5').set(validAuth);
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /threshold/);
});

test('GET /anomalies: invalid threshold (> 10) → 400', async () => {
  const r = await request(app).get('/api/v1/cost/anomalies?threshold=15').set(validAuth);
  assert.equal(r.statusCode, 400);
});

test('GET /anomalies: defaults (period=7d, dim=agent_id, threshold=2.0) → 200 with response envelope', async () => {
  const r = await request(app).get('/api/v1/cost/anomalies').set(validAuth);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.period, '7d');
  assert.equal(r.body.dim, 'agent_id');
  assert.equal(r.body.threshold, 2.0);
  assert.ok(r.body.generated_at);
  assert.ok(r.body.window && r.body.window.from && r.body.window.to);
  assert.ok(Array.isArray(r.body.anomalies));
});

test('GET /anomalies: agent-a spike detected (5x mean)', async () => {
  const r = await request(app).get('/api/v1/cost/anomalies').set(validAuth);
  const a = r.body.anomalies.find(x => x.dim_value === 'agent-a');
  assert.ok(a, 'agent-a row present');
  assert.equal(a.is_spike, true, 'agent-a should be flagged as spike (current=5, mean ≈ (6*1+5)/7 = 1.57)');
  assert.equal(a.current_usd, 5.0);
  // mean of [1,1,1,1,1,1,5] = 11/7 ≈ 1.571
  assert.ok(Math.abs(a.mean7d_usd - 11/7) < 0.001, `mean7d_usd expected ≈1.571 got ${a.mean7d_usd}`);
  // ratio = 5 / (11/7) = 35/11 ≈ 3.18
  assert.ok(Math.abs(a.ratio - 35/11) < 0.001, `ratio expected ≈3.18 got ${a.ratio}`);
  // severity tested in dedicated test below (3.18 < threshold*2=4.0 → warn)
});

test('GET /anomalies: agent-b no spike (steady)', async () => {
  const r = await request(app).get('/api/v1/cost/anomalies').set(validAuth);
  const b = r.body.anomalies.find(x => x.dim_value === 'agent-b');
  assert.ok(b);
  assert.equal(b.is_spike, false);
  assert.equal(b.current_usd, 2.0);
  assert.equal(b.mean7d_usd, 2.0);
  assert.equal(b.ratio, 1.0);
  assert.equal(b.severity, 'normal');
});

test('GET /anomalies: agent-c mild rise (no spike at threshold 2.0)', async () => {
  const r = await request(app).get('/api/v1/cost/anomalies').set(validAuth);
  const c = r.body.anomalies.find(x => x.dim_value === 'agent-c');
  assert.ok(c);
  assert.equal(c.is_spike, false);
  // current=4, mean=(6*3+4)/7 = 22/7 ≈ 3.143; ratio = 4 / 3.143 ≈ 1.27
  assert.ok(c.ratio > 1.0 && c.ratio < 2.0);
});

test('GET /anomalies: severity buckets (critical = ratio ≥ threshold*2)', async () => {
  // agent-a ratio ≈ 3.18; threshold 2.0; threshold*2 = 4.0; 3.18 < 4.0 → warn
  const r = await request(app).get('/api/v1/cost/anomalies').set(validAuth);
  const a = r.body.anomalies.find(x => x.dim_value === 'agent-a');
  assert.equal(a.severity, 'warn', `expected warn (ratio 3.18 < threshold*2=4.0) got ${a.severity}`);
});

test('GET /anomalies: lower threshold (1.5) flags agent-c too', async () => {
  const r = await request(app).get('/api/v1/cost/anomalies?threshold=1.5').set(validAuth);
  const c = r.body.anomalies.find(x => x.dim_value === 'agent-c');
  // agent-c ratio ≈ 1.27 < 1.5 → still no spike
  assert.equal(c.is_spike, false);
  // agent-a ratio ≈ 3.18 ≥ 1.5 → spike
  const a = r.body.anomalies.find(x => x.dim_value === 'agent-a');
  assert.equal(a.is_spike, true);
});

test('GET /anomalies: spike-first sort order (severity asc, then current_usd desc)', async () => {
  const r = await request(app).get('/api/v1/cost/anomalies').set(validAuth);
  // agent-a (warn) should sort before agent-b/c (normal)
  const idxA = r.body.anomalies.findIndex(x => x.dim_value === 'agent-a');
  const idxB = r.body.anomalies.findIndex(x => x.dim_value === 'agent-b');
  const idxC = r.body.anomalies.findIndex(x => x.dim_value === 'agent-c');
  assert.ok(idxA < idxB, 'spike agent-a should sort before normal agent-b');
  assert.ok(idxA < idxC, 'spike agent-a should sort before normal agent-c');
});

test('GET /anomalies?dim=model → 200 single model row aggregated', async () => {
  const r = await request(app).get('/api/v1/cost/anomalies?dim=model').set(validAuth);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.dim, 'model');
  const m = r.body.anomalies.find(x => x.dim_value === 'opus-4-7');
  assert.ok(m);
  // 3 agents × cost_usd summed: today = 5+2+4 = 11; prior days = 1+2+3 = 6 per day
  // mean7d = (6+6+6+6+6+6+11)/7 = 47/7 ≈ 6.71; ratio = 11/6.71 ≈ 1.64
  assert.equal(m.current_usd, 11.0);
  assert.ok(Math.abs(m.mean7d_usd - 47/7) < 0.001);
});

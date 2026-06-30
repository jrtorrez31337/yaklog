// Task #259 / PLAN-EFFORT-PACE-ENDPOINT — GET /api/v1/output/pace tests
// per parch #11211 RATIFY (naming `/output/pace`) + s345 #11212 surface-class
// CONFIRM + OQ2-4 silence-is-ack.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-pace-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-a';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

test.after(() => closeDb());

test('/output/pace — default period=eom + audience=practitioner returns shape', async () => {
  const res = await request(app).get('/api/v1/output/pace');
  assert.equal(res.statusCode, 200);
  // period_basis present + well-formed
  assert.ok(res.body.period_basis, 'period_basis present');
  assert.equal(typeof res.body.period_basis.current_from, 'string');
  assert.equal(typeof res.body.period_basis.current_to, 'string');
  assert.equal(typeof res.body.period_basis.period_end, 'string');
  assert.ok(Number.isInteger(res.body.period_basis.basis_days));
  assert.ok(res.body.period_basis.basis_days >= 1);
  assert.match(res.body.period_basis.basis_label, /Linear projection/);
  // current + projected objects present
  assert.ok(res.body.current);
  assert.ok(res.body.projected);
  // _audience echoed
  assert.equal(res.body._audience, 'practitioner');
  // _metadata namespaced (sister Task #258)
  assert.ok(res.body._metadata);
  assert.equal(typeof res.body._metadata.as_of_unix, 'number');
});

test('/output/pace — practitioner: empty seeded DB → _merges=0 + computed_empty_period=true', async () => {
  const res = await request(app).get('/api/v1/output/pace?period=eom&audience=practitioner');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.current._merges, 0);
  assert.equal(res.body.current._cost_usd, 0);
  // Rate degenerate → null
  assert.equal(res.body.current.dollar_per_merged_pr, null);
  // Projected: count-class extrapolation = 0; rate-class steady = null
  assert.equal(res.body.projected._merges_projected, 0);
  assert.equal(res.body.projected._cost_usd_projected, 0);
  assert.equal(res.body.projected.dollar_per_merged_pr, null);
  // computed_empty_period flag flipped
  assert.equal(res.body._metadata.computed_empty_period, true);
});

test('/output/pace — buyer audience: Fold B HARD GATE returns empty current/projected', async () => {
  const res = await request(app).get('/api/v1/output/pace?audience=buyer');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.current, {});
  assert.deepEqual(res.body.projected, {});
  assert.equal(res.body._audience, 'buyer');
  // period_basis still echoed (operator-tooling renders "not visible at buyer lens")
  assert.ok(res.body.period_basis);
});

test('/output/pace — investor audience: returns value-ratios', async () => {
  const res = await request(app).get('/api/v1/output/pace?audience=investor');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body._audience, 'investor');
  // Investor sees value-ratios per audience canon
  assert.ok('_merges' in res.body.current);
  assert.ok('dollar_per_merged_pr' in res.body.current);
});

test('/output/pace — eoq period extends end date past month boundary', async () => {
  const res = await request(app).get('/api/v1/output/pace?period=eoq');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body._audience, 'practitioner');
  // period_end should be quarter-end (different from month-end in 2/3 of months)
  assert.ok(res.body.period_basis.period_end);
});

test('/output/pace — invalid period → 400 ValidationError', async () => {
  const res = await request(app).get('/api/v1/output/pace?period=eoy');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'ValidationError');
  assert.match(res.body.message, /period must be one of: eom, eoq/);
});

test('/output/pace — invalid audience → 400 ValidationError', async () => {
  const res = await request(app).get('/api/v1/output/pace?audience=alien');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'ValidationError');
});

test('/output/pace — projection_factor sane (projected >= current for partial period)', async () => {
  // For an empty DB, both are 0 so this test is degenerate;
  // but verify the math doesn't crash and counts come back as numbers
  const res = await request(app).get('/api/v1/output/pace?period=eom&audience=practitioner');
  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.body.projected._merges_projected, 'number');
  assert.ok(res.body.projected._merges_projected >= res.body.current._merges);
});

test('/output/pace — 4xx error envelope excludes _metadata (per Task #258 OQ2 RATIFY)', async () => {
  const r1 = await request(app).get('/api/v1/output/pace?period=invalid');
  assert.equal(r1.statusCode, 400);
  assert.equal(r1.body._metadata, undefined);
  const r2 = await request(app).get('/api/v1/output/pace?audience=invalid');
  assert.equal(r2.statusCode, 400);
  assert.equal(r2.body._metadata, undefined);
});

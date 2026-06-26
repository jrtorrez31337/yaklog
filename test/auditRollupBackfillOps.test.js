// CP16 Phase 2 ops-endpoint test — POST /api/v1/ops/audit-rollup/backfill
// Sister-shape walCheckpointOps.test.js + auditRollupDriver.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-audit-rollup-ops-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.YAKLOG_OPS_API_KEYS = 'ops-key-secret';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

const auditOpsRoutes = require('../src/auditOpsRoutes');
const { closeDb } = require('../src/db');

const app = express();
app.use(express.json());
app.use('/api/v1/ops', auditOpsRoutes);

const OPS_KEY = 'ops-key-secret';
const NON_OPS_KEY = 'test-key';
const opsAuth = { Authorization: `Bearer ${OPS_KEY}` };
const nonOpsAuth = { Authorization: `Bearer ${NON_OPS_KEY}` };

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test('POST /audit-rollup/backfill: missing Bearer → 401', async () => {
  const r = await request(app).post('/api/v1/ops/audit-rollup/backfill').send({});
  assert.equal(r.statusCode, 401);
});

test('POST /audit-rollup/backfill: non-ops Bearer → 403', async () => {
  const r = await request(app).post('/api/v1/ops/audit-rollup/backfill').set(nonOpsAuth).send({});
  assert.equal(r.statusCode, 403);
});

test('POST /audit-rollup/backfill: days_back > 365 → 400', async () => {
  const r = await request(app).post('/api/v1/ops/audit-rollup/backfill').set(opsAuth).send({ days_back: 9999 });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /days_back/);
});

test('POST /audit-rollup/backfill: days_back < 1 → 400', async () => {
  const r = await request(app).post('/api/v1/ops/audit-rollup/backfill').set(opsAuth).send({ days_back: 0 });
  assert.equal(r.statusCode, 400);
});

test('POST /audit-rollup/backfill: valid days_back → 200 with row counts', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit-rollup/backfill')
    .set(opsAuth)
    .send({ days_back: 3, end_date_exclusive: '2026-06-15' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.window_days, 3);
  assert.equal(r.body.end_date_exclusive, '2026-06-15');
  assert.equal(r.body.days_rolled, 3);
  // Per rollup driver: each day writes (frameworks × areas) rows
  // soc2(6) + iso27001(7) + gdpr(4) = 17 areas
  // 3 days × 17 = 51 rollup rows minimum (empty seed → COUNT=0 each)
  assert.ok(r.body.by_control_area_rows >= 51, `expected ≥51 cca rows; got ${r.body.by_control_area_rows}`);
  // AUDIT_OBJECT_CLASSES has 8 entries × 3 days = 24
  assert.equal(r.body.by_object_class_rows, 24);
  // by_agent_rows depends on seeded audit data — empty seed → 0
  assert.equal(r.body.by_agent_rows, 0);
  assert.ok(typeof r.body.elapsed_ms === 'number');
});

test('POST /audit-rollup/backfill: default days_back (90) when omitted', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit-rollup/backfill')
    .set(opsAuth)
    .send({ end_date_exclusive: '2026-06-15' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.window_days, 90);
});

test('POST /audit-rollup/backfill: invalid end_date_exclusive ignored (treats as undefined)', async () => {
  const r = await request(app)
    .post('/api/v1/ops/audit-rollup/backfill')
    .set(opsAuth)
    .send({ days_back: 2, end_date_exclusive: 'not-a-date' });
  assert.equal(r.statusCode, 200);
  // end_date_exclusive falls back to today_utc when input invalid; just confirm shape
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.body.end_date_exclusive));
});

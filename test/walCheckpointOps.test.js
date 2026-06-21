// CP16-prep WAL checkpoint endpoint tests per 2026-06-20 incident post-mortem.
// Sister-shape to test/auditOpsApi.test.js — standalone mount of auditOpsRoutes
// on isolated Express app; tests the four boundaries:
//   (1) missing Bearer → 401
//   (2) non-ops Bearer → 403
//   (3) invalid mode body → 400
//   (4) valid TRUNCATE → 200 with PRAGMA result fields
//   (5) default mode is TRUNCATE when body omits mode

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// MUST set env before requiring config-touching modules (config caches at require-time).
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-walchk-test-'));
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

test('POST /wal-checkpoint: missing Bearer → 401', async () => {
  const r = await request(app).post('/api/v1/ops/wal-checkpoint').send({});
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.error, 'Unauthorized');
});

test('POST /wal-checkpoint: non-ops Bearer → 403', async () => {
  const r = await request(app).post('/api/v1/ops/wal-checkpoint').set(nonOpsAuth).send({});
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, 'Forbidden');
});

test('POST /wal-checkpoint: invalid mode → 400 (gate cleared)', async () => {
  const r = await request(app).post('/api/v1/ops/wal-checkpoint').set(opsAuth).send({ mode: 'NUKE' });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /mode must be one of/);
});

test('POST /wal-checkpoint: valid TRUNCATE → 200 with PRAGMA result fields', async () => {
  const r = await request(app).post('/api/v1/ops/wal-checkpoint').set(opsAuth).send({ mode: 'TRUNCATE' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.mode, 'TRUNCATE');
  assert.equal(typeof r.body.busy, 'number');
  assert.equal(typeof r.body.log, 'number');
  assert.equal(typeof r.body.checkpointed, 'number');
  assert.equal(typeof r.body.elapsed_ms, 'number');
  assert.equal(typeof r.body.actor, 'string');
  assert.equal(r.body.actor.length, 16);
});

test('POST /wal-checkpoint: default mode is TRUNCATE when body omits mode', async () => {
  const r = await request(app).post('/api/v1/ops/wal-checkpoint').set(opsAuth).send({});
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.mode, 'TRUNCATE');
});

test('POST /wal-checkpoint: PASSIVE mode accepted', async () => {
  const r = await request(app).post('/api/v1/ops/wal-checkpoint').set(opsAuth).send({ mode: 'PASSIVE' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.mode, 'PASSIVE');
});

test('POST /wal-checkpoint: lowercase mode normalized', async () => {
  const r = await request(app).post('/api/v1/ops/wal-checkpoint').set(opsAuth).send({ mode: 'truncate' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.mode, 'TRUNCATE');
});

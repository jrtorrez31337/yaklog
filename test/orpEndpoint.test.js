// CP14-X Plexus Secure Store endpoint tests per parch #10175 Q1-Q6 ratify.
// Tests cover:
//   - GET /orp/<agent_id> auth boundary + 404 + 200 happy path
//   - POST /ops/orp/<agent_id> auth boundary + ops-key gate + validation (Q2) + transactional version-bump (condition A)
//   - emit.orpWrite → /metrics roundtrip (condition C)
//   - WAL checkpoint endpoint `db` param extension (Q3 + condition D)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// MUST set env before requiring config-touching modules.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-orp-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_PLEXUS_SECURE_DB_PATH = path.join(tempDir, 'plexus-secure.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.YAKLOG_OPS_API_KEYS = 'ops-key-secret';
process.env.NODE_ENV = 'test';
// Inline a minimal ORP schema for tests (avoids depending on /data/canonical mount).
process.env.YAKLOG_ORP_SCHEMA_INLINE = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['role_id', 'display_name', 'version'],
  properties: {
    role_id: { type: 'string', minLength: 1 },
    display_name: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
    description: { type: 'string' },
  },
});

const express = require('express');
const request = require('supertest');

const auth = require('../src/middleware/auth');
const orpRoute = require('../src/orpRoute');
const auditOpsRoutes = require('../src/auditOpsRoutes');
const metricsRoute = require('../src/metricsRoute');
const { closeDb: closeMainDb } = require('../src/db');
const plexusSecure = require('../src/plexusSecureDb');

const app = express();
app.use(express.json());
app.use('/api/v1/orp', auth, orpRoute);
app.use('/api/v1/ops', auditOpsRoutes);
app.use('/api/v1/metrics', auth, metricsRoute);

const VALID_TOKEN = 'test-key';
const OPS_KEY = 'ops-key-secret';

const validAuth = { Authorization: `Bearer ${VALID_TOKEN}` };
const opsAuth = { Authorization: `Bearer ${OPS_KEY}` };

const VALID_ORP = {
  role_id: 'ptah-test-role',
  display_name: 'Ptah Test Role',
  version: '1.0.0',
  description: 'Test ORP for unit tests',
};

test.after(() => {
  closeMainDb();
  plexusSecure.closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ─── GET /orp/<agent_id> ────────────────────────────────────────────────────

test('GET /orp/<agent_id>: missing Bearer → 401', async () => {
  const r = await request(app).get('/api/v1/orp/test-agent');
  assert.equal(r.statusCode, 401);
});

test('GET /orp/<agent_id>: invalid agent_id pattern → 400', async () => {
  const r = await request(app).get('/api/v1/orp/$$$bad$$$').set(validAuth);
  assert.equal(r.statusCode, 400);
});

test('GET /orp/<agent_id>: no ORP stored → 404', async () => {
  const r = await request(app).get('/api/v1/orp/no-such-agent').set(validAuth);
  assert.equal(r.statusCode, 404);
});

// ─── POST /ops/orp/<agent_id> ───────────────────────────────────────────────

test('POST /ops/orp: missing Bearer → 401', async () => {
  const r = await request(app).post('/api/v1/ops/orp/test-agent').send({});
  assert.equal(r.statusCode, 401);
});

test('POST /ops/orp: non-ops Bearer → 403', async () => {
  const r = await request(app).post('/api/v1/ops/orp/test-agent').set(validAuth).send({});
  assert.equal(r.statusCode, 403);
});

test('POST /ops/orp: missing orp_json → 400', async () => {
  const r = await request(app).post('/api/v1/ops/orp/test-agent').set(opsAuth)
    .send({ schema_version: '1.0.0' });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /orp_json/);
});

test('POST /ops/orp: missing schema_version → 400', async () => {
  const r = await request(app).post('/api/v1/ops/orp/test-agent').set(opsAuth)
    .send({ orp_json: VALID_ORP });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /schema_version/);
});

test('POST /ops/orp: schema-invalid orp_json → 422 (condition B)', async () => {
  const invalidOrp = { /* missing required fields */ description: 'incomplete' };
  const r = await request(app).post('/api/v1/ops/orp/test-agent').set(opsAuth)
    .send({ orp_json: invalidOrp, schema_version: '1.0.0' });
  assert.equal(r.statusCode, 422);
  assert.equal(r.body.error, 'ValidationError');
  assert.ok(Array.isArray(r.body.errors));
  assert.ok(r.body.errors.length > 0);
});

test('POST /ops/orp: valid happy path → 200 with version=1', async () => {
  const r = await request(app).post('/api/v1/ops/orp/test-agent-1').set(opsAuth)
    .send({ orp_json: VALID_ORP, schema_version: '1.0.0' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.agent_id, 'test-agent-1');
  assert.equal(r.body.version, 1);
  assert.equal(typeof r.body.updated_at, 'string');
  assert.equal(typeof r.body.actor, 'string');
});

test('GET /orp after POST: returns stored ORP with version=1', async () => {
  const r = await request(app).get('/api/v1/orp/test-agent-1').set(validAuth);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.agent_id, 'test-agent-1');
  assert.equal(r.body.version, 1);
  assert.equal(r.body.schema_version, '1.0.0');
  assert.equal(r.body.orp_json.role_id, 'ptah-test-role');
  assert.equal(r.body.orp_json.display_name, 'Ptah Test Role');
  // updated_by NOT in public read shape
  assert.equal(r.body.updated_by, undefined);
});

test('POST /ops/orp: version increments on subsequent write (transactional per condition A)', async () => {
  const r1 = await request(app).post('/api/v1/ops/orp/test-agent-2').set(opsAuth)
    .send({ orp_json: VALID_ORP, schema_version: '1.0.0' });
  assert.equal(r1.body.version, 1);
  const r2 = await request(app).post('/api/v1/ops/orp/test-agent-2').set(opsAuth)
    .send({ orp_json: { ...VALID_ORP, version: '1.0.1' }, schema_version: '1.0.0' });
  assert.equal(r2.body.version, 2);
  const r3 = await request(app).post('/api/v1/ops/orp/test-agent-2').set(opsAuth)
    .send({ orp_json: { ...VALID_ORP, version: '1.0.2' }, schema_version: '1.0.0' });
  assert.equal(r3.body.version, 3);
  // Current ORP reflects v3
  const cur = await request(app).get('/api/v1/orp/test-agent-2').set(validAuth);
  assert.equal(cur.body.version, 3);
  // History preserved (verify via direct DB read since we don't expose history endpoint yet)
  const versions = plexusSecure.listOrpVersions('test-agent-2');
  assert.equal(versions.length, 3);
  assert.deepEqual(versions.map(v => v.version), [3, 2, 1]);
});

// ─── emit.orpWrite → /metrics roundtrip (condition C) ───────────────────────

test('POST /ops/orp emits gauges visible at GET /metrics (condition C)', async () => {
  await request(app).post('/api/v1/ops/orp/metrics-test-agent').set(opsAuth)
    .send({ orp_json: VALID_ORP, schema_version: '1.0.0' });
  const scrape = await request(app).get('/api/v1/metrics').set(validAuth);
  assert.equal(scrape.statusCode, 200);
  assert.match(scrape.text, /yaklog_orp_write_success 1/);
  assert.match(scrape.text, /yaklog_orp_write_invocations_total\{outcome="ok"\}/);
  assert.match(scrape.text, /yaklog_orp_write_last_version\{agent_id="metrics-test-agent"\} 1/);
});

test('POST /ops/orp validation-fail emits outcome="validation-fail" counter', async () => {
  await request(app).post('/api/v1/ops/orp/validation-fail-agent').set(opsAuth)
    .send({ orp_json: { not_valid: 'missing required' }, schema_version: '1.0.0' });
  const scrape = await request(app).get('/api/v1/metrics').set(validAuth);
  assert.match(scrape.text, /yaklog_orp_write_invocations_total\{outcome="validation-fail"\}/);
});

// ─── WAL checkpoint `db` param extension (Q3 + condition D) ─────────────────

test('POST /ops/wal-checkpoint: default db=yaklog → 200', async () => {
  const r = await request(app).post('/api/v1/ops/wal-checkpoint').set(opsAuth)
    .send({ mode: 'TRUNCATE' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.db, 'yaklog');
});

test('POST /ops/wal-checkpoint: explicit db=plexus-secure → 200', async () => {
  const r = await request(app).post('/api/v1/ops/wal-checkpoint').set(opsAuth)
    .send({ mode: 'TRUNCATE', db: 'plexus-secure' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.db, 'plexus-secure');
  assert.equal(typeof r.body.elapsed_ms, 'number');
});

test('POST /ops/wal-checkpoint: invalid db value → 400', async () => {
  const r = await request(app).post('/api/v1/ops/wal-checkpoint').set(opsAuth)
    .send({ mode: 'TRUNCATE', db: 'nonexistent' });
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message, /db must be one of/);
});

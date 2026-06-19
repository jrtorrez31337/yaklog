// Phase 0 Item B Task B.1 — auth shape on /api/v1/audit/ingest/otel.
// Per PLAN-ADR-0032-PHASE-0-CROSS-RUNTIME-TELEMETRY-PARITY.md §3 Task B.1.
//
// The endpoint is ops-key gated per feedback_secrets_no_yaklog (substrate-
// internal ingest path; OTel collector uses an ops-key Bearer when posting
// log batches forwarded from Codex/Gemini OTel emissions).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-audit-otel-auth-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-public';
process.env.YAKLOG_OPS_API_KEYS = 'ops-key-secret';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test('POST /api/v1/audit/ingest/otel without Bearer → 401', async () => {
  const r = await request(app)
    .post('/api/v1/audit/ingest/otel')
    .send({ resourceLogs: [] });
  assert.equal(r.statusCode, 401);
});

test('POST /api/v1/audit/ingest/otel with public-tier Bearer (not ops-key) → 403', async () => {
  // enforceOpsKey returns 403 (Forbidden) for valid public-tier Bearer that
  // isn't in YAKLOG_OPS_API_KEYS — auth succeeds, authz fails.
  const r = await request(app)
    .post('/api/v1/audit/ingest/otel')
    .set('Authorization', 'Bearer tok-public')
    .send({ resourceLogs: [] });
  assert.equal(r.statusCode, 403, 'public-tier Bearer must NOT authorize for ops-key-gated audit ingest');
});

test('POST /api/v1/audit/ingest/otel with ops-key Bearer + empty body → 200, ingested_count=0', async () => {
  const r = await request(app)
    .post('/api/v1/audit/ingest/otel')
    .set('Authorization', 'Bearer ops-key-secret')
    .send({ resourceLogs: [] });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ingested_count, 0);
});

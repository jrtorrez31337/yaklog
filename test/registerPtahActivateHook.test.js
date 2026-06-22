// Task #137 Phase B test: /register activate hook pre-provisions per-Ptah-
// agent audit SQLite file when submission declares runtime_class='ptah'.
// Per parch #10266 Q2 ratify ("at /register pre-provisioned + clean first-POST
// latency") + Q3 ratify (explicit runtime_class='ptah' field) + Q7 ratify
// (per-agent-bearer + ops-key both for audit ingestion).
//
// Activate-tier hook (vs SUBMITTED-tier) chosen for clean lifecycle: REJECTED
// registrations never get a stray DB file; agent is ACTIVE + token-bound when
// audit substrate is ready, so first audit POST has clean latency.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-ptah-activate-test-'));
const ptahAuditTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-ptah-audit-dir-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_PTAH_AUDIT_DB_DIR = ptahAuditTmp;
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb, insertRegistration, updateRegistration } = require('../src/db');
const ptahAuditDb = require('../src/ptahAuditDb');

test.after(() => {
  ptahAuditDb.closeAll();
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(ptahAuditTmp, { recursive: true, force: true }); } catch {}
});

function sha256Hex(s) { return crypto.createHash('sha256').update(s, 'utf-8').digest('hex'); }

// Seed a registration into PENDING_ACTIVATION with a known minted token.
// The activate endpoint reads minted_token_hash + matches against the
// presented Bearer; pubkey/age path is bypassed here (test seeds the post-
// jon-ratify state directly).
function seedRegistration({ runtimeClass } = {}) {
  const registrationId = 'reg-ptahact-' + crypto.randomBytes(4).toString('hex');
  const agentId = runtimeClass === 'ptah' ? 'ptah-act-test-' + crypto.randomBytes(3).toString('hex') : 'cc-act-test-' + crypto.randomBytes(3).toString('hex');
  const mintedToken = 'minted-' + crypto.randomBytes(16).toString('hex');
  insertRegistration({
    registration_id: registrationId,
    agent_id: agentId,
    status: 'SUBMITTED',
    registrant_pubkey: 'age1' + 'a'.repeat(58),
    registrant_token_hash: sha256Hex('init'),
    justification_json: JSON.stringify({}),
    submission_json: JSON.stringify(runtimeClass ? { scope: 'test', runtime_class: runtimeClass } : { scope: 'test' }),
  });
  updateRegistration(registrationId, {
    status: 'PENDING_ACTIVATION',
    minted_token_hash: sha256Hex(mintedToken),
  });
  return { registrationId, agentId, mintedToken };
}

test('activate runtime_class=ptah agent → per-agent audit DB provisioned', async () => {
  const { registrationId, agentId, mintedToken } = seedRegistration({ runtimeClass: 'ptah' });
  const res = await request(app)
    .post(`/api/v1/register/${registrationId}/activate`)
    .set('Authorization', `Bearer ${mintedToken}`);
  assert.equal(res.status, 200, `expected 200, got ${res.status} body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.registration.status, 'ACTIVE');
  // The per-Ptah-agent audit DB file MUST exist on disk
  const dbPath = ptahAuditDb.pathFor(agentId);
  assert.ok(fs.existsSync(dbPath), `expected per-agent audit DB at ${dbPath}`);
  // Subsequent insertEvent against this agent works (schema initialized)
  ptahAuditDb.insertEvent(agentId, {
    event_id: 'evt-postact-1',
    occurred_at: '2026-06-22T03:00:00Z',
    event_kind: 'tool_invocation',
    auth_mode: 'per-agent-bearer',
  });
  const rows = ptahAuditDb.getEventsForAgent(agentId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_id, 'evt-postact-1');
});

test('activate runtime_class=other agent → NO per-agent audit DB provisioned (negative case)', async () => {
  const { registrationId, agentId, mintedToken } = seedRegistration({ runtimeClass: undefined });
  const res = await request(app)
    .post(`/api/v1/register/${registrationId}/activate`)
    .set('Authorization', `Bearer ${mintedToken}`);
  assert.equal(res.status, 200);
  // The non-ptah agent must NOT have an audit DB file (clean substrate-isolation)
  const expectedPath = path.join(ptahAuditTmp, `ptah-audit-${agentId}.db`);
  assert.ok(!fs.existsSync(expectedPath), `non-ptah agent should NOT have audit DB; found ${expectedPath}`);
});

test('activate runtime_class=ptah with non-ptah-* agent_id → 500 ProvisionFailed (PTAH_AGENT_ID_RE namespace bound)', async () => {
  // Seed with runtime_class='ptah' BUT agent_id that fails PTAH_AGENT_ID_RE.
  // Per parch #10266 /register sub-OQ Option (c): bootstrap secret mints
  // ONLY ptah-* agent_ids. Defense-in-depth: ptahAuditDb.provisionForAgent
  // rejects non-ptah-* even if the upstream check missed.
  const registrationId = 'reg-rejnamespace-' + crypto.randomBytes(4).toString('hex');
  const mintedToken = 'minted-' + crypto.randomBytes(16).toString('hex');
  insertRegistration({
    registration_id: registrationId,
    agent_id: 'admin-agent',  // declares ptah but uses non-ptah agent_id
    status: 'SUBMITTED',
    registrant_pubkey: 'age1' + 'a'.repeat(58),
    registrant_token_hash: sha256Hex('init'),
    justification_json: JSON.stringify({}),
    submission_json: JSON.stringify({ runtime_class: 'ptah' }),
  });
  updateRegistration(registrationId, {
    status: 'PENDING_ACTIVATION',
    minted_token_hash: sha256Hex(mintedToken),
  });
  const res = await request(app)
    .post(`/api/v1/register/${registrationId}/activate`)
    .set('Authorization', `Bearer ${mintedToken}`);
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'ProvisionFailed');
  assert.match(res.body.message, /ptah-\* namespace/);
});

test('activate is idempotent: re-activate on already-ACTIVE returns 409 (no double-provision)', async () => {
  const { registrationId, mintedToken } = seedRegistration({ runtimeClass: 'ptah' });
  const r1 = await request(app)
    .post(`/api/v1/register/${registrationId}/activate`)
    .set('Authorization', `Bearer ${mintedToken}`);
  assert.equal(r1.status, 200);
  const r2 = await request(app)
    .post(`/api/v1/register/${registrationId}/activate`)
    .set('Authorization', `Bearer ${mintedToken}`);
  assert.equal(r2.status, 409, 'second activate must return IllegalTransition');
  assert.equal(r2.body.error, 'IllegalTransition');
});

test('REJECTED registration → no per-agent audit DB orphan', () => {
  // Test the lifecycle discipline (not via activate; this tests the canon-design):
  // SUBMITTED + runtime_class=ptah → REJECTED never reaches activate → no DB.
  const registrationId = 'reg-rej-' + crypto.randomBytes(4).toString('hex');
  const agentId = 'ptah-rejected-' + crypto.randomBytes(3).toString('hex');
  insertRegistration({
    registration_id: registrationId,
    agent_id: agentId,
    status: 'SUBMITTED',
    registrant_pubkey: 'age1' + 'a'.repeat(58),
    registrant_token_hash: sha256Hex('init'),
    justification_json: JSON.stringify({}),
    submission_json: JSON.stringify({ runtime_class: 'ptah' }),
  });
  updateRegistration(registrationId, {
    status: 'REJECTED',
    rejected_reason: 'test',
  });
  // No activate happened; no audit DB should exist
  const expectedPath = ptahAuditDb.pathFor(agentId);
  assert.ok(!fs.existsSync(expectedPath), `REJECTED ptah-class registration should have NO audit DB orphan`);
});

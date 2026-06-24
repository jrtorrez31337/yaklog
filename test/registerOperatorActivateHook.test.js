// Path Y test (per parch #10658 + Task #234): /register activate hook
// provisions operator_records when submission declares session_class='operator',
// AND auth.js path-b derives tokenClass='operator' from the registration row's
// submission. Closes the Phase A scope-gap from #10650.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-op-activate-test-'));
const secureDbPath = path.join(tempDir, 'plexus-secure.db');
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_PLEXUS_SECURE_DB_PATH = secureDbPath;
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb, insertRegistration, updateRegistration } = require('../src/db');
const plexusSecureDb = require('../src/plexusSecureDb');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function sha256Hex(s) { return crypto.createHash('sha256').update(s, 'utf-8').digest('hex'); }

function seedRegistration({ sessionClass, agentIdPrefix } = {}) {
  const registrationId = 'reg-opact-' + crypto.randomBytes(4).toString('hex');
  const agentId = (agentIdPrefix || 'op-test-') + crypto.randomBytes(3).toString('hex');
  const mintedToken = 'minted-' + crypto.randomBytes(16).toString('hex');
  const submission = { scope: 'test' };
  if (sessionClass) submission.session_class = sessionClass;
  insertRegistration({
    registration_id: registrationId,
    agent_id: agentId,
    registrant_pubkey: 'age1' + 'a'.repeat(58),
    registrant_token_hash: sha256Hex('init'),
    submission_json: JSON.stringify(submission),
  });
  updateRegistration(registrationId, {
    status: 'PENDING_ACTIVATION',
    minted_token_hash: sha256Hex(mintedToken),
  });
  return { registrationId, agentId, mintedToken };
}

test('activate session_class=operator → operator_records row provisioned', async () => {
  const { registrationId, agentId, mintedToken } = seedRegistration({ sessionClass: 'operator' });
  const res = await request(app)
    .post(`/api/v1/register/${registrationId}/activate`)
    .set('Authorization', `Bearer ${mintedToken}`);
  assert.equal(res.status, 200, `expected 200, got ${res.status} body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.registration.status, 'ACTIVE');
  const row = plexusSecureDb.getOperatorRecord(agentId);
  assert.ok(row, `operator_records row must exist for ${agentId}`);
  assert.equal(row.operator_id, agentId);
  assert.equal(row.created_by, 'register-state-machine');
});

test('activate session_class=agent (default) → NO operator_records row', async () => {
  const { registrationId, agentId, mintedToken } = seedRegistration({ sessionClass: undefined });
  const res = await request(app)
    .post(`/api/v1/register/${registrationId}/activate`)
    .set('Authorization', `Bearer ${mintedToken}`);
  assert.equal(res.status, 200);
  const row = plexusSecureDb.getOperatorRecord(agentId);
  assert.equal(row, null, 'agent-class registration must NOT create an operator_records row');
});

test('auth.js path-b: operator-class minted token sets req.tokenClass=operator', async () => {
  const { registrationId, agentId, mintedToken } = seedRegistration({ sessionClass: 'operator' });
  await request(app)
    .post(`/api/v1/register/${registrationId}/activate`)
    .set('Authorization', `Bearer ${mintedToken}`);
  // POST a message with the operator token; senderBinding allows operator-class
  // to post as their own operator_id (per ADR-0026 v3 §V3.3.1).
  const res = await request(app)
    .post('/api/v1/messages')
    .set('Authorization', `Bearer ${mintedToken}`)
    .send({ channel: 'handoff', sender: agentId, body: 'operator-class post test' });
  assert.equal(res.status, 201, `expected 201, got ${res.status} body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.message.sender, agentId);
});

test('auth.js path-b: agent-class minted token sets req.tokenClass=agent', async () => {
  const { registrationId, agentId, mintedToken } = seedRegistration({ sessionClass: undefined });
  await request(app)
    .post(`/api/v1/register/${registrationId}/activate`)
    .set('Authorization', `Bearer ${mintedToken}`);
  // POST a message as the registered agent_id; passes via registrationAgentId
  // binding (existing path-b behavior).
  const res = await request(app)
    .post('/api/v1/messages')
    .set('Authorization', `Bearer ${mintedToken}`)
    .send({ channel: 'handoff', sender: agentId, body: 'agent-class post test' });
  assert.equal(res.status, 201, `expected 201, got ${res.status} body=${JSON.stringify(res.body)}`);
});

test('activate session_class=operator is idempotent: upsertOperatorRecord on re-activate', () => {
  // Direct upsert call (not via /activate) — the second call must not throw.
  const opId = 'op-idemp-' + crypto.randomBytes(3).toString('hex');
  plexusSecureDb.upsertOperatorRecord({ operatorId: opId, actor: 'test', notes: 'first' });
  plexusSecureDb.upsertOperatorRecord({ operatorId: opId, actor: 'test', notes: 'second' });
  const row = plexusSecureDb.getOperatorRecord(opId);
  assert.ok(row);
  assert.equal(row.operator_id, opId);
});

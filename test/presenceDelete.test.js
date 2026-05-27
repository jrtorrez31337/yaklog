const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-presdel-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'token-alpha,token-beta';
process.env.YAKLOG_OPS_API_KEYS = 'ops-secret';
process.env.YAKLOG_TOKEN_BINDINGS = 'alpha:token-alpha,beta:token-beta';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

const authAlpha = { Authorization: 'Bearer token-alpha' };
const authOps   = { Authorization: 'Bearer ops-secret' };

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

async function seedAgent(agentId, tokenAuth) {
  return request(app).post('/api/v1/presence/event').set(tokenAuth).send({
    agent_id: agentId,
    daemon_state: 'up', session_state: 'idle',
    event_type: 'diag', payload: {},
  });
}

test('DELETE /presence/:id with regular bearer → 403 OpsKeyRequired', async () => {
  await seedAgent('alpha', authAlpha);
  const res = await request(app).delete('/api/v1/presence/alpha').set(authAlpha);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'OpsKeyRequired');
});

test('DELETE /presence/:id with ops-key → 200 + row gone from /presence', async () => {
  const ge = await request(app).get('/api/v1/presence/alpha').set(authAlpha);
  assert.equal(ge.statusCode, 200, 'precondition: alpha row exists');
  const del = await request(app).delete('/api/v1/presence/alpha').set(authOps).send({ reason: 'test-decom' });
  assert.equal(del.statusCode, 200);
  assert.equal(del.body.deleted.agent_id, 'alpha');
  assert.equal(del.body.reason, 'test-decom');
  const after = await request(app).get('/api/v1/presence/alpha').set(authAlpha);
  assert.equal(after.statusCode, 404);
});

test('DELETE /presence/:id non-existent → 404', async () => {
  const res = await request(app).delete('/api/v1/presence/never-seen').set(authOps);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'NotFound');
});

test('DELETE /presence/:id invalid agent_id → 400', async () => {
  const res = await request(app).delete('/api/v1/presence/!!!bad').set(authOps);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'ValidationError');
});

test('DELETE /presence/:id leaves audit transition behind', async () => {
  await seedAgent('beta', { Authorization: 'Bearer token-beta' });
  await request(app).delete('/api/v1/presence/beta').set(authOps).send({ reason: 'unit-test' });
  // Transition log: the row is gone, but the transition for it stays.
  // Verify via the DB directly (no public endpoint exposes it for arbitrary agent).
  const { closeDb: _ignored } = require('../src/db');
  const Database = require('better-sqlite3');
  const db = new Database(process.env.YAKLOG_DB_PATH, { readonly: true });
  const t = db.prepare("SELECT * FROM presence_transitions WHERE agent_id=? ORDER BY id DESC LIMIT 1").get('beta');
  db.close();
  assert.ok(t, 'transition row exists');
  assert.equal(t.to_label, '(decommissioned)');
  assert.match(t.reason, /unit-test/);
  assert.match(t.reason, /ops:/);
});

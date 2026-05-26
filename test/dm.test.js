const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-dm-test-'));
const auditPath = path.join(tempDir, 'dm-audit.ndjson');
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'token-alice,token-bob,token-carol,token-unbound';
process.env.YAKLOG_OPS_API_KEYS = 'ops-secret-token';
process.env.YAKLOG_TOKEN_BINDINGS = 'alice:token-alice,bob:token-bob,carol:token-carol';
process.env.YAKLOG_DM_AUDIT_LOG_PATH = auditPath;
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

const authAlice = { Authorization: 'Bearer token-alice' };
const authBob = { Authorization: 'Bearer token-bob' };
const authCarol = { Authorization: 'Bearer token-carol' };
const authUnbound = { Authorization: 'Bearer token-unbound' };
const authOps = { Authorization: 'Bearer ops-secret-token' };

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ============================================================
// Send-path validation (ADR-0026 §"API surface > Sending a DM")
// ============================================================

test('POST: bound sender can send a public message (unchanged)', async () => {
  const res = await request(app).post('/api/v1/messages').set(authAlice)
    .send({ channel: 'dm-test', sender: 'alice', body: 'public hello' });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.message.private, false);
});

test('POST: bound sender can send private:true with mention', async () => {
  const res = await request(app).post('/api/v1/messages').set(authAlice)
    .send({ channel: 'dm-test', sender: 'alice', body: 'secret for @bob', private: true });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.message.private, true);
  assert.deepEqual(res.body.message.mentions, ['bob']);
});

test('POST: unbound bearer attempting private:true rejected 403', async () => {
  const res = await request(app).post('/api/v1/messages').set(authUnbound)
    .send({ channel: 'dm-test', sender: 'arbitrary', body: 'leaky @bob', private: true });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'PrivateSendRequiresBoundSender');
});

test('POST: private:true with no @mention rejected 400', async () => {
  const res = await request(app).post('/api/v1/messages').set(authAlice)
    .send({ channel: 'dm-test', sender: 'alice', body: 'nobody listens', private: true });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'PrivateSendRequiresMentions');
});

test('POST: non-boolean private value rejected 400', async () => {
  const res = await request(app).post('/api/v1/messages').set(authAlice)
    .send({ channel: 'dm-test', sender: 'alice', body: 'hello @bob', private: 'yes' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'ValidationError');
});

// ============================================================
// Read-filter three-branch (ADR-0026 §"Fail-closed for unbound bearers")
// ============================================================

// Seed: alice DMs bob; alice also posts public message
async function seedDms() {
  await request(app).post('/api/v1/messages').set(authAlice)
    .send({ channel: 'secrets', sender: 'alice', body: 'rotation key for @bob', private: true });
  await request(app).post('/api/v1/messages').set(authAlice)
    .send({ channel: 'secrets', sender: 'alice', body: 'public announcement' });
}

test('READ: sender (alice) sees her own DM via GET /messages', async () => {
  await seedDms();
  const res = await request(app).get('/api/v1/messages?channel=secrets').set(authAlice);
  assert.equal(res.statusCode, 200);
  const privates = res.body.messages.filter((m) => m.private);
  assert.equal(privates.length, 1);
  assert.equal(privates[0].sender, 'alice');
});

test('READ: recipient (bob) sees DM addressed to him', async () => {
  const res = await request(app).get('/api/v1/messages?channel=secrets').set(authBob);
  const privates = res.body.messages.filter((m) => m.private);
  assert.equal(privates.length, 1);
});

test('READ: non-recipient (carol) does NOT see DM (filtered out)', async () => {
  const res = await request(app).get('/api/v1/messages?channel=secrets').set(authCarol);
  const privates = res.body.messages.filter((m) => m.private);
  assert.equal(privates.length, 0, 'carol should NOT see alice→bob DM');
  // Public messages still visible
  assert.ok(res.body.messages.some((m) => !m.private), 'public messages still visible');
});

test('READ: unbound bearer sees public only (fail-closed)', async () => {
  const res = await request(app).get('/api/v1/messages?channel=secrets').set(authUnbound);
  const privates = res.body.messages.filter((m) => m.private);
  assert.equal(privates.length, 0, 'unbound bearer must NEVER see private rows');
});

test('READ: ops-key sees ALL messages including DMs', async () => {
  // Clear audit log first
  if (fs.existsSync(auditPath)) fs.unlinkSync(auditPath);
  const res = await request(app).get('/api/v1/messages?channel=secrets').set(authOps);
  assert.equal(res.statusCode, 200);
  const privates = res.body.messages.filter((m) => m.private);
  assert.ok(privates.length >= 1, 'ops-key sees private messages');
});

test('AUDIT: ops-key read of private rows writes audit log entries', async () => {
  // Audit log should exist (written by prior ops-key read)
  assert.ok(fs.existsSync(auditPath), 'audit log written');
  const lines = fs.readFileSync(auditPath, 'utf-8').trim().split('\n');
  assert.ok(lines.length >= 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(typeof entry.ts, 'string');
  assert.equal(typeof entry.ops_key_id, 'string');
  assert.equal(entry.ops_key_id.length, 16, 'opsKeyId is sha256-prefix-16');
  assert.equal(typeof entry.message_id, 'number');
  assert.equal(entry.sender, 'alice');
  assert.ok(Array.isArray(entry.recipients));
  assert.ok(entry.recipients.includes('bob'));
  // Body NOT in audit log (envelope-only per admin #6469)
  assert.equal(entry.body, undefined);
});

// ============================================================
// GET /messages/:id leak prevention
// ============================================================

test('READ /messages/:id: non-recipient gets 404, not 403 (no existence leak)', async () => {
  // First, find the private message id as alice
  const aliceView = await request(app).get('/api/v1/messages?channel=secrets').set(authAlice);
  const dm = aliceView.body.messages.find((m) => m.private);
  assert.ok(dm, 'precondition: alice sees the DM');
  // Carol attempts to fetch it directly
  const res = await request(app).get(`/api/v1/messages/${dm.id}`).set(authCarol);
  assert.equal(res.statusCode, 404, 'must return 404 to avoid leaking existence');
  assert.equal(res.body.error, 'NotFound');
});

test('READ /messages/:id: recipient (bob) gets the DM', async () => {
  const aliceView = await request(app).get('/api/v1/messages?channel=secrets').set(authAlice);
  const dm = aliceView.body.messages.find((m) => m.private);
  const res = await request(app).get(`/api/v1/messages/${dm.id}`).set(authBob);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message.private, true);
});

test('READ /messages/:id: unbound bearer gets 404 on private (fail-closed)', async () => {
  const aliceView = await request(app).get('/api/v1/messages?channel=secrets').set(authAlice);
  const dm = aliceView.body.messages.find((m) => m.private);
  const res = await request(app).get(`/api/v1/messages/${dm.id}`).set(authUnbound);
  assert.equal(res.statusCode, 404);
});

// ============================================================
// GET /context filter
// ============================================================

test('READ /context (json): private rows filtered for non-recipient', async () => {
  const res = await request(app).get('/api/v1/context?channel=secrets&format=json').set(authCarol);
  assert.equal(res.statusCode, 200);
  const privates = res.body.messages.filter((m) => m.private);
  assert.equal(privates.length, 0);
});

// ============================================================
// Back-compat: existing public messages unchanged
// ============================================================

test('BACK-COMPAT: public messages have private=false on read', async () => {
  const res = await request(app).get('/api/v1/messages?channel=secrets').set(authAlice);
  const publics = res.body.messages.filter((m) => !m.private);
  assert.ok(publics.length >= 1);
  for (const m of publics) {
    assert.equal(m.private, false);
  }
});

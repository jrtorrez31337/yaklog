const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-multibinding-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'token-multi,token-single,token-unbound';
// token-multi bound to TWO sender names: canonical 'foo-agent' + legacy 'foo'
process.env.YAKLOG_TOKEN_BINDINGS = 'foo-agent:token-multi,foo:token-multi,bar-agent:token-single';
process.env.YAKLOG_DAEMON_BINDINGS = 'foo-agent:token-multi,foo:token-multi,bar-agent:token-single';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

const authMulti = { Authorization: 'Bearer token-multi' };
const authSingle = { Authorization: 'Bearer token-single' };
const authUnbound = { Authorization: 'Bearer token-unbound' };

test.after(() => closeDb());

// ----- /messages sender-binding (multi-binding-per-token) -----

test('multi-bound token POST messages with first bound sender → 201', async () => {
  const res = await request(app).post('/api/v1/messages').set(authMulti).send({
    channel: 'multi-test', sender: 'foo-agent', body: 'first sender'
  });
  assert.equal(res.statusCode, 201);
});

test('multi-bound token POST messages with second bound sender → 201', async () => {
  const res = await request(app).post('/api/v1/messages').set(authMulti).send({
    channel: 'multi-test', sender: 'foo', body: 'second sender'
  });
  assert.equal(res.statusCode, 201);
});

test('multi-bound token POST messages with non-bound sender → 403', async () => {
  const res = await request(app).post('/api/v1/messages').set(authMulti).send({
    channel: 'multi-test', sender: 'fake-agent', body: 'spoof'
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'SenderBindingViolation');
});

test('single-bound token POST messages with its bound sender → 201', async () => {
  const res = await request(app).post('/api/v1/messages').set(authSingle).send({
    channel: 'multi-test', sender: 'bar-agent', body: 'single bound'
  });
  assert.equal(res.statusCode, 201);
});

test('single-bound token POST messages claiming the multi-bound sender → 403 (cross-token isolation)', async () => {
  const res = await request(app).post('/api/v1/messages').set(authSingle).send({
    channel: 'multi-test', sender: 'foo-agent', body: 'cross-token spoof'
  });
  assert.equal(res.statusCode, 403);
});

// ----- /presence/event daemon-binding (multi-binding-per-token) -----

test('multi-bound token POST presence with first bound agent_id → 200', async () => {
  const res = await request(app).post('/api/v1/presence/event').set(authMulti).send({
    agent_id: 'foo-agent', daemon_state: 'up', session_state: 'active'
  });
  assert.equal(res.statusCode, 200);
});

test('multi-bound token POST presence with second bound agent_id → 200', async () => {
  const res = await request(app).post('/api/v1/presence/event').set(authMulti).send({
    agent_id: 'foo', daemon_state: 'up', session_state: 'active'
  });
  assert.equal(res.statusCode, 200);
});

test('multi-bound token POST presence with non-bound agent_id → 403', async () => {
  const res = await request(app).post('/api/v1/presence/event').set(authMulti).send({
    agent_id: 'fake-agent', daemon_state: 'up', session_state: 'active'
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'DaemonBindingViolation');
});

// ----- info-leakage gate preserved -----

test('multi-bound 403 body still leaks no agent_id', async () => {
  const res = await request(app).post('/api/v1/messages').set(authMulti).send({
    channel: 'multi-test', sender: 'mystery-agent', body: 'spoof'
  });
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes('foo-agent'), 'must not leak first bound sender');
  assert.ok(!serialized.includes('foo'), 'must not leak second bound sender');
  assert.ok(!serialized.includes('mystery-agent'), 'must not leak claimed sender');
});

// ----- regression: existing single-binding behavior unchanged -----

test('regression: single-binding token still works (Set semantics for n=1)', async () => {
  const res = await request(app).post('/api/v1/messages').set(authSingle).send({
    channel: 'multi-test', sender: 'bar-agent', body: 'still works'
  });
  assert.equal(res.statusCode, 201);
});

test('regression: unbound token still legacy-mode (any sender)', async () => {
  const res = await request(app).post('/api/v1/messages').set(authUnbound).send({
    channel: 'multi-test', sender: 'arbitrary', body: 'legacy'
  });
  assert.equal(res.statusCode, 201);
});

// ----- PATCH/DELETE multi-binding -----

test('multi-bound token PATCH message originally sent by either bound name → 200', async () => {
  // Create message as 'foo-agent'
  const create = await request(app).post('/api/v1/messages').set(authMulti).send({
    channel: 'multi-test', sender: 'foo-agent', body: 'original by foo-agent'
  });
  const id = create.body.message.id;
  // PATCH with the same multi-bound token (different sender entry)
  const patch = await request(app).patch(`/api/v1/messages/${id}`).set(authMulti).send({
    body: 'edited by multi-bound token (same token, message sender=foo-agent which is bound)'
  });
  assert.equal(patch.statusCode, 200);
});

test('single-bound token PATCH message owned by multi-bound agent → 403', async () => {
  // Create message as 'foo-agent' via multi-bound token
  const create = await request(app).post('/api/v1/messages').set(authMulti).send({
    channel: 'multi-test', sender: 'foo-agent', body: 'multi-bound message'
  });
  const id = create.body.message.id;
  // single-bound token (bar-agent) tries to PATCH
  const patch = await request(app).patch(`/api/v1/messages/${id}`).set(authSingle).send({
    body: 'cross-token edit attempt'
  });
  assert.equal(patch.statusCode, 403);
});

// PLAN-DASHBOARD-OPERATOR-DM Phase A server-side substrate-impl tests
// (v2 4-FLAG absorbed per secops #10497 + parch #10507 RATIFY).
//
// Covers FLAG-3 + Q9 enumerated empirical:
//   - Operator-class POST /messages: server overrides sender to operatorId
//   - Operator-class PATCH /messages/:id: bound to operator's own messages only
//   - Operator-class DELETE /messages/:id: bound to operator's own messages only
//   - Cross-class spoof defense: agent-bearer with sender:"op-jon" → 403
//   - Recipient-validation preserved: operator POST without @mention → 400
//   - Private:true happy path: operator POST + recipient mention + audit row

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-dashdm-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-agent-a,tok-operator-jon,tok-operator-op2';
process.env.YAKLOG_TOKEN_BINDINGS = 'agent-a:tok-agent-a';
process.env.YAKLOG_DAEMON_BINDINGS = 'agent-a:tok-agent-a';
process.env.YAKLOG_OPERATOR_BINDINGS = 'op-jon:tok-operator-jon,op-operator2:tok-operator-op2';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

const authAgent = { Authorization: 'Bearer tok-agent-a' };
const authOpJon = { Authorization: 'Bearer tok-operator-jon' };
const authOpOp2 = { Authorization: 'Bearer tok-operator-op2' };

test.after(() => {
  try { closeDb(); } catch {}
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ─── Operator-class POST /messages sender override (Block-1 sister-canon) ───

test('POST /messages: operator-class bearer with sender:"op-jon" → stored as op-jon (canonical no-op)', async () => {
  const r = await request(app).post('/api/v1/messages').set(authOpJon).send({
    channel: 'handoff', sender: 'op-jon', body: '@agent-a test',
  });
  assert.equal(r.statusCode, 201);
  assert.equal(r.body.message.sender, 'op-jon');
});

test('POST /messages: operator-class bearer with sender:"agent-a" (spoof) → server overrides to op-jon', async () => {
  const r = await request(app).post('/api/v1/messages').set(authOpJon).send({
    channel: 'handoff', sender: 'agent-a', body: '@agent-a spoof attempt',
  });
  assert.equal(r.statusCode, 201, 'should succeed — server override, not reject');
  assert.equal(r.body.message.sender, 'op-jon', 'server overrode spoofed sender to operatorId');
});

test('POST /messages: operator-class bearer with sender:"op-operator2" (cross-operator spoof) → server overrides to op-jon', async () => {
  const r = await request(app).post('/api/v1/messages').set(authOpJon).send({
    channel: 'handoff', sender: 'op-operator2', body: '@agent-a cross-operator spoof',
  });
  assert.equal(r.statusCode, 201);
  assert.equal(r.body.message.sender, 'op-jon', 'operator cannot impersonate other operator');
});

// ─── Cross-class spoof defense (agent posing as operator) ─────────────────

test('POST /messages: agent-class bearer with sender:"op-jon" → 403 SenderBindingViolation', async () => {
  const r = await request(app).post('/api/v1/messages').set(authAgent).send({
    channel: 'handoff', sender: 'op-jon', body: '@op-jon agent posing as operator',
  });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, 'SenderBindingViolation');
});

// ─── ADR-0026 v1 recipient-validation preserved at operator-class ─────────

test('POST /messages: operator-class private:true with NO @mention → 400 PrivateSendRequiresMentions', async () => {
  const r = await request(app).post('/api/v1/messages').set(authOpJon).send({
    channel: 'dm', sender: 'op-jon', body: 'no mention here', private: true,
  });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, 'PrivateSendRequiresMentions');
});

test('POST /messages: operator-class private:true with @recipient → 201 + stored private:true', async () => {
  const r = await request(app).post('/api/v1/messages').set(authOpJon).send({
    channel: 'dm', sender: 'op-jon', body: '@agent-a private message from operator', private: true,
  });
  assert.equal(r.statusCode, 201);
  assert.equal(r.body.message.private, true);
  assert.equal(r.body.message.sender, 'op-jon');
  assert.ok(r.body.message.mentions.includes('agent-a'));
});

// ─── PATCH /messages/:id operator-class scope (FLAG-3) ────────────────────

test('PATCH /messages/:id: operator can mutate their own message', async () => {
  const created = await request(app).post('/api/v1/messages').set(authOpJon).send({
    channel: 'handoff', sender: 'op-jon', body: '@agent-a original',
  });
  const id = created.body.message.id;
  const r = await request(app).patch(`/api/v1/messages/${id}`).set(authOpJon).send({
    body: '@agent-a edited',
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.message.body, '@agent-a edited');
});

test('PATCH /messages/:id: operator CANNOT mutate agent-class message (FLAG-3 bypass-defense)', async () => {
  const created = await request(app).post('/api/v1/messages').set(authAgent).send({
    channel: 'handoff', sender: 'agent-a', body: '@op-jon original from agent',
  });
  const id = created.body.message.id;
  const r = await request(app).patch(`/api/v1/messages/${id}`).set(authOpJon).send({
    body: 'operator trying to mutate agent message',
  });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, 'SenderBindingViolation');
});

test('PATCH /messages/:id: operator CANNOT mutate other operator message (cross-operator defense)', async () => {
  const created = await request(app).post('/api/v1/messages').set(authOpOp2).send({
    channel: 'handoff', sender: 'op-operator2', body: '@agent-a from operator2',
  });
  const id = created.body.message.id;
  const r = await request(app).patch(`/api/v1/messages/${id}`).set(authOpJon).send({
    body: 'op-jon trying to edit op-operator2 message',
  });
  assert.equal(r.statusCode, 403);
});

// ─── DELETE /messages/:id operator-class scope (FLAG-3) ───────────────────

test('DELETE /messages/:id: operator can delete their own message', async () => {
  const created = await request(app).post('/api/v1/messages').set(authOpJon).send({
    channel: 'handoff', sender: 'op-jon', body: '@agent-a to be deleted',
  });
  const id = created.body.message.id;
  const r = await request(app).delete(`/api/v1/messages/${id}`).set(authOpJon);
  assert.equal(r.statusCode, 204);
});

test('DELETE /messages/:id: operator CANNOT delete agent message (FLAG-3 bypass-defense)', async () => {
  const created = await request(app).post('/api/v1/messages').set(authAgent).send({
    channel: 'handoff', sender: 'agent-a', body: 'agent-a message',
  });
  const id = created.body.message.id;
  const r = await request(app).delete(`/api/v1/messages/${id}`).set(authOpJon);
  assert.equal(r.statusCode, 403);
});

// ─── Cross-route preservation (ADR-0040 §2.12 unchanged) ──────────────────

test('GET /secure-store/vendor-keys: operator-class still 401 (ADR-0040 §2.12 unchanged)', async () => {
  const r = await request(app).get('/api/v1/secure-store/vendor-keys')
    .set(authOpJon)
    .set('x-forwarded-proto', 'https');
  assert.equal(r.statusCode, 401);
});

// ─── ADR-0040 §4.1 Phase A invariant preserved at /presence/event ─────────

test('POST /presence/event: operator-class session_class server-enforced (ADR-0040 Phase A regression check)', async () => {
  const r = await request(app).post('/api/v1/presence/event').set(authOpJon).send({
    agent_id: 'op-jon', daemon_state: 'up', session_state: 'idle',
    session_class: 'agent', // spoof attempt
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.presence.session_class, 'operator');
});

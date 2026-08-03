// Operator-session Phase A substrate-impl per PLAN-OPERATOR-SESSION-SUBSTRATE
// v2 RATIFIED by parch #10382 + Jon-direct #10404. Sister-shape Task #137
// Phase A test pattern (15-test coverage span).
//
// Covers:
//   - YAKLOG_OPERATOR_BINDINGS env-tier parsing (config.js)
//   - req.tokenClass middleware resolution (operator/agent/ops)
//   - session_class server-enforced from req.tokenClass at /presence/event
//   - /secure-store/vendor-keys 401 reject when req.tokenClass === 'operator'
//   - operator_records CRUD in yaklog-secure.db (upsert/get/list/decommission)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-operator-session-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_YAKLOG_SECURE_DB_PATH = path.join(tempDir, 'yaklog-secure.db');
process.env.YAKLOG_API_KEYS = 'tok-agent,tok-operator,tok-ops';
process.env.YAKLOG_TOKEN_BINDINGS = 'agent-a:tok-agent';
process.env.YAKLOG_DAEMON_BINDINGS = 'agent-a:tok-agent';
process.env.YAKLOG_OPERATOR_BINDINGS = 'op-operator2:tok-operator';
process.env.YAKLOG_OPS_API_KEYS = 'tok-ops';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');
const config = require('../src/config');
const yaklogSecureDb = require('../src/yaklogSecureDb');

const authAgent = { Authorization: 'Bearer tok-agent' };
const authOperator = { Authorization: 'Bearer tok-operator' };

test.after(() => {
  try { closeDb(); } catch {}
  try { yaklogSecureDb.closeDb(); } catch {}
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ─── config.js env-tier parsing ────────────────────────────────────────────

test('config.operatorBindings parses YAKLOG_OPERATOR_BINDINGS env', () => {
  const ids = config.operatorBindings.get('tok-operator');
  assert.ok(ids, 'operatorBindings has tok-operator entry');
  assert.ok(ids.has('op-operator2'), 'op-operator2 bound to tok-operator');
});

test('config.operatorBindings is Map-of-Sets (sister-shape DAEMON_BINDINGS one-to-many)', () => {
  assert.ok(config.operatorBindings instanceof Map);
  for (const v of config.operatorBindings.values()) {
    assert.ok(v instanceof Set, 'each value is a Set');
  }
});

// ─── req.tokenClass middleware resolution ──────────────────────────────────

test('POST /presence/event with operator token: session_class enforced to "operator"', async () => {
  const r = await request(app).post('/api/v1/presence/event').set(authOperator).send({
    agent_id: 'op-operator2', daemon_state: 'up', session_state: 'idle',
    session_class: 'agent', // attempt to spoof — server must override
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.presence.session_class, 'operator', 'server-enforced operator class');
});

test('POST /presence/event with agent token: session_class enforced to "agent"', async () => {
  const r = await request(app).post('/api/v1/presence/event').set(authAgent).send({
    agent_id: 'agent-a', daemon_state: 'up', session_state: 'idle',
    session_class: 'operator', // attempt to spoof — server must override
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.presence.session_class, 'agent', 'server-enforced agent class');
});

test('GET /presence returns session_class on each row', async () => {
  const r = await request(app).get('/api/v1/presence/public');
  assert.equal(r.statusCode, 200);
  const op = r.body.presence.find((p) => p.agent_id === 'op-operator2');
  const ag = r.body.presence.find((p) => p.agent_id === 'agent-a');
  assert.ok(op, 'op-operator2 row present');
  assert.equal(op.session_class, 'operator');
  assert.ok(ag, 'agent-a row present');
  assert.equal(ag.session_class, 'agent');
});

test('GET /presence rows include decommissioned_at field (NULL when active)', async () => {
  const r = await request(app).get('/api/v1/presence/public');
  const ag = r.body.presence.find((p) => p.agent_id === 'agent-a');
  assert.equal(ag.decommissioned_at, null, 'active row has decommissioned_at=null');
});

// ─── /secure-store/vendor-keys class-gate (§2.12) ──────────────────────────

test('GET /api/v1/secure-store/vendor-keys rejects operator class with 401', async () => {
  // Defense-in-depth: even with TLS-terminated header, operator token gets 401.
  const r = await request(app).get('/api/v1/secure-store/vendor-keys')
    .set(authOperator)
    .set('x-forwarded-proto', 'https');
  assert.equal(r.statusCode, 401);
  assert.match(r.body.message, /[Oo]perator/);
});

test('GET /api/v1/secure-store/vendor-keys does NOT reject agent class with 401 at operator-gate', async () => {
  // Agent bearer should pass the operator-class gate (may still 403 on grants-resolution
  // or 503 on other gates, but NOT 401 with operator-class message).
  const r = await request(app).get('/api/v1/secure-store/vendor-keys')
    .set(authAgent)
    .set('x-forwarded-proto', 'https');
  // Whatever status (403 unresolvable-agent, 200 ok-empty, etc.) — NOT operator-class 401.
  if (r.statusCode === 401) {
    assert.doesNotMatch(r.body.message || '', /[Oo]perator/);
  }
});

// ─── operator_records CRUD ─────────────────────────────────────────────────

test('upsertOperatorRecord creates row with user_email + actor', () => {
  yaklogSecureDb.initializeDb({ dbPath: process.env.YAKLOG_YAKLOG_SECURE_DB_PATH });
  const r = yaklogSecureDb.upsertOperatorRecord({
    operatorId: 'op-test-1',
    userEmail: 'test1@example.com',
    actor: 'admin-agent',
    notes: 'Phase A test',
  });
  assert.equal(r.operator_id, 'op-test-1');
  assert.ok(r.created_at);
});

test('getOperatorRecord returns row with all fields', () => {
  const row = yaklogSecureDb.getOperatorRecord('op-test-1');
  assert.ok(row);
  assert.equal(row.operator_id, 'op-test-1');
  assert.equal(row.user_email, 'test1@example.com');
  assert.equal(row.created_by, 'admin-agent');
  assert.equal(row.decommissioned_at, null);
});

test('listOperatorRecords excludes decommissioned by default', () => {
  yaklogSecureDb.upsertOperatorRecord({
    operatorId: 'op-test-2',
    userEmail: 'test2@example.com',
    actor: 'admin-agent',
  });
  yaklogSecureDb.decommissionOperatorRecord({
    operatorId: 'op-test-2',
    actor: 'admin-agent',
    notes: 'offboarded',
  });
  const active = yaklogSecureDb.listOperatorRecords();
  assert.ok(!active.find((r) => r.operator_id === 'op-test-2'), 'op-test-2 excluded');
  assert.ok(active.find((r) => r.operator_id === 'op-test-1'), 'op-test-1 included');
});

test('listOperatorRecords with includeDecommissioned returns all', () => {
  const all = yaklogSecureDb.listOperatorRecords({ includeDecommissioned: true });
  assert.ok(all.find((r) => r.operator_id === 'op-test-1'));
  assert.ok(all.find((r) => r.operator_id === 'op-test-2'));
});

test('decommissionOperatorRecord sets decommissioned_at + by', () => {
  const row = yaklogSecureDb.getOperatorRecord('op-test-2');
  assert.ok(row.decommissioned_at, 'decommissioned_at set');
  assert.equal(row.decommissioned_by, 'admin-agent');
});

test('decommissionOperatorRecord is no-op on already-decommissioned row', () => {
  const r = yaklogSecureDb.decommissionOperatorRecord({
    operatorId: 'op-test-2',
    actor: 'admin-agent',
  });
  assert.equal(r.updated, 0, 'no rows updated on second decommission');
});

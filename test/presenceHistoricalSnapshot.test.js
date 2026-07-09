// Task #279 / PLAN-DASHBOARD-TIME-NAVIGATION §3.1: presence historical-snapshot.
// Verifies GET /api/v1/presence/public?at=<iso> reconstructs the presence
// state as-of a past moment from presence_transitions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-preshist-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'token-alpha,token-beta';
process.env.YAKLOG_OPS_API_KEYS = 'ops-secret';
process.env.YAKLOG_TOKEN_BINDINGS = 'alpha:token-alpha,beta:token-beta';
process.env.YAKLOG_DAEMON_BINDINGS = 'alpha:token-alpha,beta:token-beta';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb, listPresenceAt } = require('../src/db');

const authAlpha = { Authorization: 'Bearer token-alpha' };
const authBeta  = { Authorization: 'Bearer token-beta' };

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// Seed a presence event, sleep, seed another so the transition row lands.
async function emit(agentId, tokenAuth, sessionState) {
  return request(app).post('/api/v1/presence/event').set(tokenAuth).send({
    agent_id: agentId,
    daemon_state: 'up', session_state: sessionState,
    event_type: 'diag', payload: {},
  });
}

test('§3.1 — endpoint rejects malformed ?at', async () => {
  const r1 = await request(app).get('/api/v1/presence/public?at=not-a-date');
  assert.equal(r1.status, 400);
  assert.equal(r1.body.error, 'ValidationError');

  const r2 = await request(app).get('/api/v1/presence/public?at=2026-99-01T00:00:00Z');
  assert.equal(r2.status, 400);

  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const r3 = await request(app).get('/api/v1/presence/public?at=' + encodeURIComponent(future));
  assert.equal(r3.status, 400);
  assert.match(r3.body.message, /future/);
});

test('§3.1 — omitted ?at yields current-state behavior (backward-compat)', async () => {
  await emit('alpha', authAlpha, 'tool_running');
  const r = await request(app).get('/api/v1/presence/public');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.presence));
  assert.ok(r.body.presence.some((p) => p.agent_id === 'alpha' && p.label === 'online_tool_running'));
  // Sentinel: no _snapshot metadata on live query
  assert.equal(r.body._snapshot, undefined);
});

test('§3.1 — ?at before any transition returns empty presence', async () => {
  // Well before any test emit
  const r = await request(app).get('/api/v1/presence/public?at=2000-01-01T00:00:00Z');
  assert.equal(r.status, 200);
  assert.equal(r.body.presence.length, 0);
  assert.equal(r.body.count, 0);
  assert.equal(r.body._snapshot.as_of, '2000-01-01T00:00:00.000Z');
  assert.equal(r.body._snapshot.transitions_used, 0);
});

test('§3.1 — ?at reconstructs snapshot from presence_transitions', async () => {
  // Seed alpha in tool_running state (label online_tool_running)
  await emit('alpha', authAlpha, 'tool_running');
  await new Promise((r) => setTimeout(r, 20));
  const mid = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 20));
  // Then transition alpha to idle (label online_idle)
  await emit('alpha', authAlpha, 'idle');

  // Query as-of `mid` — should show alpha at the earlier label
  const r = await request(app).get('/api/v1/presence/public?at=' + encodeURIComponent(mid));
  assert.equal(r.status, 200);
  const alpha = r.body.presence.find((p) => p.agent_id === 'alpha');
  assert.ok(alpha, 'alpha should exist in historical snapshot');
  assert.equal(alpha.label, 'online_tool_running');
  // Rich fields are honestly null in historical mode (not in presence_transitions)
  assert.equal(alpha.current_tool, null);
  assert.equal(alpha.current_model, null);
  assert.equal(alpha.cursor_position, null);
  // runtime is enriched from registry (server-side compute; not from transitions)
  assert.ok(alpha.runtime, 'runtime should be enriched from registry');
});

test('§3.1 — ?at after latest transition returns the latest state', async () => {
  await emit('beta', authBeta, 'idle');
  await new Promise((r) => setTimeout(r, 10));
  const now = new Date().toISOString();
  const r = await request(app).get('/api/v1/presence/public?at=' + encodeURIComponent(now));
  assert.equal(r.status, 200);
  const beta = r.body.presence.find((p) => p.agent_id === 'beta');
  assert.ok(beta, 'beta should exist in historical snapshot');
  assert.equal(beta.label, 'online_idle');
});

test('§3.1 — listPresenceAt DB helper contract', () => {
  const rows = listPresenceAt('2000-01-01T00:00:00Z');
  assert.deepEqual(rows, []);
  const rowsNow = listPresenceAt(new Date().toISOString());
  assert.ok(rowsNow.length > 0);
  for (const row of rowsNow) {
    assert.ok(row.agent_id);
    assert.ok(row.to_label);
    assert.ok(row.occurred_at);
  }
});

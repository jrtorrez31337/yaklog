const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-presence-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'token-a,token-b,token-unbound';
process.env.YAKLOG_DAEMON_BINDINGS = 'agent-a:token-a,agent-b:token-b';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb, expireStalePresence, deriveLabel } = require('../src/db');

const authA = { Authorization: 'Bearer token-a' };
const authB = { Authorization: 'Bearer token-b' };
const authUnbound = { Authorization: 'Bearer token-unbound' };

test.after(() => closeDb());

test('POST /presence/event with bound daemon token + matching agent_id succeeds', async () => {
  const res = await request(app).post('/api/v1/presence/event').set(authA).send({
    agent_id: 'agent-a',
    daemon_state: 'up',
    session_state: 'active',
    cursor_position: 100,
    lock_held: true,
    sse_connected: true
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.presence.agent_id, 'agent-a');
  assert.equal(res.body.presence.label, 'online');
  assert.equal(res.body.presence.cursor_position, 100);
});

test('POST /presence/event with bound token but different agent_id is 403', async () => {
  const res = await request(app).post('/api/v1/presence/event').set(authA).send({
    agent_id: 'agent-b',
    daemon_state: 'up',
    session_state: 'active'
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'DaemonBindingViolation');
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes('agent-a'), 'response must not leak bound agent_id');
  assert.ok(!serialized.includes('agent-b'), 'response must not leak claimed agent_id');
});

test('POST /presence/event with unbound token accepts any agent_id (legacy)', async () => {
  const res = await request(app).post('/api/v1/presence/event').set(authUnbound).send({
    agent_id: 'arbitrary-agent',
    daemon_state: 'up',
    session_state: 'idle'
  });
  assert.equal(res.statusCode, 200);
});

test('POST /presence/event derived label matrix', async () => {
  const cases = [
    ['up', 'active', 'online'],
    ['up', 'idle', 'online_idle'],
    ['up', 'unknown', 'stalled'],
    ['up', 'tool_running', 'online_tool_running'],
    ['up', 'idle_between_tools', 'online_idle_between_tools'],
    // CP14.x (Task #174): in_flight enum for long-running CLI runtime sessions.
    ['up', 'in_flight', 'online_in_flight'],
    ['down', 'active', 'offline'],
    ['down', 'idle', 'offline'],
    ['down', 'unknown', 'offline'],
    ['down', 'in_flight', 'offline']
  ];
  for (const [daemon, session, expected] of cases) {
    const res = await request(app).post('/api/v1/presence/event').set(authA).send({
      agent_id: 'agent-a',
      daemon_state: daemon,
      session_state: session
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.presence.label, expected, `${daemon}+${session} should derive ${expected}`);
  }
});

test('POST /presence/event invalid daemon_state rejected', async () => {
  const res = await request(app).post('/api/v1/presence/event').set(authA).send({
    agent_id: 'agent-a',
    daemon_state: 'spinning',
    session_state: 'active'
  });
  assert.equal(res.statusCode, 400);
});

test('POST /presence/event missing agent_id rejected', async () => {
  const res = await request(app).post('/api/v1/presence/event').set(authA).send({
    daemon_state: 'up',
    session_state: 'active'
  });
  assert.equal(res.statusCode, 400);
});

test('GET /presence returns full swarm + ETag', async () => {
  const res = await request(app).get('/api/v1/presence').set(authA);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.presence));
  assert.ok(res.body.presence.some((p) => p.agent_id === 'agent-a'));
  assert.ok(res.headers.etag, 'ETag header should be present');
});

test('GET /presence returns 304 on If-None-Match with matching ETag', async () => {
  const first = await request(app).get('/api/v1/presence').set(authA);
  const etag = first.headers.etag;
  assert.ok(etag);
  const second = await request(app).get('/api/v1/presence').set(authA).set('If-None-Match', etag);
  assert.equal(second.statusCode, 304);
});

test('GET /presence ETag changes when state changes', async () => {
  const before = await request(app).get('/api/v1/presence').set(authA);
  const etagBefore = before.headers.etag;
  await request(app).post('/api/v1/presence/event').set(authB).send({
    agent_id: 'agent-b',
    daemon_state: 'up',
    session_state: 'active'
  });
  const after = await request(app).get('/api/v1/presence').set(authA);
  assert.notEqual(after.headers.etag, etagBefore);
});

test('GET /presence/:agent_id returns single + transitions', async () => {
  const res = await request(app).get('/api/v1/presence/agent-a').set(authA);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.presence.agent_id, 'agent-a');
  assert.ok(Array.isArray(res.body.transitions));
  assert.ok(res.body.transitions.length >= 1, 'at least one transition recorded from prior state changes');
});

test('GET /presence/:agent_id returns 404 for unknown agent', async () => {
  const res = await request(app).get('/api/v1/presence/never-existed').set(authA);
  assert.equal(res.statusCode, 404);
});

test('TTL expiry sweep flips daemon_state to down for stale rows', async () => {
  await request(app).post('/api/v1/presence/event').set(authA).send({
    agent_id: 'agent-a',
    daemon_state: 'up',
    session_state: 'active'
  });
  const expired = expireStalePresence(-1);
  assert.ok(expired.includes('agent-a'), 'agent-a should be expired by negative-ttl sweep');
  const after = await request(app).get('/api/v1/presence/agent-a').set(authA);
  assert.equal(after.body.presence.daemon_state, 'down');
  assert.equal(after.body.presence.label, 'offline');
  assert.ok(after.body.transitions.some((t) => (t.reason || '').startsWith('ttl_expired')), 'TTL expiry should record a transition');
});

test('TTL expiry sweep does NOT touch already-down agents', async () => {
  await request(app).post('/api/v1/presence/event').set(authA).send({
    agent_id: 'agent-a',
    daemon_state: 'down',
    session_state: 'active'
  });
  const expired = expireStalePresence(-1);
  assert.ok(!expired.includes('agent-a'), 'already-down agent should not be re-expired');
});

test('presence transition recorded only on state change', async () => {
  // Force agent-a into a known state first
  await request(app).post('/api/v1/presence/event').set(authA).send({
    agent_id: 'agent-a',
    daemon_state: 'up',
    session_state: 'idle'
  });
  const before = await request(app).get('/api/v1/presence/agent-a').set(authA);
  const transitionsBefore = before.body.transitions.length;
  // First post changes state up→down
  await request(app).post('/api/v1/presence/event').set(authA).send({
    agent_id: 'agent-a',
    daemon_state: 'down',
    session_state: 'idle'
  });
  // Second identical post should NOT record a new transition
  await request(app).post('/api/v1/presence/event').set(authA).send({
    agent_id: 'agent-a',
    daemon_state: 'down',
    session_state: 'idle'
  });
  const after = await request(app).get('/api/v1/presence/agent-a').set(authA);
  assert.equal(after.body.transitions.length, transitionsBefore + 1, 'exactly one transition should be added across two posts (one state change + one no-op)');
});

// v0.5.9.4 (game-designer #6898 fix): deriveLabel must handle stop_failure
// session_state. Previously fell through to 'offline' even when daemon up
// — visible regression for any agent whose last hook was StopFailure +
// went idle. Reproduction shape from #6898 peer-comparison.
test('deriveLabel: stop_failure session_state on up daemon → label stop_failure (not offline)', () => {
  assert.equal(deriveLabel('up', 'stop_failure', 1), 'stop_failure');
  assert.equal(deriveLabel('up', 'stop_failure', 0), 'stop_failure',
    'consumer=0 + non-unknown session_state must NOT trigger daemon_only short-circuit');
});
test('deriveLabel: down daemon + stop_failure → offline (matches pattern for all session_states on down)', () => {
  assert.equal(deriveLabel('down', 'stop_failure', 1), 'offline');
});
test('deriveLabel: regression coverage for the pre-existing mappings', () => {
  // Spot-check the known-good cases so a future drive-by edit doesn't break them silently
  assert.equal(deriveLabel('up',   'idle',     1), 'online_idle');
  assert.equal(deriveLabel('up',   'active',   1), 'online');
  assert.equal(deriveLabel('up',   'unknown',  1), 'stalled');
  assert.equal(deriveLabel('up',   'unknown',  0), 'daemon_only');
  assert.equal(deriveLabel('down', 'idle',     1), 'offline');
});

// CP14.x (Task #174): in_flight enum for long-running CLI runtimes
// (Codex/Gemini sessions minutes-to-hours; distinct from short-duration
// tool_running per-invocation). Sister-shape online_tool_running but
// signals "expect extended wait for next state change."
test('deriveLabel: in_flight session_state on up daemon → label online_in_flight', () => {
  assert.equal(deriveLabel('up',   'in_flight', 1), 'online_in_flight');
  // consumer=0 + non-unknown session_state must NOT trigger daemon_only short-circuit
  assert.equal(deriveLabel('up',   'in_flight', 0), 'online_in_flight');
});
test('deriveLabel: down daemon + in_flight → offline (canonical down→offline mapping)', () => {
  assert.equal(deriveLabel('down', 'in_flight', 1), 'offline');
});

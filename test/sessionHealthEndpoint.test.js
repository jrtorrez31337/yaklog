// Task #280 §3.5 integration: POST /presence/event accepts session_health,
// GET /presence/public surfaces session_health + session_health_class.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-sh-endpoint-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'token-alpha';
process.env.YAKLOG_OPS_API_KEYS = 'ops-secret';
process.env.YAKLOG_TOKEN_BINDINGS = 'alpha:token-alpha';
process.env.YAKLOG_DAEMON_BINDINGS = 'alpha:token-alpha';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

const authAlpha = { Authorization: 'Bearer token-alpha' };

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test('§3.4 POST /presence/event rejects invalid session_health enum', async () => {
  const r = await request(app).post('/api/v1/presence/event').set(authAlpha).send({
    agent_id: 'alpha', daemon_state: 'up', session_state: 'idle',
    session_health: 'bogus_class',
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'ValidationError');
  assert.match(r.body.message, /session_health/);
});

test('§3.4 POST /presence/event accepts valid session_health + persists', async () => {
  const r = await request(app).post('/api/v1/presence/event').set(authAlpha).send({
    agent_id: 'alpha', daemon_state: 'up', session_state: 'idle',
    session_health: 'session_expired',
    session_health_reason: 'Please run codex login',
  });
  assert.equal(r.status, 200);
});

test('§3.5 GET /presence/public surfaces session_health + class', async () => {
  const r = await request(app).get('/api/v1/presence/public');
  assert.equal(r.status, 200);
  const alpha = r.body.presence.find((p) => p.agent_id === 'alpha');
  assert.ok(alpha);
  assert.equal(alpha.session_health, 'session_expired');
  assert.equal(alpha.session_health_class, 'RED');
  assert.equal(alpha.session_health_reason, 'Please run codex login');
});

test('§3.5 Omitted session_health preserved via COALESCE (heartbeat does not wipe)', async () => {
  // Heartbeat WITHOUT session_health — must preserve the prior session_expired
  await request(app).post('/api/v1/presence/event').set(authAlpha).send({
    agent_id: 'alpha', daemon_state: 'up', session_state: 'idle',
  });
  const r = await request(app).get('/api/v1/presence/public');
  const alpha = r.body.presence.find((p) => p.agent_id === 'alpha');
  assert.equal(alpha.session_health, 'session_expired');
});

test('§3.5 Explicit honest_idle re-classify overrides prior RED', async () => {
  await request(app).post('/api/v1/presence/event').set(authAlpha).send({
    agent_id: 'alpha', daemon_state: 'up', session_state: 'idle',
    session_health: 'honest_idle',
    session_health_reason: 'no error pattern detected',
  });
  const r = await request(app).get('/api/v1/presence/public');
  const alpha = r.body.presence.find((p) => p.agent_id === 'alpha');
  assert.equal(alpha.session_health, 'honest_idle');
  assert.equal(alpha.session_health_class, 'GREEN');
});

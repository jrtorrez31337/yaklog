// Task #282: server-side clamp on absurd runtime_blocked_until sentinels.
// Verifies /api/v1/presence/public enriches obviously-fake future timestamps
// (>30d) to null so the dashboard doesn't render "resets in 613728.5h".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-rblocked-test-'));
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

async function post(agent_id, extra) {
  return request(app).post('/api/v1/presence/event').set(authAlpha).send({
    agent_id, daemon_state: 'up', session_state: 'idle',
    ...extra,
  });
}

test('Task #282 — 2099-year sentinel enriched to null at /presence/public', async () => {
  await post('alpha', {
    runtime_state: 'quota_exhausted',
    runtime_blocked_until: '2099-12-01T15:04:00+00:00',
  });
  const r = await request(app).get('/api/v1/presence/public');
  const alpha = r.body.presence.find((p) => p.agent_id === 'alpha');
  assert.ok(alpha);
  assert.equal(alpha.runtime_state, 'quota_exhausted');
  assert.equal(alpha.runtime_blocked_until, null,
    'far-future sentinel should be clamped to null');
});

test('Task #282 — reset within 30d window PRESERVED (real quota reset)', async () => {
  const in7Days = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  await post('alpha', {
    runtime_state: 'quota_exhausted',
    runtime_blocked_until: in7Days,
  });
  const r = await request(app).get('/api/v1/presence/public');
  const alpha = r.body.presence.find((p) => p.agent_id === 'alpha');
  assert.equal(alpha.runtime_blocked_until, in7Days,
    'legitimate near-future timestamp must NOT be clamped');
});

test('Task #282 — past reset PRESERVED (already-cleared block)', async () => {
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  await post('alpha', {
    runtime_state: 'active',
    runtime_blocked_until: yesterday,
  });
  const r = await request(app).get('/api/v1/presence/public');
  const alpha = r.body.presence.find((p) => p.agent_id === 'alpha');
  assert.equal(alpha.runtime_blocked_until, yesterday);
});

test('Task #282 — 31-day-out timestamp clamped (just past horizon)', async () => {
  const in31Days = new Date(Date.now() + 31 * 24 * 3600 * 1000).toISOString();
  await post('alpha', {
    runtime_state: 'quota_exhausted',
    runtime_blocked_until: in31Days,
  });
  const r = await request(app).get('/api/v1/presence/public');
  const alpha = r.body.presence.find((p) => p.agent_id === 'alpha');
  assert.equal(alpha.runtime_blocked_until, null);
});

test('Task #282 — null passes through (no runtime_state, no timestamp)', async () => {
  await post('alpha', {
    runtime_state: 'active',
    runtime_blocked_until: null,
  });
  const r = await request(app).get('/api/v1/presence/public');
  const alpha = r.body.presence.find((p) => p.agent_id === 'alpha');
  assert.equal(alpha.runtime_blocked_until, null);
});

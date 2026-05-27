const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-rtstate-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-a';
process.env.YAKLOG_DAEMON_BINDINGS = 'agent-a:tok-a';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

const authA = { Authorization: 'Bearer tok-a' };

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

async function heartbeat(payload) {
  return request(app).post('/api/v1/presence/event').set(authA).send({
    agent_id: 'agent-a', daemon_state: 'up', session_state: 'idle',
    ...payload,
  });
}

test('POST without runtime_state → row stored with null (legacy back-compat)', async () => {
  const r = await heartbeat({});
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.presence.runtime_state, null);
  assert.equal(r.body.presence.runtime_blocked_until, null);
});

test('POST with runtime_state=active → row stores active', async () => {
  const r = await heartbeat({ runtime_state: 'active' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.presence.runtime_state, 'active');
});

test('POST with runtime_state=quota_exhausted + runtime_blocked_until → both stored', async () => {
  const eta = '2026-05-27T18:42:00Z';
  const r = await heartbeat({ runtime_state: 'quota_exhausted', runtime_blocked_until: eta });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.presence.runtime_state, 'quota_exhausted');
  assert.equal(r.body.presence.runtime_blocked_until, eta);
});

test('POST with runtime_state=error → stored', async () => {
  const r = await heartbeat({ runtime_state: 'error' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.presence.runtime_state, 'error');
});

test('POST with invalid runtime_state value → 400 ValidationError', async () => {
  const r = await heartbeat({ runtime_state: 'totally_invalid' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, 'ValidationError');
  assert.match(r.body.message, /runtime_state/);
});

test('Recovery flow: quota_exhausted → active clears blocked_until on raw-assign', async () => {
  // Set blocked first
  await heartbeat({ runtime_state: 'quota_exhausted', runtime_blocked_until: '2026-05-27T20:00:00Z' });
  // Recover with explicit null on blocked_until
  const r = await heartbeat({ runtime_state: 'active', runtime_blocked_until: null });
  assert.equal(r.body.presence.runtime_state, 'active');
  assert.equal(r.body.presence.runtime_blocked_until, null);
});

test('GET /presence/public returns runtime_state + runtime_blocked_until fields', async () => {
  await heartbeat({ runtime_state: 'quota_exhausted', runtime_blocked_until: '2026-05-27T22:00:00Z' });
  const r = await request(app).get('/api/v1/presence/public');
  assert.equal(r.statusCode, 200);
  const row = r.body.presence.find(x => x.agent_id === 'agent-a');
  assert.ok(row, 'agent-a row present');
  assert.equal(row.runtime_state, 'quota_exhausted');
  assert.equal(row.runtime_blocked_until, '2026-05-27T22:00:00Z');
});

test('ETag changes when runtime_state transitions', async () => {
  await heartbeat({ runtime_state: 'active' });
  const r1 = await request(app).get('/api/v1/presence/public');
  const etag1 = r1.headers.etag;
  await heartbeat({ runtime_state: 'quota_exhausted', runtime_blocked_until: '2026-05-28T01:00:00Z' });
  const r2 = await request(app).get('/api/v1/presence/public');
  const etag2 = r2.headers.etag;
  assert.notEqual(etag1, etag2, 'ETag must change so dashboard refreshes on transition');
});

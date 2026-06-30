// Task #257 / CP16 Pillar 3 — server-side filter + sort on /presence/public
// per PLAN-CP16-PILLAR-3-AGENTCARD-SORT-FILTER + parch #11169 OQ disposition.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-p3-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-a,tok-b,tok-c';
process.env.YAKLOG_DAEMON_BINDINGS = 'agent-a:tok-a,agent-b:tok-b,agent-c:tok-c';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

const authA = { Authorization: 'Bearer tok-a' };
const authB = { Authorization: 'Bearer tok-b' };
const authC = { Authorization: 'Bearer tok-c' };

test.after(() => closeDb());

// Seed 3 presence rows w/ distinct shapes
async function seedAgents() {
  await request(app).post('/api/v1/presence/event').set(authA).send({
    agent_id: 'agent-a', daemon_state: 'up', session_state: 'active',
  });
  await request(app).post('/api/v1/presence/event').set(authB).send({
    agent_id: 'agent-b', daemon_state: 'up', session_state: 'idle',
  });
  await request(app).post('/api/v1/presence/event').set(authC).send({
    agent_id: 'agent-c', daemon_state: 'down', session_state: 'unknown',
  });
}

test('Pillar 3 — no params returns full set with no _filter (backward-compat)', async () => {
  await seedAgents();
  const res = await request(app).get('/api/v1/presence/public');
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.presence));
  assert.ok(res.body.presence.length >= 3);
  // Backward-compat sentinel: no _filter object when no filter applied
  assert.equal(res.body._filter, undefined);
});

test('Pillar 3 — filter[status]=active returns only active sessions + _filter present', async () => {
  const res = await request(app).get('/api/v1/presence/public?filter[status]=active');
  assert.equal(res.statusCode, 200);
  for (const row of res.body.presence) {
    // Composite match: session_state OR runtime_state OR label === 'active'
    const matches = row.session_state === 'active' || row.runtime_state === 'active' || row.label === 'active';
    assert.ok(matches, `row ${row.agent_id} (session=${row.session_state}) should be 'active'-matched`);
  }
  // _filter namespaced object per parch #11169 OQ2 RATIFY
  assert.equal(res.body._filter.applied, true);
  assert.ok(typeof res.body._filter.total_pre_filter === 'number');
  assert.ok(res.body._filter.total_pre_filter >= res.body.presence.length);
});

test('Pillar 3 — filter[status]=idle returns only idle sessions', async () => {
  const res = await request(app).get('/api/v1/presence/public?filter[status]=idle');
  assert.equal(res.statusCode, 200);
  for (const row of res.body.presence) {
    const matches = row.session_state === 'idle' || row.runtime_state === 'idle' || row.label === 'idle';
    assert.ok(matches);
  }
});

test('Pillar 3 — filter[search] substring match on agent_id (case-insensitive)', async () => {
  const res = await request(app).get('/api/v1/presence/public?filter[search]=AGENT-A');
  assert.equal(res.statusCode, 200);
  for (const row of res.body.presence) {
    assert.ok(String(row.agent_id).toLowerCase().includes('agent-a'));
  }
  assert.ok(res.body.presence.some((r) => r.agent_id === 'agent-a'));
});

test('Pillar 3 — filter[search] >64 chars → 400 ValidationError', async () => {
  const long = 'x'.repeat(65);
  const res = await request(app).get(`/api/v1/presence/public?filter[search]=${long}`);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'ValidationError');
});

test('Pillar 3 — multi-filter AND (filter[status] + filter[search])', async () => {
  const res = await request(app).get('/api/v1/presence/public?filter[status]=active&filter[search]=agent-a');
  assert.equal(res.statusCode, 200);
  for (const row of res.body.presence) {
    const statusMatch = row.session_state === 'active' || row.runtime_state === 'active' || row.label === 'active';
    const searchMatch = String(row.agent_id).toLowerCase().includes('agent-a');
    assert.ok(statusMatch && searchMatch);
  }
});

test('Pillar 3 — sort=agent_id asc (default) returns alphabetic order', async () => {
  const res = await request(app).get('/api/v1/presence/public?sort=agent_id');
  assert.equal(res.statusCode, 200);
  const ids = res.body.presence.map((r) => r.agent_id);
  const sorted = ids.slice().sort();
  assert.deepEqual(ids, sorted);
});

test('Pillar 3 — sort=agent_id desc reverses', async () => {
  const res = await request(app).get('/api/v1/presence/public?sort=agent_id&sort_dir=desc');
  assert.equal(res.statusCode, 200);
  const ids = res.body.presence.map((r) => r.agent_id);
  const sorted = ids.slice().sort().reverse();
  assert.deepEqual(ids, sorted);
});

test('Pillar 3 — sort=invalid → 400 (no silent fallback per validation canon)', async () => {
  const res = await request(app).get('/api/v1/presence/public?sort=bogus_field');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'ValidationError');
});

test('Pillar 3 — sort_dir=invalid → 400', async () => {
  const res = await request(app).get('/api/v1/presence/public?sort=agent_id&sort_dir=sideways');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'ValidationError');
});

test('Pillar 3 — sort=last_active desc puts nulls last', async () => {
  const res = await request(app).get('/api/v1/presence/public?sort=last_active');
  assert.equal(res.statusCode, 200);
  const rows = res.body.presence;
  // Find first null index; all subsequent must also be null (nulls-last)
  let seenNull = false;
  for (const row of rows) {
    if (row.last_heartbeat_at == null) seenNull = true;
    else assert.ok(!seenNull, 'non-null heartbeat after a null = nulls-last violated');
  }
});

test('Pillar 3 — ETag changes when filter applied (cache-correctness)', async () => {
  const r1 = await request(app).get('/api/v1/presence/public');
  const r2 = await request(app).get('/api/v1/presence/public?filter[status]=active');
  assert.notEqual(r1.headers.etag, r2.headers.etag);
});

test('Pillar 3 — 304 still works for repeat-request with same filter', async () => {
  const first = await request(app).get('/api/v1/presence/public?filter[status]=active');
  const etag = first.headers.etag;
  const second = await request(app).get('/api/v1/presence/public?filter[status]=active').set('If-None-Match', etag);
  assert.equal(second.statusCode, 304);
});

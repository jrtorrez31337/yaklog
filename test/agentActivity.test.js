const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-activity-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-a,tok-b';
process.env.YAKLOG_DAEMON_BINDINGS = 'agent-a:tok-a,agent-b:tok-b';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

const authA = { Authorization: 'Bearer tok-a' };
const authB = { Authorization: 'Bearer tok-b' };

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

async function postBatch(entries, auth = authA, agentId = 'agent-a') {
  return request(app).post(`/api/v1/agents/${agentId}/activity`).set(auth).send({ entries });
}

test('POST single entry → 200, inserted=1, GET returns it', async () => {
  const r = await postBatch([{ event: 'PreToolUse', payload: { tool: 'Bash', cmd: 'git status' } }]);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.inserted, 1);

  const g = await request(app).get('/api/v1/agents/agent-a/activity?limit=10').set(authA);
  assert.equal(g.statusCode, 200);
  assert.equal(g.body.activity.length, 1);
  assert.equal(g.body.activity[0].event, 'PreToolUse');
  assert.equal(g.body.activity[0].payload.tool, 'Bash');
});

test('batch of 10 entries → inserted=10, ordered newest first on GET', async () => {
  const batch = Array.from({ length: 10 }, (_, i) => ({
    event: 'PreToolUse',
    ts: `2026-06-02T01:00:${String(i).padStart(2, '0')}Z`,
    payload: { tool: 'Read', file: `/tmp/f${i}.txt` },
  }));
  const r = await postBatch(batch, authB, 'agent-b');
  assert.equal(r.body.inserted, 10);
  const g = await request(app).get('/api/v1/agents/agent-b/activity?limit=20').set(authB);
  // Newest first by id
  assert.equal(g.body.activity[0].payload.file, '/tmp/f9.txt');
  assert.equal(g.body.activity[9].payload.file, '/tmp/f0.txt');
});

test('daemon-binding violation: tok-a posting for agent-b → 403', async () => {
  const r = await postBatch([{ event: 'PreToolUse' }], authA, 'agent-b');
  assert.equal(r.statusCode, 403);
});

test('empty batch → 200 with inserted=0', async () => {
  const r = await postBatch([]);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.inserted, 0);
});

test('batch > 100 entries → 400', async () => {
  const big = Array.from({ length: 101 }, () => ({ event: 'PreToolUse' }));
  const r = await postBatch(big);
  assert.equal(r.statusCode, 400);
});

test('invalid event name → 400', async () => {
  const r = await postBatch([{ event: 'bad event with spaces' }]);
  assert.equal(r.statusCode, 400);
});

test('payload exceeding 4KB → 413', async () => {
  const big = 'x'.repeat(5000);
  const r = await postBatch([{ event: 'PreToolUse', payload: { huge: big } }]);
  assert.equal(r.statusCode, 413);
});

test('insertion cap: per-agent 200 trim on overflow', async () => {
  // Post 50 more entries to agent-b (already has 10 + 1 from above tests if they shared state — but
  // each test file uses its own temp DB, so this file alone created 11 to agent-b so far).
  // Insert 220 more — total should land at 200 after trim.
  const big = Array.from({ length: 220 }, (_, i) => ({
    event: 'PreToolUse',
    payload: { idx: i },
  }));
  await postBatch(big.slice(0, 100), authB, 'agent-b');
  await postBatch(big.slice(100, 200), authB, 'agent-b');
  await postBatch(big.slice(200, 220), authB, 'agent-b');
  const g = await request(app).get('/api/v1/agents/agent-b/activity?limit=200').set(authB);
  // Verify ≤ 200 after trim
  assert.ok(g.body.activity.length <= 200, `expected ≤200, got ${g.body.activity.length}`);
  // Newest entry should be idx=219 (last one posted)
  assert.equal(g.body.activity[0].payload.idx, 219);
});

test('public mirror returns same data without auth', async () => {
  const g = await request(app).get('/api/v1/plexus/public/activity?agent_id=agent-a&limit=10');
  assert.equal(g.statusCode, 200);
  assert.ok(Array.isArray(g.body.activity));
  assert.equal(g.body.agent_id, 'agent-a');
});

test('public mirror without agent_id → 400', async () => {
  const g = await request(app).get('/api/v1/plexus/public/activity');
  assert.equal(g.statusCode, 400);
});

test('public mirror with bad agent_id chars → 400', async () => {
  const g = await request(app).get('/api/v1/plexus/public/activity?agent_id=bad%20name');
  assert.equal(g.statusCode, 400);
});

test('payload is null-safe: entry with no payload → stored + retrieved as null', async () => {
  const r = await postBatch([{ event: 'SessionStart' }]);
  assert.equal(r.statusCode, 200);
  const g = await request(app).get('/api/v1/agents/agent-a/activity?limit=1').set(authA);
  assert.equal(g.body.activity[0].event, 'SessionStart');
  assert.equal(g.body.activity[0].payload, null);
});

test('GET limit=0 → 400 (must be 1-200)', async () => {
  const g = await request(app).get('/api/v1/agents/agent-a/activity?limit=0').set(authA);
  assert.equal(g.statusCode, 400);
});

test('GET limit=300 → 400 (over cap)', async () => {
  const g = await request(app).get('/api/v1/agents/agent-a/activity?limit=300').set(authA);
  assert.equal(g.statusCode, 400);
});

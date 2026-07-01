// Task #223 v1 tests — agent_channel_subscription canonical-authority tier
// per PLAN-PLEXUS-ADMIN-CHANNEL-SUBSCRIPTION + parch #11225 RATIFY.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-agent-chan-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-a,tok-b';
process.env.YAKLOG_DAEMON_BINDINGS = 'agent-a:tok-a,agent-b:tok-b';
process.env.YAKLOG_OPS_API_KEYS = 'ops-secret';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb, getAgentChannels, setAgentChannels, listAuditChannelSubscriptionChanges } = require('../src/db');

const authA = { Authorization: 'Bearer tok-a' };
const authB = { Authorization: 'Bearer tok-b' };
const opsHdr = { Authorization: 'Bearer ops-secret', 'X-Ops-Key-Id': 'admin-agent' };

test.after(() => closeDb());

// ─── DB helper direct tests ─────────────────────────────────────────────

test('setAgentChannels: writes canonical list + returns dedup-sorted', () => {
  const result = setAgentChannels({
    agent_id: 'agent-a',
    channels: ['plexus', 'handoff', 'plexus', 'agents'],  // dupe
    subscribed_by: 'admin-agent',
  });
  assert.deepEqual(result.channels, ['agents', 'handoff', 'plexus']);  // dedup + sort
  assert.equal(result.agent_id, 'agent-a');
  assert.equal(result.subscribed_by, 'admin-agent');
});

test('getAgentChannels: returns previously-set list sorted', () => {
  const channels = getAgentChannels('agent-a');
  assert.deepEqual(channels, ['agents', 'handoff', 'plexus']);
});

test('setAgentChannels: REPLACE semantics — new set overwrites old', () => {
  setAgentChannels({
    agent_id: 'agent-a',
    channels: ['status'],
    subscribed_by: 'admin-agent',
  });
  const channels = getAgentChannels('agent-a');
  assert.deepEqual(channels, ['status']);
});

test('setAgentChannels: empty list → agent has no rows (no-filter semantics)', () => {
  setAgentChannels({
    agent_id: 'agent-a',
    channels: [],
    subscribed_by: 'admin-agent',
  });
  const channels = getAgentChannels('agent-a');
  assert.deepEqual(channels, []);
});

test('setAgentChannels: invalid channel name → throws', () => {
  assert.throws(() => setAgentChannels({
    agent_id: 'agent-a',
    channels: ['valid', '!!!bad_chars$$$'],
    subscribed_by: 'admin-agent',
  }), /invalid channel names/);
});

test('setAgentChannels: audit-emission via CP12.15 helper (subscribe deltas)', () => {
  const beforeCount = listAuditChannelSubscriptionChanges({ agent_id: 'agent-b' }).length;
  setAgentChannels({
    agent_id: 'agent-b',
    channels: ['handoff', 'plexus'],
    subscribed_by: 'admin-agent',
  });
  const rows = listAuditChannelSubscriptionChanges({ agent_id: 'agent-b' });
  assert.equal(rows.length, beforeCount + 2);
  // Both are subscribes (fresh agent)
  assert.ok(rows.every(r => r.change_type === 'subscribe' || r.change_type === 'unsubscribe'));
  assert.ok(rows.some(r => r.channel_name === 'handoff' && r.actor === 'admin-agent'));
});

test('setAgentChannels: audit-emission on unsubscribe delta', () => {
  const before = listAuditChannelSubscriptionChanges({ agent_id: 'agent-b' }).length;
  setAgentChannels({
    agent_id: 'agent-b',
    channels: ['handoff'],  // dropping plexus
    subscribed_by: 'admin-agent',
  });
  const rows = listAuditChannelSubscriptionChanges({ agent_id: 'agent-b' });
  const newRows = rows.slice(0, rows.length - before);
  const unsubs = newRows.filter(r => r.change_type === 'unsubscribe');
  assert.ok(unsubs.some(r => r.channel_name === 'plexus'));
});

// ─── Endpoint tests ─────────────────────────────────────────────────────

test('POST /register/:id/channels — ops-key required (bearer non-ops rejected)', async () => {
  const res = await request(app)
    .post('/api/v1/register/agent-a/channels')
    .set(authA)
    .send({ channels: ['plexus'] });
  // enforceOpsKey returns 403 when non-ops bearer used (authenticated but not authorized)
  assert.ok(res.statusCode === 401 || res.statusCode === 403, `expected 401/403 got ${res.statusCode}`);
});

test('POST /register/:id/channels — invalid agent_id → 400', async () => {
  const res = await request(app)
    .post('/api/v1/register/!!!bad$$$/channels')
    .set(opsHdr)
    .send({ channels: ['plexus'] });
  assert.equal(res.statusCode, 400);
});

test('POST /register/:id/channels — non-array body.channels → 400', async () => {
  const res = await request(app)
    .post('/api/v1/register/agent-a/channels')
    .set(opsHdr)
    .send({ channels: 'plexus' });
  assert.equal(res.statusCode, 400);
});

test('POST /register/:id/channels — ops-key sets canonical list', async () => {
  const res = await request(app)
    .post('/api/v1/register/agent-a/channels')
    .set(opsHdr)
    .send({ channels: ['handoff', 'plexus'] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.channels, ['handoff', 'plexus']);
  assert.equal(res.body.subscribed_by, 'admin-agent');
});

test('POST /register/:id/channels — invalid channel name → 400 (format validation)', async () => {
  const res = await request(app)
    .post('/api/v1/register/agent-a/channels')
    .set(opsHdr)
    .send({ channels: ['ok', '!!!bad$$$'] });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /invalid channel names/);
});

test('GET /register/:id/channels — bearer bound to agent reads self', async () => {
  await request(app)
    .post('/api/v1/register/agent-a/channels')
    .set(opsHdr)
    .send({ channels: ['handoff'] });
  const res = await request(app)
    .get('/api/v1/register/agent-a/channels')
    .set(authA);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.agent_id, 'agent-a');
  assert.deepEqual(res.body.channels, ['handoff']);
});

test('GET /register/:id/channels — bearer bound to DIFFERENT agent → 403', async () => {
  const res = await request(app)
    .get('/api/v1/register/agent-a/channels')
    .set(authB);
  assert.equal(res.statusCode, 403);
});

test('GET /register/:id/channels — ops-key can cross-read any agent', async () => {
  const res = await request(app)
    .get('/api/v1/register/agent-a/channels')
    .set(opsHdr);
  assert.equal(res.statusCode, 200);
});

test('GET /register/:id/channels — no auth → 401', async () => {
  const res = await request(app).get('/api/v1/register/agent-a/channels');
  assert.equal(res.statusCode, 401);
});

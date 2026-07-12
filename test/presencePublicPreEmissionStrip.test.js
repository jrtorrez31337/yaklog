// Task #294 (secops #12846/#12850): pre_emission augment rows must NOT appear
// on the /api/v1/presence/public read-path (customer-facing trust boundary).
//
// Design intent per origin commit a6761bb (Ptah CP14.1 staging 2026-06-19):
// pre_emission augment was OPS-tier visibility for "provisioned but no
// heartbeat yet" agents. Customer-facing use of /presence/public came later.
// Because augmented rows have null timestamps, passive age-out cannot remove
// them → permanent DOWN cards on the public dashboard until manual token-
// binding cleanup. Per secops #12850: filter at the public boundary.
//
// Ops teams needing the affordance use the AUTHED /api/v1/presence endpoint
// (routes.js), which does not run the augment.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-task294-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-emitter,tok-lurker';
// Two token-bound agents: one will emit presence, the other won't → triggers
// the pre_emission augment path.
process.env.YAKLOG_DAEMON_BINDINGS = 'agent-emitter:tok-emitter,agent-lurker:tok-lurker';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

test.after(() => closeDb());

test('agent-emitter emits presence; agent-lurker triggers pre_emission augment (baseline)', async () => {
  await request(app).post('/api/v1/presence/event').set({ Authorization: 'Bearer tok-emitter' }).send({
    agent_id: 'agent-emitter', daemon_state: 'up', session_state: 'active',
  });
  // agent-lurker is bound (in TOKEN_BINDINGS / DAEMON_BINDINGS) but has never
  // emitted, so /presence/public will synthesize a pre_emission row for it.
});

test('/presence/public strips pre_emission rows (Task #294)', async () => {
  const res = await request(app).get('/api/v1/presence/public');
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.presence), 'response has presence array');

  const ids = res.body.presence.map((r) => r.agent_id);
  assert.ok(ids.includes('agent-emitter'), 'real emitter should be in public read');
  assert.ok(!ids.includes('agent-lurker'),
    `pre_emission agent-lurker leaked to /presence/public — got ids: ${JSON.stringify(ids)}`);

  // No response row should carry pre_emission: true
  const leaked = res.body.presence.filter((r) => r.pre_emission === true);
  assert.equal(leaked.length, 0,
    `${leaked.length} rows with pre_emission=true leaked: ${JSON.stringify(leaked.map((r) => r.agent_id))}`);
});

test('/presence/public count matches customer-facing filtered set (no ghost rows)', async () => {
  const res = await request(app).get('/api/v1/presence/public');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, res.body.presence.length,
    'body.count must match presence.length (both post-pre_emission-strip)');
});

test('user filter[status] still works after boundary strip', async () => {
  const res = await request(app).get('/api/v1/presence/public?filter[status]=active');
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.presence));
  // At least agent-emitter (active session_state) should be present
  const ids = res.body.presence.map((r) => r.agent_id);
  assert.ok(ids.includes('agent-emitter'));
  // _filter metadata surface still emits when user filter applied
  assert.ok(res.body._filter && res.body._filter.applied === true);
  // Boundary strip is baseline; _filter.total_pre_filter should exclude
  // pre_emission rows already
  assert.ok(res.body._filter.total_pre_filter >= 1);
});

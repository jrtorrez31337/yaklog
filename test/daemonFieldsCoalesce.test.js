// v0.5.16.1 substrate-fix: daemon_pid + daemon_version + daemon_started_at
// switched from raw-assign to COALESCE so non-canonical-daemon runtimes
// (e.g. Ptah self-emit from Windows VM) that send these fields only on
// initial emit don't have the value wiped by subsequent minimal heartbeats.
// Sister-shape to v0.5.9.1 runtime_state COALESCE test pattern.
// Per s345-aieng #10246 + yaklog-dev #10250 empirical substrate-finding.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-daemon-fields-test-'));
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

test('Initial emit with daemon_version+pid+started_at stores all three', async () => {
  const r = await heartbeat({
    daemon_pid: 12345,
    daemon_version: 'ptah-runtime/0.1.0',
    daemon_started_at: '2026-06-21T22:50:00Z',
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.presence.daemon_pid, 12345);
  assert.equal(r.body.presence.daemon_version, 'ptah-runtime/0.1.0');
  assert.equal(r.body.presence.daemon_started_at, '2026-06-21T22:50:00Z');
});

test('Subsequent heartbeat without daemon fields preserves prior values (COALESCE)', async () => {
  // Sister-shape to v0.5.9.1 runtime_state daemon-clobber test. The bug fixed
  // here: non-canonical-daemon runtime sends daemon_version once on initial
  // emit; later heartbeats omit it → routes.js coerces undefined → null →
  // without COALESCE the heartbeat would wipe what was just populated.
  await heartbeat({
    daemon_pid: 67890,
    daemon_version: 'ptah-runtime/0.1.0',
    daemon_started_at: '2026-06-21T22:51:00Z',
  });
  // Minimal heartbeat with no daemon fields (typical post-initial-emit shape)
  const r = await heartbeat({});
  assert.equal(r.body.presence.daemon_pid, 67890, 'daemon_pid preserved across heartbeat');
  assert.equal(r.body.presence.daemon_version, 'ptah-runtime/0.1.0', 'daemon_version preserved across heartbeat');
  assert.equal(r.body.presence.daemon_started_at, '2026-06-21T22:51:00Z', 'daemon_started_at preserved across heartbeat');
});

test('Daemon restart with new pid/started_at: new non-null values win COALESCE', async () => {
  // Functional-equivalence test for canonical yaklog-sub case: daemon restart
  // sends new pid + new started_at; non-null new values must propagate
  // (COALESCE returns excluded.* when excluded.* is non-null).
  await heartbeat({
    daemon_pid: 11111,
    daemon_version: '0.5.16',
    daemon_started_at: '2026-06-21T22:55:00Z',
  });
  // Simulated daemon restart: new pid + new started_at, same version
  const r = await heartbeat({
    daemon_pid: 22222,
    daemon_version: '0.5.16',
    daemon_started_at: '2026-06-21T23:00:00Z',
  });
  assert.equal(r.body.presence.daemon_pid, 22222, 'new daemon_pid wins COALESCE on restart');
  assert.equal(r.body.presence.daemon_started_at, '2026-06-21T23:00:00Z', 'new daemon_started_at wins COALESCE on restart');
});

test('Daemon version upgrade: new version propagates via COALESCE', async () => {
  // Canonical yaklog-sub upgrade case: daemon_version changes between
  // restarts; non-null new value must win COALESCE.
  await heartbeat({
    daemon_pid: 33333,
    daemon_version: '0.5.16',
    daemon_started_at: '2026-06-21T23:05:00Z',
  });
  const r = await heartbeat({
    daemon_pid: 33334,
    daemon_version: '0.5.17',
    daemon_started_at: '2026-06-21T23:06:00Z',
  });
  assert.equal(r.body.presence.daemon_version, '0.5.17', 'new daemon_version wins COALESCE on upgrade');
});

test('Partial heartbeat (only pid populated, version+started_at omitted) preserves prior version+started_at', async () => {
  // Mixed-shape heartbeat: runtime emits pid but skips version + started_at
  // on subsequent calls. COALESCE must preserve each field independently.
  await heartbeat({
    daemon_pid: 44444,
    daemon_version: 'ptah-runtime/0.2.0',
    daemon_started_at: '2026-06-21T23:10:00Z',
  });
  const r = await heartbeat({
    daemon_pid: 44445,
    // version + started_at omitted
  });
  assert.equal(r.body.presence.daemon_pid, 44445, 'updated pid propagates');
  assert.equal(r.body.presence.daemon_version, 'ptah-runtime/0.2.0', 'prior version preserved via COALESCE');
  assert.equal(r.body.presence.daemon_started_at, '2026-06-21T23:10:00Z', 'prior started_at preserved via COALESCE');
});

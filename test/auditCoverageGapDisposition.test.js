// CP12.9: coverage-gap endpoint disposition enrichment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp129-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb, upsertPresence } = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function seedPresence(agent_id, daemon_state, ageDays) {
  // upsertPresence overrides last_heartbeat_at with server-side now; for
  // disposition tests we need a stale heartbeat, so write directly via DB
  // after the upsert lands the row.
  upsertPresence({
    agent_id,
    daemon_state,
    session_state: 'unknown',
    sse_connected: true,
  });
  const heartbeat = new Date(Date.now() - ageDays * 86400_000).toISOString();
  const Database = require('better-sqlite3');
  const db = new Database(process.env.YAKLOG_DB_PATH);
  db.prepare('UPDATE presence SET last_heartbeat_at = ? WHERE agent_id = ?').run(heartbeat, agent_id);
  db.close();
}

test('coverage-gap classifies known alias correctly', async () => {
  seedPresence('gamedev-godot-apple-agent', 'down', 16);
  const r = await request(app).get('/api/v1/yaklog/public/audit/coverage-gap');
  assert.equal(r.status, 200);
  const entry = r.body.missing_dispositions.find(d => d.agent_id === 'gamedev-godot-apple-agent');
  assert.ok(entry, 'expected entry for gamedev-godot-apple-agent');
  assert.equal(entry.disposition, 'alias_of');
  assert.equal(entry.detail, 'macdev-godot-agent');
});

test('coverage-gap classifies known different-runtime agents', async () => {
  seedPresence('gemini-agent', 'up', 0);
  seedPresence('aieng3-agent', 'down', 12);
  const r = await request(app).get('/api/v1/yaklog/public/audit/coverage-gap');
  const gemini = r.body.missing_dispositions.find(d => d.agent_id === 'gemini-agent');
  const aieng3 = r.body.missing_dispositions.find(d => d.agent_id === 'aieng3-agent');
  assert.equal(gemini.disposition, 'different_runtime');
  assert.equal(gemini.detail, 'gemini-cli');
  assert.equal(aieng3.disposition, 'different_runtime');
  assert.equal(aieng3.detail, 'codex');
});

test('coverage-gap classifies daemon-down agent as inactive', async () => {
  seedPresence('test-inactive-agent', 'down', 1);
  const r = await request(app).get('/api/v1/yaklog/public/audit/coverage-gap');
  const entry = r.body.missing_dispositions.find(d => d.agent_id === 'test-inactive-agent');
  assert.equal(entry.disposition, 'inactive');
  assert.match(entry.detail, /daemon down/);
});

test('coverage-gap classifies stale heartbeat (>7d) as inactive', async () => {
  seedPresence('test-stale-agent', 'up', 10);
  const r = await request(app).get('/api/v1/yaklog/public/audit/coverage-gap');
  const entry = r.body.missing_dispositions.find(d => d.agent_id === 'test-stale-agent');
  assert.equal(entry.disposition, 'inactive');
  assert.match(entry.detail, /heartbeat.*old/);
});

test('coverage-gap classifies active-no-audit as genuine_gap', async () => {
  seedPresence('test-genuine-gap-agent', 'up', 0);
  const r = await request(app).get('/api/v1/yaklog/public/audit/coverage-gap');
  const entry = r.body.missing_dispositions.find(d => d.agent_id === 'test-genuine-gap-agent');
  assert.equal(entry.disposition, 'genuine_gap');
});

test('coverage-gap counts categories correctly', async () => {
  // After all prior seeds (in same test DB), the counts include:
  // - 1 alias (gamedev-godot-apple-agent)
  // - 2 different_runtime (gemini-agent + aieng3-agent)
  // - 2 inactive (test-inactive-agent + test-stale-agent)
  // - 1 genuine_gap (test-genuine-gap-agent)
  const r = await request(app).get('/api/v1/yaklog/public/audit/coverage-gap');
  assert.ok(r.body.agents_missing_trail_7d >= 6);
  assert.ok(r.body.alias_count >= 1);
  assert.ok(r.body.different_runtime_count >= 2);
  assert.ok(r.body.inactive_count >= 2);
  assert.ok(r.body.genuine_gap_count >= 1);
});

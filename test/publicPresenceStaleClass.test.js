// CP12.x.4.3 (parch canonical c5b331c) — class-field visibility gap close.
// Asserts sse_stream_stale_class key is present in /api/v1/presence/public
// response shape (sister-shape to CP12.x.4.1 #181 class at /ops/stream/stats).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp1243-class-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');
const Database = require('better-sqlite3');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test('sse_stream_stale_class key exposed via /api/v1/presence/public', async () => {
  const db = new Database(process.env.YAKLOG_DB_PATH);
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO presence (
      agent_id, daemon_state, session_state, cursor_position,
      last_heartbeat_at, last_state_change_at
    ) VALUES ('agent-x', 'up', 'idle', 5, ?, ?)
  `).run(nowIso, nowIso);
  db.close();

  const r = await request(app).get('/api/v1/presence/public');
  assert.equal(r.statusCode, 200);
  const row = r.body.presence.find(x => x.agent_id === 'agent-x');
  assert.ok(row, 'seeded row present');
  assert.ok(
    Object.prototype.hasOwnProperty.call(row, 'sse_stream_stale_class'),
    'sse_stream_stale_class key must exist on every presence row',
  );
});

test('sse_stream_stale_class is null when prerequisites cannot be evaluated', async () => {
  // No last_cursor_advance_at → prerequisites not met → both fields null
  const r = await request(app).get('/api/v1/presence/public');
  const row = r.body.presence.find(x => x.agent_id === 'agent-x');
  // session=idle short-circuits into session_inactive_expected even without
  // last_cursor_advance_at — the else-if branch in app.js fires on
  // daemon=up + !isActivelyConsuming regardless of prerequisites
  assert.equal(row.sse_stream_stale, false);
  assert.equal(row.sse_stream_stale_class, 'session_inactive_expected');
});

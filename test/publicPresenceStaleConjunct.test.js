// CP12.x.4.3 (parch canonical c5b331c) — session-state-aware stale predicate.
// Seeds 4 presence rows with stale conditions met, each with a different
// session_state, and asserts the conjunct refinement excludes
// session_state ∈ {idle, stop_failure, unknown} from sse_stream_stale=true.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp1243-conjunct-'));
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

// Seed: presence rows with stale conjunct conditions met (hb fresh + cursor
// stale + lag ≥ 3) but varying session_state. Also seed bus messages so
// globalHwm > all cursors by ≥ 3. Uses a parallel better-sqlite3 connection
// to the same WAL DB (initializeDb owns the singleton; this side connection
// is read-write for setup only).
function seed() {
  const db = new Database(process.env.YAKLOG_DB_PATH);
  const nowIso = new Date().toISOString();
  const fiveMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();

  // Bump globalHwm to 100 (cursors at 80; lag = 20, ≥ 3)
  for (let i = 1; i <= 100; i++) {
    db.prepare(
      "INSERT INTO messages (id, channel, sender, body, created_at) VALUES (?, 'general', 'seed', 'x', ?)"
    ).run(i, nowIso);
  }

  const seedRow = (agent_id, session_state) => {
    db.prepare(`
      INSERT INTO presence (
        agent_id, daemon_state, session_state, cursor_position,
        last_heartbeat_at, last_cursor_advance_at, last_state_change_at
      ) VALUES (?, 'up', ?, 80, ?, ?, ?)
    `).run(agent_id, session_state, nowIso, fiveMinAgo, nowIso);
  };

  seedRow('agent-active', 'active');
  seedRow('agent-idle', 'idle');
  seedRow('agent-stop-failure', 'stop_failure');
  seedRow('agent-unknown', 'unknown');
  db.close();
}

test('CP12.x.4.3: session=active + stale conditions → stale=true, class=null', async () => {
  seed();
  const r = await request(app).get('/api/v1/presence/public');
  assert.equal(r.statusCode, 200);
  const row = r.body.presence.find(x => x.agent_id === 'agent-active');
  assert.ok(row, 'agent-active row present');
  assert.equal(row.sse_stream_stale, true, 'stale=true for active session');
  assert.equal(row.sse_stream_stale_class, null, 'no class for legacy stale=true');
});

test('CP12.x.4.3: session=idle + stale conditions → stale=false, class=session_inactive_expected', async () => {
  const r = await request(app).get('/api/v1/presence/public');
  const row = r.body.presence.find(x => x.agent_id === 'agent-idle');
  assert.ok(row, 'agent-idle row present');
  assert.equal(row.sse_stream_stale, false, 'stale=false for idle session');
  assert.equal(row.sse_stream_stale_class, 'session_inactive_expected');
});

test('CP12.x.4.3: session=stop_failure + stale conditions → stale=false, class=session_inactive_expected', async () => {
  const r = await request(app).get('/api/v1/presence/public');
  const row = r.body.presence.find(x => x.agent_id === 'agent-stop-failure');
  assert.ok(row, 'agent-stop-failure row present');
  assert.equal(row.sse_stream_stale, false);
  assert.equal(row.sse_stream_stale_class, 'session_inactive_expected');
});

test('CP12.x.4.3: session=unknown + stale conditions → stale=false, class=session_inactive_expected (fail-open per OQ#2)', async () => {
  const r = await request(app).get('/api/v1/presence/public');
  const row = r.body.presence.find(x => x.agent_id === 'agent-unknown');
  assert.ok(row, 'agent-unknown row present');
  assert.equal(row.sse_stream_stale, false, 'unknown excluded per parch OQ#2 disposition');
  assert.equal(row.sse_stream_stale_class, 'session_inactive_expected');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-busfeed-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-pub,tok-bound';
process.env.YAKLOG_TOKEN_BINDINGS = 'sender-a:tok-bound';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

const authBound = { Authorization: 'Bearer tok-bound' };

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

async function seed() {
  // public message
  await request(app).post('/api/v1/messages').set(authBound).send({
    channel: 'handoff', sender: 'sender-a', body: 'public broadcast hello',
  });
  // private DM
  await request(app).post('/api/v1/messages').set(authBound).send({
    channel: 'handoff', sender: 'sender-a', body: 'secret for @sender-a', private: true,
  });
  // another public on a different channel
  await request(app).post('/api/v1/messages').set(authBound).send({
    channel: 'status', sender: 'sender-a', body: 'status update',
  });
}

test('GET /api/v1/plexus/public/messages — returns public messages only (no auth)', async () => {
  await seed();
  const res = await request(app).get('/api/v1/plexus/public/messages');
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.messages));
  // Should have the 2 public messages; the private one must be filtered out.
  const privates = res.body.messages.filter((m) => m.private);
  assert.equal(privates.length, 0, 'public mirror must NEVER expose private messages');
  const publics = res.body.messages.filter((m) => !m.private);
  assert.ok(publics.length >= 2);
});

test('GET /api/v1/plexus/public/messages — channel filter works', async () => {
  const res = await request(app).get('/api/v1/plexus/public/messages?channel=status');
  assert.equal(res.statusCode, 200);
  for (const m of res.body.messages) {
    assert.equal(m.channel, 'status');
    assert.equal(m.private, false);
  }
});

test('GET /api/v1/plexus/public/messages — limit cap of 200 (clamped silently)', async () => {
  const res = await request(app).get('/api/v1/plexus/public/messages?limit=500');
  assert.equal(res.statusCode, 200);
  // Cap silently — accepting 500 by clamping is more user-friendly than 400ing here.
  assert.ok(res.body.messages.length <= 200);
});

test('GET /api/v1/plexus/public/messages — invalid channel → 400', async () => {
  const res = await request(app).get('/api/v1/plexus/public/messages?channel=BAD%20CHARS');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'ValidationError');
});

// Task #264 Phase 2.6 (Jon-direct 2026-07-03): dashboard-tier Bus tab
// time-navigation. before_ts_ms / after_ts_ms accept millisecond-epoch
// integers, converted server-side to ISO-8601 for lexicographic compare
// against created_at TEXT column.
test('GET /api/v1/plexus/public/messages — before_ts_ms=future returns all messages', async () => {
  // created_at is second-precision (SQLite datetime('now')). Test uses a
  // well-future cursor + a well-past cursor to sidestep same-second ties
  // that same-batch-seeded messages naturally have — the cursor's job is
  // time-window slicing, not per-record tie-breaking (that's before_id).
  const all = await request(app).get('/api/v1/plexus/public/messages?limit=50');
  const futureMs = Date.now() + 10_000;
  const res = await request(app).get(`/api/v1/plexus/public/messages?limit=50&before_ts_ms=${futureMs}`);
  assert.equal(res.statusCode, 200);
  // All seeded (past) messages should be returned when cursor is well-future.
  assert.ok(res.body.messages.length >= all.body.messages.length);
});

test('GET /api/v1/plexus/public/messages — before_ts_ms=past returns zero messages', async () => {
  // Cursor from before test seeded data (1970-ish) → strict < filter empties.
  const pastMs = 0;
  const res = await request(app).get(`/api/v1/plexus/public/messages?limit=50&before_ts_ms=${pastMs}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.messages.length, 0);
});

test('GET /api/v1/plexus/public/messages — after_ts_ms=past returns all messages', async () => {
  const all = await request(app).get('/api/v1/plexus/public/messages?limit=50');
  const pastMs = 0;
  const res = await request(app).get(`/api/v1/plexus/public/messages?limit=50&after_ts_ms=${pastMs}`);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.messages.length >= all.body.messages.length);
});

test('GET /api/v1/plexus/public/messages — after_ts_ms=future returns zero messages', async () => {
  const futureMs = Date.now() + 10_000;
  const res = await request(app).get(`/api/v1/plexus/public/messages?limit=50&after_ts_ms=${futureMs}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.messages.length, 0);
});

test('GET /api/v1/plexus/public/messages — combined after_ts_ms + before_ts_ms window', async () => {
  const all = await request(app).get('/api/v1/plexus/public/messages?limit=50');
  const nowMs = Date.now();
  // Window: [now - 1h, now + 10s) — captures all seeded (very recent) msgs.
  const oneHourAgo = nowMs - 3600_000;
  const futureCap = nowMs + 10_000;
  const res = await request(app).get(`/api/v1/plexus/public/messages?limit=50&after_ts_ms=${oneHourAgo}&before_ts_ms=${futureCap}`);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.messages.length >= all.body.messages.length);
});

test('GET /api/v1/plexus/public/messages — before_ts_ms invalid → 400', async () => {
  const res = await request(app).get('/api/v1/plexus/public/messages?before_ts_ms=not-a-number');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'ValidationError');
});

test('GET /api/v1/plexus/public/messages — after_ts_ms invalid → 400', async () => {
  const res = await request(app).get('/api/v1/plexus/public/messages?after_ts_ms=abc');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'ValidationError');
});

// Note: SSE mount at /api/v1/plexus/public/messages-stream is the same
// streamHandler covered by stream.test.js — the public-mirror just removes
// the auth middleware. dmFilter unbound-path applies (per dm.test.js suite).
// Skipping a redundant streaming test here that fights supertest's
// connection-abort handling.

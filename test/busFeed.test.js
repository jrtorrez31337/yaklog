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

// Note: SSE mount at /api/v1/plexus/public/messages-stream is the same
// streamHandler covered by stream.test.js — the public-mirror just removes
// the auth middleware. dmFilter unbound-path applies (per dm.test.js suite).
// Skipping a redundant streaming test here that fights supertest's
// connection-abort handling.

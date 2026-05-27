const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-audit-test-'));
const auditPath = path.join(tempDir, 'dm-audit.ndjson');
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-bound,tok-ops';
process.env.YAKLOG_OPS_API_KEYS = 'tok-ops';
process.env.YAKLOG_TOKEN_BINDINGS = 'alice:tok-bound';
process.env.YAKLOG_DM_AUDIT_LOG_PATH = auditPath;
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

const authBound = { Authorization: 'Bearer tok-bound' };

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

async function seedPrivateMessage(body, mentions = ['bob']) {
  const mentionStr = mentions.map(m => '@' + m).join(' ');
  const res = await request(app).post('/api/v1/messages').set(authBound).send({
    channel: 'handoff', sender: 'alice', body: `${body} ${mentionStr}`, private: true,
  });
  return res.body.message.id;
}

test('GET /dm-audit-log when log file missing → empty entries, exists=false', async () => {
  const res = await request(app).get('/api/v1/plexus/public/dm-audit-log');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.exists, false);
  assert.deepEqual(res.body.entries, []);
});

test('GET /messages/:id on private → returns body + writes audit entry', async () => {
  const id = await seedPrivateMessage('secret payload one');
  const before = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean).length : 0;
  const res = await request(app).get(`/api/v1/plexus/public/messages/${id}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message.private, true);
  assert.match(res.body.message.body, /secret payload one/);
  const after = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean).length;
  assert.equal(after, before + 1, 'audit entry written for private fetch');
  // Verify the audit entry shape
  const lines = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean);
  const lastEntry = JSON.parse(lines[lines.length - 1]);
  assert.equal(lastEntry.via, 'dashboard');
  assert.equal(lastEntry.ops_key_id, 'public-dashboard');
  assert.equal(lastEntry.message_id, id);
});

test('GET /messages/:id on public → body returned, NO audit entry written', async () => {
  const post = await request(app).post('/api/v1/messages').set(authBound).send({
    channel: 'handoff', sender: 'alice', body: 'public announcement',
  });
  const id = post.body.message.id;
  const before = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean).length;
  const res = await request(app).get(`/api/v1/plexus/public/messages/${id}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message.private, false);
  const after = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean).length;
  assert.equal(after, before, 'public fetch must NOT write audit entry');
});

test('GET /messages/:id non-existent → 404', async () => {
  const res = await request(app).get('/api/v1/plexus/public/messages/999999');
  assert.equal(res.statusCode, 404);
});

test('GET /dm-audit-log returns entries newest-first after some private fetches', async () => {
  const id2 = await seedPrivateMessage('secret payload two');
  await request(app).get(`/api/v1/plexus/public/messages/${id2}`);
  await new Promise(r => setTimeout(r, 5));   // ensure distinct timestamps
  const id3 = await seedPrivateMessage('secret payload three', ['carol']);
  await request(app).get(`/api/v1/plexus/public/messages/${id3}`);
  const res = await request(app).get('/api/v1/plexus/public/dm-audit-log');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.exists, true);
  assert.ok(res.body.entries.length >= 2);
  // Newest first
  const t0 = res.body.entries[0].ts;
  const t1 = res.body.entries[1].ts;
  assert.ok(t0 >= t1, 'entries returned newest-first');
});

test('GET /dm-audit-log filter by message_id', async () => {
  const id = await seedPrivateMessage('targeted payload');
  await request(app).get(`/api/v1/plexus/public/messages/${id}`);
  const res = await request(app).get(`/api/v1/plexus/public/dm-audit-log?message_id=${id}`);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.entries.length >= 1);
  for (const e of res.body.entries) {
    assert.equal(e.message_id, id);
  }
});

test('GET /dm-audit-log filter by recipient', async () => {
  const res = await request(app).get('/api/v1/plexus/public/dm-audit-log?recipient=carol');
  assert.equal(res.statusCode, 200);
  for (const e of res.body.entries) {
    assert.ok(e.recipients.includes('carol'));
  }
});

test('GET /dm-audit-log limit clamp', async () => {
  const res = await request(app).get('/api/v1/plexus/public/dm-audit-log?limit=99999');
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.entries.length <= 500);
});

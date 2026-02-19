const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

const authed = { Authorization: 'Bearer test-key' };

test('rejects requests without auth', async () => {
  const res = await request(app).get('/api/v1/messages');
  assert.equal(res.statusCode, 401);
});

test('stores and reads messages in a channel', async () => {
  const create = await request(app)
    .post('/api/v1/messages')
    .set(authed)
    .send({
      channel: 'coordination',
      sender: 'codex',
      body: 'Initial handoff',
      metadata: { ticket: 'ABC-123' }
    });

  assert.equal(create.statusCode, 201);
  assert.equal(create.body.message.channel, 'coordination');

  const list = await request(app)
    .get('/api/v1/messages?channel=coordination&limit=10')
    .set(authed);

  assert.equal(list.statusCode, 200);
  assert.equal(list.body.count, 1);
  assert.equal(list.body.messages[0].sender, 'codex');
  assert.equal(list.body.messages[0].metadata.ticket, 'ABC-123');
});

test('renders context as plain text', async () => {
  await request(app)
    .post('/api/v1/messages')
    .set(authed)
    .send({
      channel: 'prompt-sync',
      sender: 'claude',
      body: 'Need latest deployment status.'
    });

  const context = await request(app)
    .get('/api/v1/context?channel=prompt-sync&limit=10')
    .set(authed);

  assert.equal(context.statusCode, 200);
  assert.match(context.text, /channel=prompt-sync/);
  assert.match(context.text, /sender=claude/);
  assert.match(context.text, /Need latest deployment status\./);
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

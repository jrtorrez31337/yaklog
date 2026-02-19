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

test('updates a message body and metadata', async () => {
  const create = await request(app)
    .post('/api/v1/messages')
    .set(authed)
    .send({ channel: 'updates', sender: 'agent', body: 'original', metadata: { v: 1 } });

  const id = create.body.message.id;

  const patch = await request(app)
    .patch(`/api/v1/messages/${id}`)
    .set(authed)
    .send({ body: 'revised', metadata: { v: 2 } });

  assert.equal(patch.statusCode, 200);
  assert.equal(patch.body.message.body, 'revised');
  assert.equal(patch.body.message.metadata.v, 2);
  assert.ok(patch.body.message.updated_at);
});

test('updates only body (partial update)', async () => {
  const create = await request(app)
    .post('/api/v1/messages')
    .set(authed)
    .send({ channel: 'updates', sender: 'agent', body: 'before', metadata: { keep: true } });

  const id = create.body.message.id;

  const patch = await request(app)
    .patch(`/api/v1/messages/${id}`)
    .set(authed)
    .send({ body: 'after' });

  assert.equal(patch.statusCode, 200);
  assert.equal(patch.body.message.body, 'after');
  assert.equal(patch.body.message.metadata.keep, true);
});

test('update nonexistent message returns 404', async () => {
  const res = await request(app)
    .patch('/api/v1/messages/999999')
    .set(authed)
    .send({ body: 'nope' });

  assert.equal(res.statusCode, 404);
});

test('deletes a message', async () => {
  const create = await request(app)
    .post('/api/v1/messages')
    .set(authed)
    .send({ channel: 'deletes', sender: 'agent', body: 'ephemeral' });

  const id = create.body.message.id;

  const del = await request(app)
    .delete(`/api/v1/messages/${id}`)
    .set(authed);

  assert.equal(del.statusCode, 204);

  const list = await request(app)
    .get(`/api/v1/messages?channel=deletes`)
    .set(authed);

  const ids = list.body.messages.map(m => m.id);
  assert.ok(!ids.includes(id));
});

test('delete nonexistent message returns 404', async () => {
  const res = await request(app)
    .delete('/api/v1/messages/999999')
    .set(authed);

  assert.equal(res.statusCode, 404);
});

test('posts a message with body > 8000 chars', async () => {
  const largeBody = 'x'.repeat(10000);
  const res = await request(app)
    .post('/api/v1/messages')
    .set(authed)
    .send({ channel: 'large', sender: 'agent', body: largeBody });

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.message.body.length, 10000);
});

test.after(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

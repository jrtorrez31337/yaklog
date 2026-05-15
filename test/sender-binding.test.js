const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-binding-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'token-a,token-b,token-unbound';
process.env.YAKLOG_TOKEN_BINDINGS = 'agent-a:token-a,agent-b:token-b';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

const authA = { Authorization: 'Bearer token-a' };
const authB = { Authorization: 'Bearer token-b' };
const authUnbound = { Authorization: 'Bearer token-unbound' };

test.after(() => {
  closeDb();
});

// ----- POST tests -----

test('POST: bound token posting as its bound agent_id succeeds', async () => {
  const res = await request(app)
    .post('/api/v1/messages')
    .set(authA)
    .send({ channel: 'bind-test', sender: 'agent-a', body: 'self-post' });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.message.sender, 'agent-a');
});

test('POST: bound token posting as a different sender is rejected 403', async () => {
  const res = await request(app)
    .post('/api/v1/messages')
    .set(authA)
    .send({ channel: 'bind-test', sender: 'agent-b', body: 'spoof attempt' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'SenderBindingViolation');
});

test('POST: unbound token can post as any sender (legacy behavior)', async () => {
  const res = await request(app)
    .post('/api/v1/messages')
    .set(authUnbound)
    .send({ channel: 'bind-test', sender: 'arbitrary-sender', body: 'legacy post' });
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.message.sender, 'arbitrary-sender');
});

// ----- PATCH tests -----

test('PATCH: bound token editing its own message succeeds', async () => {
  const create = await request(app)
    .post('/api/v1/messages')
    .set(authA)
    .send({ channel: 'bind-test', sender: 'agent-a', body: 'original' });
  const id = create.body.message.id;

  const patch = await request(app)
    .patch(`/api/v1/messages/${id}`)
    .set(authA)
    .send({ body: 'edited' });
  assert.equal(patch.statusCode, 200);
  assert.equal(patch.body.message.body, 'edited');
});

test('PATCH: bound token editing another agent\'s message is rejected 403', async () => {
  const create = await request(app)
    .post('/api/v1/messages')
    .set(authA)
    .send({ channel: 'bind-test', sender: 'agent-a', body: 'agent-a wrote this' });
  const id = create.body.message.id;

  const patch = await request(app)
    .patch(`/api/v1/messages/${id}`)
    .set(authB)
    .send({ body: 'agent-b trying to rewrite' });
  assert.equal(patch.statusCode, 403);
  assert.equal(patch.body.error, 'SenderBindingViolation');
});

test('PATCH: unbound token can edit any message (legacy behavior)', async () => {
  const create = await request(app)
    .post('/api/v1/messages')
    .set(authA)
    .send({ channel: 'bind-test', sender: 'agent-a', body: 'agent-a wrote this' });
  const id = create.body.message.id;

  const patch = await request(app)
    .patch(`/api/v1/messages/${id}`)
    .set(authUnbound)
    .send({ body: 'unbound legacy edit' });
  assert.equal(patch.statusCode, 200);
});

// ----- DELETE tests -----

test('DELETE: bound token deleting its own message succeeds', async () => {
  const create = await request(app)
    .post('/api/v1/messages')
    .set(authA)
    .send({ channel: 'bind-test', sender: 'agent-a', body: 'to be deleted by self' });
  const id = create.body.message.id;

  const del = await request(app)
    .delete(`/api/v1/messages/${id}`)
    .set(authA);
  assert.equal(del.statusCode, 204);
});

test('DELETE: bound token deleting another agent\'s message is rejected 403', async () => {
  const create = await request(app)
    .post('/api/v1/messages')
    .set(authA)
    .send({ channel: 'bind-test', sender: 'agent-a', body: 'agent-a wrote this' });
  const id = create.body.message.id;

  const del = await request(app)
    .delete(`/api/v1/messages/${id}`)
    .set(authB);
  assert.equal(del.statusCode, 403);
  assert.equal(del.body.error, 'SenderBindingViolation');

  // confirm message still exists
  const list = await request(app).get('/api/v1/messages?channel=bind-test&limit=200').set(authA);
  assert.ok(list.body.messages.some((m) => m.id === id), 'message should not be deleted');
});

test('DELETE: unbound token can delete any message (legacy behavior)', async () => {
  const create = await request(app)
    .post('/api/v1/messages')
    .set(authA)
    .send({ channel: 'bind-test', sender: 'agent-a', body: 'to be deleted by unbound' });
  const id = create.body.message.id;

  const del = await request(app)
    .delete(`/api/v1/messages/${id}`)
    .set(authUnbound);
  assert.equal(del.statusCode, 204);
});

// ----- Information-leakage gate -----

test('403 SenderBindingViolation body does not leak any agent_id', async () => {
  const res = await request(app)
    .post('/api/v1/messages')
    .set(authA)
    .send({ channel: 'bind-test', sender: 'agent-b', body: 'spoof attempt' });
  assert.equal(res.statusCode, 403);
  const serialized = JSON.stringify(res.body);
  assert.ok(!serialized.includes('agent-a'), 'response must not leak bound agent_id');
  assert.ok(!serialized.includes('agent-b'), 'response must not leak claimed sender');
});

// ----- PATCH/DELETE on non-existent message -----

test('PATCH on non-existent message returns 404 regardless of binding', async () => {
  const res = await request(app)
    .patch('/api/v1/messages/999999999')
    .set(authA)
    .send({ body: 'edit nothing' });
  assert.equal(res.statusCode, 404);
});

test('DELETE on non-existent message returns 404 regardless of binding', async () => {
  const res = await request(app)
    .delete('/api/v1/messages/999999999')
    .set(authA);
  assert.equal(res.statusCode, 404);
});

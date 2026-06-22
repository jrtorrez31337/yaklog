// ADR-0026 v2 Phase A: messages-tombstone canon tests per parch #10375
// Jon-direct + yaklog-dev #10385 substrate-design.
// Sister-shape canon to audit-tombstone (CP12.12.1) at message-tier.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-msg-tombstone-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'agent-token';
process.env.YAKLOG_TOKEN_BINDINGS = 'agent-a:agent-token';
process.env.YAKLOG_OPS_API_KEYS = 'ops-key-secret';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

const auditOpsRoutes = require('../src/auditOpsRoutes');
const { closeDb, insertMessage, getDb } = require('../src/db');

const app = express();
app.use(express.json());
app.use('/api/v1/ops', auditOpsRoutes);

const opsAuth = { Authorization: 'Bearer ops-key-secret' };

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function seedMessage(opts = {}) {
  return insertMessage({
    channel: opts.channel || 'public',
    sender: opts.sender || 'agent-a',
    body: opts.body || 'test body content',
    metadata: opts.metadata,
    isPrivate: opts.isPrivate || false,
  });
}

test('POST /messages/:id/tombstone: missing Bearer → 401', async () => {
  const seeded = seedMessage();
  const r = await request(app)
    .post(`/api/v1/ops/messages/${seeded.id}/tombstone`)
    .send({ reason: 'test' });
  assert.equal(r.statusCode, 401);
});

test('POST /messages/:id/tombstone: invalid id (non-int) → 400', async () => {
  const r = await request(app)
    .post('/api/v1/ops/messages/abc/tombstone')
    .set(opsAuth)
    .send({ reason: 'test' });
  assert.equal(r.statusCode, 400);
});

test('POST /messages/:id/tombstone: missing reason → 400', async () => {
  const seeded = seedMessage();
  const r = await request(app)
    .post(`/api/v1/ops/messages/${seeded.id}/tombstone`)
    .set(opsAuth)
    .send({});
  assert.equal(r.statusCode, 400);
  assert.match(r.body.message || '', /reason required/);
});

test('POST /messages/:id/tombstone: nonexistent id → 404', async () => {
  const r = await request(app)
    .post('/api/v1/ops/messages/999999/tombstone')
    .set(opsAuth)
    .send({ reason: 'test' });
  assert.equal(r.statusCode, 404);
});

test('POST /messages/:id/tombstone: happy path → 200; body redacted; metadata preserved', async () => {
  const seeded = seedMessage({ sender: 'agent-a', channel: 'handoff', body: 'SECRET_CREDENTIAL=abc123' });
  const r = await request(app)
    .post(`/api/v1/ops/messages/${seeded.id}/tombstone`)
    .set(opsAuth)
    .send({ reason: 'credential-delivery receipt-window close after secops encrypt-to-swarm-secrets' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.message_id, seeded.id);
  assert.equal(r.body.sender, 'agent-a');
  assert.equal(r.body.channel, 'handoff');
  assert.ok(r.body.tombstone_at);

  // Empirical: body redacted; metadata preserved
  const db = getDb();
  const row = db.prepare('SELECT id, channel, sender, body, tombstone_at, tombstone_reason FROM messages WHERE id = ?').get(seeded.id);
  assert.equal(row.body, '[REDACTED]', 'body must be redacted to sentinel');
  assert.equal(row.sender, 'agent-a', 'sender preserved');
  assert.equal(row.channel, 'handoff', 'channel preserved');
  assert.ok(row.tombstone_at, 'tombstone_at populated');
  assert.match(row.tombstone_reason || '', /credential-delivery/);
});

test('POST /messages/:id/tombstone: double-tombstone → 409 IllegalTransition', async () => {
  const seeded = seedMessage();
  const r1 = await request(app)
    .post(`/api/v1/ops/messages/${seeded.id}/tombstone`)
    .set(opsAuth)
    .send({ reason: 'first redact' });
  assert.equal(r1.statusCode, 200);
  const r2 = await request(app)
    .post(`/api/v1/ops/messages/${seeded.id}/tombstone`)
    .set(opsAuth)
    .send({ reason: 'second redact' });
  assert.equal(r2.statusCode, 409);
  assert.match(r2.body.message || '', /already tombstoned/);
});

test('POST /messages/:id/tombstone: meta-audit row inserted at audit_credential_change', async () => {
  const seeded = seedMessage({ body: 'API_KEY=sk-secret' });
  const r = await request(app)
    .post(`/api/v1/ops/messages/${seeded.id}/tombstone`)
    .set(opsAuth)
    .send({ reason: 'NEXUS rotation receipt-window close' });
  assert.equal(r.statusCode, 200);
  const db = getDb();
  const rows = db.prepare(`
    SELECT credential_class, change_type, prior_digest, reason
    FROM audit_credential_change
    WHERE prior_digest = ?
    ORDER BY occurred_at DESC LIMIT 1
  `).all(`msg#${seeded.id}`);
  assert.equal(rows.length, 1, 'meta-audit row should be inserted');
  assert.equal(rows[0].credential_class, 'message-body-tombstone');
  assert.equal(rows[0].change_type, 'revoke');
  assert.match(rows[0].reason || '', /NEXUS rotation/);
});

test('POST /messages/:id/tombstone: private DM body redacted; private flag preserved', async () => {
  const seeded = seedMessage({ isPrivate: true, body: 'NEXUS_S345=new-token-value' });
  const r = await request(app)
    .post(`/api/v1/ops/messages/${seeded.id}/tombstone`)
    .set(opsAuth)
    .send({ reason: 'DM credential-delivery receipt-window close' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.private, true, 'private flag preserved');

  const db = getDb();
  const row = db.prepare('SELECT body, private FROM messages WHERE id = ?').get(seeded.id);
  assert.equal(row.body, '[REDACTED]');
  assert.equal(row.private, 1);
});

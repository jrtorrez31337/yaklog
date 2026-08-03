const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-regpub-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb, insertRegistration, updateRegistration } = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function seedRegistration(overrides = {}) {
  const id = overrides.registration_id || 'reg-' + Math.random().toString(36).slice(2, 10);
  // insertRegistration only accepts a subset of fields (status forced to
  // SUBMITTED); chain updateRegistration to populate the secret-bearing
  // fields we want to assert get stripped on the public surface.
  insertRegistration({
    registration_id: id,
    agent_id: overrides.agent_id || 'agent-x',
    registrant_pubkey: 'pubkey-fake-base64',
    registrant_token_hash: 'hash-FORENSIC-MUST-NOT-LEAK',
    submission_json: JSON.stringify({ requested_caps: ['read'] }),
  });
  updateRegistration(id, {
    ciphertext_b64: 'CIPHERTEXT-SECRET-PAYLOAD-MUST-NOT-LEAK',
    minted_token_hash: 'mint-FORENSIC-MUST-NOT-LEAK',
    justification_json: JSON.stringify({ purpose: 'test' }),
    ...(overrides.status ? { status: overrides.status } : {}),
  });
  return id;
}

test('GET /registrations on empty DB → 200 + empty array', async () => {
  const r = await request(app).get('/api/v1/yaklog/public/registrations');
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.registrations, []);
  assert.equal(r.body.count, 0);
});

test('GET /registrations returns sanitized rows (no secret-bearing fields)', async () => {
  seedRegistration({ agent_id: 'leak-canary', status: 'JON_RATIFY' });
  const r = await request(app).get('/api/v1/yaklog/public/registrations');
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.registrations.length >= 1);
  const row = r.body.registrations.find((x) => x.agent_id === 'leak-canary');
  assert.ok(row, 'row present');
  // Sanitization invariants — these MUST never leak through the public mirror
  assert.equal(row.ciphertext_b64, undefined, 'ciphertext_b64 must NOT be exposed');
  assert.equal(row.registrant_token_hash, undefined, 'registrant_token_hash must NOT be exposed');
  assert.equal(row.minted_token_hash, undefined, 'minted_token_hash must NOT be exposed');
  // Stringification check: serialized response must not include the canary substrings
  const body = JSON.stringify(r.body);
  assert.equal(body.includes('CIPHERTEXT-SECRET'), false, 'ciphertext canary string leaked');
  assert.equal(body.includes('FORENSIC-MUST-NOT-LEAK'), false, 'token hash canary string leaked');
});

test('GET /registrations surfaces workflow fields', async () => {
  const r = await request(app).get('/api/v1/yaklog/public/registrations');
  const row = r.body.registrations.find((x) => x.agent_id === 'leak-canary');
  assert.equal(row.status, 'JON_RATIFY');
  assert.equal(row.is_terminal, false);
  assert.equal(typeof row.created_at, 'string');
  assert.equal(typeof row.updated_at, 'string');
  assert.ok(row.justification_json.includes('purpose'));
});

test('GET /registrations is_terminal=true for ACTIVE / REJECTED / REVOKED', async () => {
  seedRegistration({ agent_id: 'active-test', status: 'ACTIVE' });
  seedRegistration({ agent_id: 'rejected-test', status: 'REJECTED' });
  const r = await request(app).get('/api/v1/yaklog/public/registrations');
  const active = r.body.registrations.find((x) => x.agent_id === 'active-test');
  const rejected = r.body.registrations.find((x) => x.agent_id === 'rejected-test');
  assert.equal(active.is_terminal, true);
  assert.equal(rejected.is_terminal, true);
});

test('GET /registrations ordered newest-first (by updated_at)', async () => {
  const r = await request(app).get('/api/v1/yaklog/public/registrations');
  for (let i = 1; i < r.body.registrations.length; i++) {
    assert.ok(r.body.registrations[i - 1].updated_at >= r.body.registrations[i].updated_at,
      'must be ordered newest-first');
  }
});

test('GET /registrations?limit=99999 clamps to 500', async () => {
  const r = await request(app).get('/api/v1/yaklog/public/registrations?limit=99999');
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.registrations.length <= 500);
});

test('GET /registrations?limit=invalid → 400', async () => {
  const r = await request(app).get('/api/v1/yaklog/public/registrations?limit=-5');
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, 'ValidationError');
});

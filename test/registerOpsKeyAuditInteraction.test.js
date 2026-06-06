// Regression test for the CP12.2 R1 fold ⊕ CP8.5 /register interaction bug
// caught at #7854 + #7862 + #7863 (2026-06-06).
//
// Bug: opsKeyAuditMiddleware (mounted globally before morgan per ADR-0030 v1.1
// R1) rewrites req.headers.authorization to "Bearer sha256:<prefix>" and
// stashes the original on req.rawBearer. The /register endpoints
// (registrantToken middleware + activate extractor + authForCiphertext)
// were reading req.headers.authorization directly, so they saw the MASKED
// value and rejected with 403 "registration_access_token does not match".
//
// Fix: prefer req.rawBearer; fall through to header parsing for tests/
// direct-mount paths. Mirrors src/middleware/auth.js extractToken pattern.
//
// This test runs the full Express middleware chain (opsKeyAudit → /register
// → registrantToken) against a real registration row to prove the round-trip.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-opsmask-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const {
  closeDb,
  insertRegistration,
  updateRegistration,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

// Seed one registration with a known registrant_access_token. Mirror the
// production POST /register code-path's storage shape: registrant_token_hash
// is sha256(registrant_access_token).
function seedRegistration() {
  const registrationId = 'reg-opsmask-' + crypto.randomBytes(4).toString('hex');
  const token = 'opsmask-test-bearer-' + crypto.randomBytes(8).toString('hex');
  insertRegistration({
    registration_id: registrationId,
    agent_id: 'opsmask-test-agent',
    status: 'SUBMITTED',
    registrant_pubkey: 'age1' + 'a'.repeat(58),
    registrant_token_hash: sha256Hex(token),
    justification_json: JSON.stringify({}),
    submission_json: JSON.stringify({ scope: 'opsmask interaction test' }),
  });
  return { registrationId, token };
}

test('GET /register/:id accepts registrant_access_token after opsKeyAudit redaction', async () => {
  const { registrationId, token } = seedRegistration();
  const res = await request(app)
    .get(`/api/v1/register/${registrationId}`)
    .set('Authorization', `Bearer ${token}`);
  // Per pre-fix: req.headers.authorization was rewritten to
  // "Bearer sha256:<prefix>" by opsKeyAudit; registrantToken middleware then
  // computed sha256(masked-value) which never matched the stored hash, so
  // it returned 403 "does not match this registration".
  // Post-fix: registrantToken reads req.rawBearer, sees the original token,
  // computes sha256(original) == stored, returns 200.
  assert.equal(res.status, 200,
    `expected 200; got ${res.status} body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.registration.registration_id, registrationId);
});

test('GET /register/:id/ciphertext accepts registrant_access_token after opsKeyAudit redaction', async () => {
  const { registrationId, token } = seedRegistration();
  // Transition to a ciphertext-available state + populate ciphertext.
  updateRegistration(registrationId, {
    status: 'APPROVED_PENDING_FERRY',
    ciphertext_b64: Buffer.from('fake-ciphertext-for-test', 'utf-8').toString('base64'),
  });
  const res = await request(app)
    .get(`/api/v1/register/${registrationId}/ciphertext`)
    .set('Authorization', `Bearer ${token}`);
  // Pre-fix: 401 "Bearer must be registrant_access_token OR op-key" because
  // authForCiphertext read the masked header value.
  // Post-fix: 200 + ciphertext_b64.
  assert.equal(res.status, 200,
    `expected 200; got ${res.status} body=${JSON.stringify(res.body)}`);
  assert.equal(res.body.registration_id, registrationId);
  assert.ok(typeof res.body.ciphertext_b64 === 'string' && res.body.ciphertext_b64.length > 0);
});

test('GET /register/:id rejects wrong token even after rawBearer stash (no false-positive auth)', async () => {
  // Ensure the fix didn't accidentally make all tokens validate. Submit a
  // request with a token that doesn't match any registration — must return
  // 403 "does not match" (or 401 if the token is empty / malformed).
  const { registrationId } = seedRegistration();
  const wrongToken = 'definitely-not-the-registered-token-' + crypto.randomBytes(8).toString('hex');
  const res = await request(app)
    .get(`/api/v1/register/${registrationId}`)
    .set('Authorization', `Bearer ${wrongToken}`);
  assert.equal(res.status, 403);
  assert.match(res.body.message, /does not match this registration/);
});

test('GET /register/:id rejects missing Authorization header with 401', async () => {
  // Negative: no Authorization header at all should still 401.
  const { registrationId } = seedRegistration();
  const res = await request(app).get(`/api/v1/register/${registrationId}`);
  assert.equal(res.status, 401);
  assert.match(res.body.message, /Bearer.*required/);
});

test('POST /register/:id/activate accepts minted-token after opsKeyAudit redaction', async () => {
  // The /activate handler has its OWN extractBearer (registerRoutes.js line 344).
  // Verify the rawBearer fallback works there too.
  const { registrationId } = seedRegistration();
  // The minted-token activate path requires PENDING_ACTIVATION state +
  // minted_token_hash set. The bearer presented must hash to minted_token_hash.
  const mintedToken = 'minted-bearer-' + crypto.randomBytes(16).toString('hex');
  updateRegistration(registrationId, {
    status: 'PENDING_ACTIVATION',
    minted_token_hash: sha256Hex(mintedToken),
  });
  const res = await request(app)
    .post(`/api/v1/register/${registrationId}/activate`)
    .set('Authorization', `Bearer ${mintedToken}`)
    .send({});
  // Pre-fix: 403 "Bearer does not match minted-token" because extractBearer
  // read the masked header value.
  // Post-fix: state transitions to ACTIVE; returns 200.
  assert.equal(res.status, 200,
    `expected 200 ACTIVE transition; got ${res.status} body=${JSON.stringify(res.body)}`);
});

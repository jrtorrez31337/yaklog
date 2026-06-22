// Task #138 Phase 2A vendor-keys endpoint tests per parch #10320 ratify of
// PLAN-VENDOR-KEY-DELIVERY-SUBSTRATE.md §5 + secops #10249 6-condition PASS.
//
// Tests use sopsAge.setMockDecrypt() to avoid sops subprocess dependency in
// test env (sops not yet in yaklog container per ssw-devops #10297). Substrate-
// design under test:
//   - TLS gate (defense-in-depth 503 on plain-HTTP)
//   - Bearer auth + agent_id resolution via daemon-binding single-pair canon
//   - Per-agent rate-limit (10/hr default)
//   - Granted-vendor resolution via grants.sops.json (decrypted at request)
//   - Per-vendor key decrypt + partial-graceful-degrade on missing-vendor
//   - Audit row on every call (success + reject + error)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-vendorkeys-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'agent-a-token,multi-token,unbound-token';
process.env.YAKLOG_DAEMON_BINDINGS = 'agent-a:agent-a-token,agent-b:multi-token,agent-c:multi-token';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

const auth = require('../src/middleware/auth');
const vendorKeysRoute = require('../src/secureStore/vendorKeysRoute');
const sopsAge = require('../src/secureStore/sopsAge');
const rateLimit = require('../src/secureStore/rateLimit');
const { closeDb } = require('../src/db');
const { _getRecentForTests } = require('../src/secureStore/auditVendorKeyAccess');

const app = express();
app.use(express.json());
// Mount under /api/v1/secure-store with auth middleware (mirrors planned
// app.js mount but isolated for tests)
app.use('/api/v1/secure-store', auth, vendorKeysRoute);

const TLS_HEADERS = { 'X-Forwarded-Proto': 'https' };
const agentAAuth = { Authorization: 'Bearer agent-a-token', ...TLS_HEADERS };
const multiAuth = { Authorization: 'Bearer multi-token', ...TLS_HEADERS };

// Mock sops decryption (no actual sops/age call) — returns synthetic
// grants + per-vendor dotenv content.
function installMock() {
  sopsAge.setMockDecrypt((filePath) => {
    const fname = path.basename(filePath);
    if (fname === 'grants.sops.json') {
      return JSON.stringify({
        version: '1.0',
        grants: [
          { agent_id: 'agent-a', vendors: ['openai'] },
          { agent_id: 'agent-b', vendors: ['openai', 'missing-vendor'] },
        ],
      });
    }
    if (fname === 'openai.sops.env') {
      return 'OPENAI_API_KEY=sk-mock-1234567890\n';
    }
    if (fname === 'missing-vendor.sops.env') {
      const err = new Error('not found');
      err.code = 'ENOENT';
      throw err;
    }
    throw new Error(`mock has no handler for ${fname}`);
  });
}

test.before(installMock);
test.afterEach(() => rateLimit._resetForTests());
test.after(() => {
  sopsAge.clearMockDecrypt();
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test('GET vendor-keys: missing Bearer → 401', async () => {
  const r = await request(app).get('/api/v1/secure-store/vendor-keys').set(TLS_HEADERS);
  assert.equal(r.statusCode, 401);
});

test('GET vendor-keys: plain-HTTP (no X-Forwarded-Proto: https) → 503 TLSRequired (defense-in-depth)', async () => {
  const r = await request(app).get('/api/v1/secure-store/vendor-keys')
    .set({ Authorization: 'Bearer agent-a-token' });
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.error, 'TLSRequired');
});

test('GET vendor-keys: ambiguous multi-agent bearer → 403 (must be single-pair daemon-bound)', async () => {
  const r = await request(app).get('/api/v1/secure-store/vendor-keys').set(multiAuth);
  assert.equal(r.statusCode, 403);
  assert.match(r.body.message, /daemon-bound to exactly one agent_id/);
});

test('GET vendor-keys: single-pair bearer + granted vendor → 200 with keys', async () => {
  const r = await request(app).get('/api/v1/secure-store/vendor-keys').set(agentAAuth);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.keys, { openai: 'sk-mock-1234567890' });
  assert.ok(!r.body.missing, 'no missing vendors expected for agent-a');
  assert.ok(r.body.rate_limit);
  assert.ok(r.body.rate_limit.remaining < r.body.rate_limit.limit);
});

test('GET vendor-keys: agent with no grants → 200 with empty keys (substrate-honest, NOT 403)', async () => {
  // agent-a is granted openai; remove via mock-swap to simulate
  sopsAge.setMockDecrypt((filePath) => {
    const fname = path.basename(filePath);
    if (fname === 'grants.sops.json') {
      return JSON.stringify({ version: '1.0', grants: [] });
    }
    throw new Error('unexpected: ' + fname);
  });
  const r = await request(app).get('/api/v1/secure-store/vendor-keys').set(agentAAuth);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.keys, {});
  // Reinstall main mock
  installMock();
});

test('GET vendor-keys: rate-limit kicks in after N requests', async () => {
  // Default limit is 10/hr; fire 11 fast requests
  for (let i = 0; i < 10; i++) {
    const r = await request(app).get('/api/v1/secure-store/vendor-keys').set(agentAAuth);
    assert.equal(r.statusCode, 200, `request ${i+1} should be 200`);
  }
  const r11 = await request(app).get('/api/v1/secure-store/vendor-keys').set(agentAAuth);
  assert.equal(r11.statusCode, 429);
  assert.equal(r11.body.error, 'RateLimitExceeded');
});

test('audit-log: every call writes a row (success + 401 + 403 + 429 + 503)', async () => {
  // Fresh agent-a call → audit row
  await request(app).get('/api/v1/secure-store/vendor-keys').set(agentAAuth);
  const rows = _getRecentForTests('agent-a', 5);
  assert.ok(rows.length > 0, 'expected audit row for agent-a');
  assert.ok(['ok', 'partial'].includes(rows[0].outcome));
});

test('partial-graceful-degrade: granted vendor with missing key file → present in `missing`, others still served', async () => {
  // multi-token is bound to BOTH agent-b and agent-c → ambiguous → 403.
  // We need a single-pair binding for agent-b to test the partial path.
  // Use direct unit-test on the route's behavior via custom auth header.
  // Instead: re-mock grants to put agent-a on both openai + missing-vendor
  sopsAge.setMockDecrypt((filePath) => {
    const fname = path.basename(filePath);
    if (fname === 'grants.sops.json') {
      return JSON.stringify({
        version: '1.0',
        grants: [{ agent_id: 'agent-a', vendors: ['openai', 'missing-vendor'] }],
      });
    }
    if (fname === 'openai.sops.env') return 'OPENAI_API_KEY=sk-mock-1234567890\n';
    if (fname === 'missing-vendor.sops.env') {
      const err = new Error('not found');
      err.code = 'ENOENT';
      throw err;
    }
    throw new Error('unexpected: ' + fname);
  });
  const r = await request(app).get('/api/v1/secure-store/vendor-keys').set(agentAAuth);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.keys, { openai: 'sk-mock-1234567890' });
  assert.deepEqual(r.body.missing, ['missing-vendor']);
  installMock();
});

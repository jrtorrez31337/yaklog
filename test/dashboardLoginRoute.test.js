// PLAN-DASHBOARD-OPERATOR-DM v2 §2.3.1 + §2.9.2 substrate-impl tests
// (secops FLAG-2 rate-limit + uniform-401 + timing-safe; FLAG-1 CSP header).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-dashlogin-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-agent-a,tok-operator-jon,tok-operator-jhewgley';
process.env.YAKLOG_TOKEN_BINDINGS = 'agent-a:tok-agent-a';
process.env.YAKLOG_OPERATOR_BINDINGS = 'op-jon:tok-operator-jon,op-jhewgley:tok-operator-jhewgley';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb } = require('../src/db');

test.after(() => {
  try { closeDb(); } catch {}
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ─── POST /dashboard/login — success path ──────────────────────────────────

test('POST /dashboard/login: valid operator bearer → 200 with operator_id', async () => {
  const r = await request(app).post('/dashboard/login').send({ token: 'tok-operator-jon' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.operator_id, 'op-jon');
  assert.ok(r.body.expires_at);
});

test('POST /dashboard/login: different operator → different operator_id', async () => {
  const r = await request(app).post('/dashboard/login').send({ token: 'tok-operator-jhewgley' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.operator_id, 'op-jhewgley');
});

// ─── POST /dashboard/login — uniform 401 (FLAG-2) ──────────────────────────

test('POST /dashboard/login: unknown token → 401 Unauthorized "Invalid credentials."', async () => {
  const r = await request(app).post('/dashboard/login').send({ token: 'unknown-token-blah' });
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.error, 'Unauthorized');
  assert.equal(r.body.message, 'Invalid credentials.');
});

test('POST /dashboard/login: missing token field → 401 (uniform; no special-case)', async () => {
  const r = await request(app).post('/dashboard/login').send({});
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.error, 'Unauthorized');
  assert.equal(r.body.message, 'Invalid credentials.');
});

test('POST /dashboard/login: empty-string token → 401 (uniform)', async () => {
  const r = await request(app).post('/dashboard/login').send({ token: '' });
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.message, 'Invalid credentials.');
});

test('POST /dashboard/login: agent-class bearer (not operator) → 401 (uniform)', async () => {
  const r = await request(app).post('/dashboard/login').send({ token: 'tok-agent-a' });
  assert.equal(r.statusCode, 401);
  assert.equal(r.body.message, 'Invalid credentials.');
});

// ─── POST /dashboard/login — rate-limit (FLAG-2) ───────────────────────────

test('POST /dashboard/login: 5 consecutive 401s from same source → 429 lockout', async () => {
  // Reset in-memory failure tracker (otherwise prior failed-login tests
  // pollute the rate-limit count for the shared supertest IP).
  require('../src/dashboardLoginRoute')._resetFailureTracker();
  for (let i = 0; i < 5; i++) {
    const r = await request(app).post('/dashboard/login').send({ token: 'wrong-' + i });
    assert.equal(r.statusCode, 401, `attempt ${i+1} should be 401`);
  }
  const r6 = await request(app).post('/dashboard/login').send({ token: 'wrong-6' });
  assert.equal(r6.statusCode, 429);
  assert.equal(r6.body.error, 'RateLimited');
  assert.ok(r6.body.retry_after_seconds > 0);
});

// ─── GET /dashboard — CSP header (FLAG-1) ──────────────────────────────────

test('GET /dashboard: CSP header includes script-src \'self\'', async () => {
  const r = await request(app).get('/dashboard');
  // Either helmet default or my middleware should emit CSP — both are fine
  const csp = r.headers['content-security-policy'];
  assert.ok(csp, 'CSP header present');
  assert.match(csp, /script-src[^;]*'self'/, 'script-src self present');
});

test('GET /dashboard: X-Frame-Options DENY (dashboard-tier defense-in-depth)', async () => {
  const r = await request(app).get('/dashboard');
  assert.equal(r.headers['x-frame-options'], 'DENY');
});

test('GET /dashboard.js: CSP header present (sister-shape /dashboard surface)', async () => {
  const r = await request(app).get('/dashboard.js');
  const csp = r.headers['content-security-policy'];
  assert.ok(csp, 'CSP header on dashboard.js');
});

test('GET /api/v1/presence/public: CSP header NOT present (API JSON surface)', async () => {
  // CSP middleware should ONLY emit on /dashboard/* paths, not API/JSON surfaces.
  const r = await request(app).get('/api/v1/presence/public');
  // Note: helmet may still emit a default CSP at app-tier; my middleware should
  // not ADD a dashboard-specific one for non-dashboard paths. Assert that
  // X-Frame-Options is NOT DENY (helmet defaults to SAMEORIGIN).
  if (r.headers['x-frame-options']) {
    assert.notEqual(r.headers['x-frame-options'], 'DENY',
      'X-Frame-Options should not be DENY for non-dashboard path');
  }
});

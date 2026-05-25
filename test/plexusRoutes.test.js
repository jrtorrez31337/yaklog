// Plan C Stage 2 CP1 — plexusRoutes proxy tests.
//
// Strategy: stub `fetch` so tests don't need a real Prom. Validate the
// frontend-visible contract: param validation, allowlist enforcement,
// cache behavior, response shape. Round-trip Prom proxying is covered
// by the empirical smoke run against a real Prom (see ad-hoc curl
// section at bottom of plexusRoutes.js / Stage 2 build plan).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-test-plexus-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.YAKLOG_PLEXUS_PROM_URL = 'http://prom-stub.invalid:9090';
process.env.YAKLOG_PLEXUS_QUERY_CACHE_TTL_MS = '60000';
process.env.YAKLOG_PLEXUS_QUERY_TIMEOUT_MS = '500';
process.env.NODE_ENV = 'test';

// Stub global fetch BEFORE loading the app, since plexusRoutes captures
// `fetch` at module-load via the global scope.
const fetchCalls = [];
let nextFetchResponse = null;
global.fetch = async (url, opts) => {
  fetchCalls.push({ url: url.toString(), opts });
  if (nextFetchResponse instanceof Error) throw nextFetchResponse;
  const { status = 200, body = { status: 'success', data: { resultType: 'vector', result: [] } } } = nextFetchResponse || {};
  nextFetchResponse = null;
  return {
    status,
    async text() { return JSON.stringify(body); },
  };
};

const request = require('supertest');
const app = require('../src/app');
const { _internals } = require('../src/plexusRoutes');

const authed = { Authorization: 'Bearer test-key' };

// Per-test cache reset so each test is independent.
test.beforeEach(() => {
  _internals.cache.clear();
  fetchCalls.length = 0;
  nextFetchResponse = null;
});

// ── auth ──────────────────────────────────────────────────────────────

test('plexus routes require Bearer (unauth → 401)', async () => {
  const r = await request(app).get('/api/v1/plexus/templates');
  assert.equal(r.statusCode, 401);
});

test('plexus routes accept valid Bearer', async () => {
  const r = await request(app).get('/api/v1/plexus/templates').set(authed);
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.templates);
});

// ── discovery ─────────────────────────────────────────────────────────

test('/templates lists all registered templates with kind + params', async () => {
  const r = await request(app).get('/api/v1/plexus/templates').set(authed);
  assert.equal(r.statusCode, 200);
  const tmpls = r.body.templates;
  assert.ok(tmpls['tokens.rate.byAgent']);
  assert.equal(tmpls['tokens.rate.byAgent'].kind, 'both');
  assert.equal(tmpls['tokens.rate.byAgent'].params.window.default, '5m');
  assert.ok(Array.isArray(tmpls['cost.cumulative.byDim'].params.dim.allowed));
});

// ── allowlist enforcement ─────────────────────────────────────────────

test('arbitrary PromQL (no template param) → 400', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/query?expr=sum(rate(node_cpu[5m]))')
    .set(authed);
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /missing param: template/);
});

test('unknown template name → 422', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/query?template=not.a.real.template')
    .set(authed);
  assert.equal(r.statusCode, 422);
  assert.match(r.body.error, /unknown template/);
});

test('range-only template via /query → 422', async () => {
  // No range-only templates today; skip if none exist. Synthesize by
  // monkey-patching templates internals for the duration of the test.
  const tmplName = 'test.range_only.synthetic';
  _internals.templates[tmplName] = {
    kind: 'range',
    params: {},
    build: () => 'up',
  };
  try {
    const r = await request(app).get(`/api/v1/plexus/query?template=${tmplName}`).set(authed);
    assert.equal(r.statusCode, 422);
    assert.match(r.body.error, /requires \/query_range/);
  } finally {
    delete _internals.templates[tmplName];
  }
});

test('instant-only template via /query_range → 422', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/query_range?template=agent.identity.byAgentId&agent_id=foo&from=1779000000&to=1779001000&step=15s')
    .set(authed);
  assert.equal(r.statusCode, 422);
  assert.match(r.body.error, /requires \/query \(instant only\)/);
});

// ── param validation ──────────────────────────────────────────────────

test('missing required param → 400', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/query?template=cost.cumulative.byDim')
    .set(authed);
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /missing required param: dim/);
});

test('param not in enum → 400 with allowed list', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/query?template=cost.cumulative.byDim&dim=hostname')
    .set(authed);
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /dim must be one of/);
});

test('agent_id with unsafe chars (PromQL escape attempt) → 400', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/query?template=agent.identity.byAgentId&agent_id=foo"bar')
    .set(authed);
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /not allowed in PromQL label values/);
});

test('agent_id with valid shape passes validation', async () => {
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [] } } };
  const r = await request(app)
    .get('/api/v1/plexus/query?template=agent.identity.byAgentId&agent_id=parch-agent')
    .set(authed);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.template, 'agent.identity.byAgentId');
  assert.equal(r.body.params.agent_id, 'parch-agent');
  assert.match(r.body.query, /plexus_agent_id="parch-agent"/);
});

test('window param outside allowlist → 400 (1y window attack)', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/query?template=tokens.rate.byAgent&window=1y')
    .set(authed);
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /window must be one of/);
});

test('window param default applied when omitted', async () => {
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [] } } };
  const r = await request(app)
    .get('/api/v1/plexus/query?template=tokens.rate.byAgent')
    .set(authed);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.params.window, '5m');
  assert.match(r.body.query, /rate\(claude_code_token_usage_tokens_total\[5m\]\)/);
});

// ── range query validation ────────────────────────────────────────────

test('range query missing from/to/step → 400', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/query_range?template=tokens.rate.byAgent')
    .set(authed);
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /missing required params: from, to, step/);
});

test('range query with bad step → 400', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/query_range?template=tokens.rate.byAgent&from=1779000000&to=1779001000&step=1y')
    .set(authed);
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /step must be one of/);
});

test('range query with malformed from → 400', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/query_range?template=tokens.rate.byAgent&from=not-a-time&to=1779001000&step=15s')
    .set(authed);
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /not a valid RFC3339/);
});

test('valid range query reaches Prom + returns range echo', async () => {
  nextFetchResponse = { status: 200, body: { status: 'success', data: { resultType: 'matrix', result: [] } } };
  const r = await request(app)
    .get('/api/v1/plexus/query_range?template=tokens.rate.byAgent&from=1779000000&to=1779001000&step=15s')
    .set(authed);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.range.from, '1779000000');
  assert.equal(r.body.range.step, '15s');
  // Confirm Prom URL was built correctly
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/api\/v1\/query_range/);
  assert.match(fetchCalls[0].url, /step=15s/);
});

// ── cache behavior ────────────────────────────────────────────────────

test('repeat instant query → second hit returns cache (X-Plexus-Cache: hit)', async () => {
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [{ metric: { plexus_agent_id: 'a' }, value: [1, '5'] }] } } };
  const r1 = await request(app)
    .get('/api/v1/plexus/query?template=session.count.byAgent')
    .set(authed);
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.headers['x-plexus-cache'], 'miss');

  const r2 = await request(app)
    .get('/api/v1/plexus/query?template=session.count.byAgent')
    .set(authed);
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.headers['x-plexus-cache'], 'hit');
  assert.equal(fetchCalls.length, 1, 'second call should hit cache, not fetch');
});

test('different params produce distinct cache keys', async () => {
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [] } } };
  await request(app).get('/api/v1/plexus/query?template=cost.cumulative.byDim&dim=model').set(authed);
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [] } } };
  await request(app).get('/api/v1/plexus/query?template=cost.cumulative.byDim&dim=user_email').set(authed);
  assert.equal(fetchCalls.length, 2, 'distinct dims = distinct cache keys = 2 fetches');
});

// ── upstream failure handling ─────────────────────────────────────────

test('Prom upstream 500 → 500 with prom error body echoed', async () => {
  nextFetchResponse = { status: 500, body: { status: 'error', errorType: 'internal', error: 'boom' } };
  const r = await request(app)
    .get('/api/v1/plexus/query?template=session.count.byAgent')
    .set(authed);
  assert.equal(r.statusCode, 500);
  assert.equal(r.body.error, 'prom_upstream_error');
  assert.equal(r.body.promResponse.error, 'boom');
});

test('Prom unreachable (fetch throws) → 502 upstream_unreachable', async () => {
  nextFetchResponse = new Error('ECONNREFUSED');
  const r = await request(app)
    .get('/api/v1/plexus/query?template=session.count.byAgent')
    .set(authed);
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.error, 'prom_upstream_error');
  assert.equal(r.body.promResponse.errorType, 'upstream_unreachable');
});

// ── /public sub-router (no auth; dashboard browser surface) ───────────

test('/plexus/public/query accepts request WITHOUT Bearer', async () => {
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [] } } };
  const r = await request(app)
    .get('/api/v1/plexus/public/query?template=session.count.byAgent');
    // NO .set(authed) — public surface
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.template, 'session.count.byAgent');
});

test('/plexus/public/query_range works without Bearer', async () => {
  nextFetchResponse = { status: 200, body: { status: 'success', data: { resultType: 'matrix', result: [] } } };
  const r = await request(app)
    .get('/api/v1/plexus/public/query_range?template=tokens.rate.byAgent&from=1779000000&to=1779001000&step=15s');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.range.step, '15s');
});

test('/plexus/public/templates exposes the allowlist (browser discovery)', async () => {
  const r = await request(app).get('/api/v1/plexus/public/templates');
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.templates['tokens.rate.byAgent']);
});

test('/plexus/public enforces SAME allowlist as auth surface (no bypass)', async () => {
  // Verify the public surface can't escape the allowlist (no auth ≠ no validation)
  const r = await request(app)
    .get('/api/v1/plexus/public/query?template=cost.cumulative.byDim&dim=password');
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /dim must be one of/);
});

test('/plexus/public enforces SAME unknown-template handling', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/query?template=arbitrary_promql_attempt');
  assert.equal(r.statusCode, 422);
});

test('/plexus auth-required path still rejects unauth even though /public exists', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/query?template=session.count.byAgent');
    // NO .set(authed) — should still 401 on the protected path
  assert.equal(r.statusCode, 401);
});

// ── CP4 hardening: PromQL injection edge cases ────────────────────────

test('CP4: agent_id with PromQL escape attempt (newline) → 400', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/query?template=agent.identity.byAgentId&agent_id=' + encodeURIComponent('foo\nbar'))
    ;
  assert.equal(r.statusCode, 400);
});

test('CP4: agent_id with PromQL escape attempt (backslash) → 400', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/query?template=agent.identity.byAgentId&agent_id=' + encodeURIComponent('foo\\bar'))
    ;
  assert.equal(r.statusCode, 400);
});

test('CP4: agent_id at the 128-char boundary passes', async () => {
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [] } } };
  const longButValidId = 'a'.repeat(128);
  const r = await request(app)
    .get('/api/v1/plexus/public/query?template=agent.identity.byAgentId&agent_id=' + encodeURIComponent(longButValidId));
  assert.equal(r.statusCode, 200);
});

test('CP4: agent_id one over the 128-char boundary → 400', async () => {
  const tooLong = 'a'.repeat(129);
  const r = await request(app)
    .get('/api/v1/plexus/public/query?template=agent.identity.byAgentId&agent_id=' + encodeURIComponent(tooLong));
  assert.equal(r.statusCode, 400);
});

test('CP4: agent_id with allowed special chars (@.+:/-_) passes', async () => {
  nextFetchResponse = { status: 200, body: { status: 'success', data: { result: [] } } };
  const r = await request(app)
    .get('/api/v1/plexus/public/query?template=agent.identity.byAgentId&agent_id=' + encodeURIComponent('email@host.com/path-to:res_v1'));
  assert.equal(r.statusCode, 200);
});

test('CP4: agent_id space-injection → 400 (label values with spaces would break PromQL)', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/query?template=agent.identity.byAgentId&agent_id=' + encodeURIComponent('foo bar'));
  assert.equal(r.statusCode, 400);
});

test('CP4: time params with negative numbers reach Prom (Prom rejects upstream)', async () => {
  // Our validator only checks SHAPE; semantic negatives are fine to forward; Prom returns error.
  // But the request shouldn't 500 — should make it to Prom or reject cleanly.
  nextFetchResponse = { status: 400, body: { status: 'error', error: 'invalid time' } };
  const r = await request(app)
    .get('/api/v1/plexus/public/query_range?template=tokens.rate.byAgent&from=-1&to=0&step=15s');
  // Our regex /^\d+(\.\d+)?$/ rejects the negative sign so this 400s at our layer:
  assert.equal(r.statusCode, 400);
});

test('CP4: step whitespace rejected (`15 s` !== `15s`)', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/query_range?template=tokens.rate.byAgent&from=1779000000&to=1779001000&step=' + encodeURIComponent('15 s'));
  assert.equal(r.statusCode, 400);
});

test('CP4: empty template name → 400 (not 422)', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/query?template=');
  assert.equal(r.statusCode, 400);
  assert.match(r.body.error, /missing param: template/);
});

test('CP4: dim with PromQL-special chars (curly brace) → 400 via enum mismatch', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/query?template=cost.cumulative.byDim&dim=' + encodeURIComponent('user_email{'));
  assert.equal(r.statusCode, 400);
});

test('CP4: window with shell-injection attempt → 400', async () => {
  // Even if our enum miss-handles a weird value, the enum check should catch it
  const r = await request(app)
    .get('/api/v1/plexus/public/query?template=tokens.rate.byAgent&window=' + encodeURIComponent('5m;DROP'));
  assert.equal(r.statusCode, 400);
});

// CP6.4: dashboard-served smoke. Doesn't render the DOM (no jsdom in the
// project's existing test toolchain), just verifies the served HTML + JS
// contain the key structural markers so a regression that strips the
// cards grid / hero / SSE wiring won't ship silently.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-test-dashboard-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');

test('/dashboard returns HTML with Yaklog tabs + Live + Cost', async () => {
  const r = await request(app).get('/dashboard');
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.text, /data-tab="live"/);
  assert.match(r.text, /data-tab="cost"/);
  assert.match(r.text, /Yaklog dashboard/);
});

test('/dashboard has CP6.2 accounting card markup', async () => {
  const r = await request(app).get('/dashboard');
  assert.match(r.text, /data-card="accounting"/);
  assert.match(r.text, /id="acct-today"/);
  assert.match(r.text, /id="acct-7d"/);
  assert.match(r.text, /id="acct-mtd"/);
  assert.match(r.text, /id="acct-proj"/);
  assert.match(r.text, /id="acct-by"/);
});

test('/dashboard has CP6.3 cards-grid (presence table removed)', async () => {
  const r = await request(app).get('/dashboard');
  assert.match(r.text, /id="cards-grid"/);
  assert.match(r.text, /id="cards-meta"/);
  // The old table markup should be GONE
  assert.doesNotMatch(r.text, /<tbody id="rows">/);
  assert.doesNotMatch(r.text, /id="thead-row"/);
});

test('/dashboard.js contains AgentCard class + dot-tab logic', async () => {
  const r = await request(app).get('/dashboard.js');
  assert.equal(r.statusCode, 200);
  assert.match(r.text, /class AgentCard/);
  assert.match(r.text, /VIEW_LABELS/);
  assert.match(r.text, /renderCards/);
  assert.match(r.text, /tinyChart/);
  // CP6.4 freshness footer helper
  assert.match(r.text, /_freshnessEl/);
});

test('/dashboard.js cache-control prevents stale browser cache', async () => {
  const r = await request(app).get('/dashboard.js');
  assert.match(r.headers['cache-control'], /no-cache/);
  assert.match(r.headers['cache-control'], /no-store/);
});

test('/dashboard.js has uPlot stroke colors as LITERAL hex (canvas-safe)', async () => {
  // Canvas-rendered uPlot ignores CSS variables; literal hex required.
  // Regression guard for the bug fixed in commit 3f75510.
  const r = await request(app).get('/dashboard.js');
  assert.doesNotMatch(r.text, /stroke:\s*'var\(--/);
});

test('/dashboard.html links uPlot vendored CSS + JS', async () => {
  const r = await request(app).get('/dashboard');
  assert.match(r.text, /\/vendor\/uPlot\/uPlot\.min\.css/);
  assert.match(r.text, /\/vendor\/uPlot\/uPlot\.iife\.min\.js/);
});

test('/vendor/uPlot served (CP2 static mount)', async () => {
  const r = await request(app).get('/vendor/uPlot/uPlot.iife.min.js');
  assert.equal(r.statusCode, 200);
  assert.match(r.text, /uPlot/);
});

// ── CP7.1: /update + /api/v1/update/manifest ──────────────────────────

test('/api/v1/update/manifest returns JSON with artifacts array', async () => {
  const r = await request(app).get('/api/v1/update/manifest');
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /application\/json/);
  assert.ok(r.body.format_version);
  assert.ok(Array.isArray(r.body.artifacts));
  assert.ok(r.body.artifacts.length > 0);
  for (const a of r.body.artifacts) {
    assert.ok(a.name, 'artifact needs name: ' + JSON.stringify(a));
    assert.ok(a.version, 'artifact needs version: ' + a.name);
  }
});

test('/api/v1/update/manifest includes canonical daemon entry', async () => {
  const r = await request(app).get('/api/v1/update/manifest');
  const daemon = r.body.artifacts.find((a) => a.name === 'yaklog-sub daemon');
  assert.ok(daemon, 'manifest must include yaklog-sub daemon entry');
  assert.match(daemon.version, /^0\.5\./, 'daemon version should be semver-ish');
});

test('/update returns HTML with link to manifest JSON', async () => {
  const r = await request(app).get('/update');
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.text, /\/api\/v1\/update\/manifest/);
  assert.match(r.text, /update\.js/);
});

test('/update.js returns JS with manifest renderer', async () => {
  const r = await request(app).get('/update.js');
  assert.equal(r.statusCode, 200);
  assert.match(r.text, /renderArtifact|loadManifest|\/api\/v1\/update\/manifest/);
});

test('/update + /update.js have no-cache headers (like /dashboard)', async () => {
  const r1 = await request(app).get('/update');
  assert.match(r1.headers['cache-control'], /no-cache/);
  const r2 = await request(app).get('/update.js');
  assert.match(r2.headers['cache-control'], /no-cache/);
});

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

test('/dashboard returns HTML with Plexus tabs + Live + Cost', async () => {
  const r = await request(app).get('/dashboard');
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.text, /data-tab="live"/);
  assert.match(r.text, /data-tab="cost"/);
  assert.match(r.text, /Plexus dashboard/);
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

// CP13.4 / ADR-0032 Phase 1.4 — Effort tab dashboard markup test.
//
// Mirrors test/dashboardServe.test.js pattern: verifies served HTML + JS
// contain the structural markers so a regression that strips the tab
// won't ship silently. No DOM rendering (no jsdom in this project's
// test toolchain).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp134-tab-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.YAKLOG_OPS_API_KEYS = 'ops-key';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const { closeDb } = require('../src/db');
const app = require('../src/app');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ── HTML markup contains Effort tab structural markers ────────────────────

test('/dashboard returns HTML with Effort tab button + panel', async () => {
  const r = await request(app).get('/dashboard');
  assert.equal(r.statusCode, 200);
  assert.match(r.text, /data-tab="effort"/, 'effort tab button or panel marker missing');
  assert.match(r.text, /tab-effort/, 'effort tab panel id missing');
});

test('/dashboard Effort tab includes audience-tier picker (s345 #9234)', async () => {
  const r = await request(app).get('/dashboard');
  assert.match(r.text, /class="audience-picker"/);
  assert.match(r.text, /data-audience="buyer"/);
  assert.match(r.text, /data-audience="practitioner"/);
  assert.match(r.text, /data-audience="investor"/);
});

test('/dashboard Effort tab includes lens picker (Pace / Composition / Anomaly)', async () => {
  const r = await request(app).get('/dashboard');
  assert.match(r.text, /class="lens-picker"/);
  assert.match(r.text, /data-lens="pace"/);
  assert.match(r.text, /data-lens="composition"/);
  assert.match(r.text, /data-lens="anomaly"/);
});

test('/dashboard Effort hero strip includes cross-tier-safe tiles', async () => {
  const r = await request(app).get('/dashboard');
  assert.match(r.text, /id="tile-dpmpr"/, '$/merged-PR tile missing');
  assert.match(r.text, /id="tile-dpac"/, '$/agent-cycle tile missing');
  assert.match(r.text, /id="tile-cgap"/, 'coverage-gap tile missing');
});

test('/dashboard Effort hero strip includes practitioner-only tiles (Fold B HARD GATE class marker)', async () => {
  const r = await request(app).get('/dashboard');
  // Practitioner-only tiles must be present in markup (CSS hides them
  // for buyer/investor audience; server ALSO strips the data per
  // SERVER-SIDE Fold B HARD GATE — defense in depth)
  assert.match(r.text, /class="effort-tile practitioner-only"/);
  assert.match(r.text, /id="tile-cmpr"/, 'coord-msgs/PR tile missing');
  assert.match(r.text, /id="tile-tipr"/, 'tool-invocations/PR tile missing');
  assert.match(r.text, /id="tile-aepr"/, 'agents-engaged/PR tile missing');
});

test('/dashboard CSS includes Fold B HARD GATE selector (practitioner-only tiles hidden by default)', async () => {
  const r = await request(app).get('/dashboard');
  // Defense in depth — even before audience-picker is wired, tiles
  // start hidden via CSS. Server-side strip is the structural guarantee.
  assert.match(r.text, /#tab-effort\s+\.effort-tile\.practitioner-only\s*\{\s*display:\s*none/);
  assert.match(r.text, /#tab-effort\.audience-practitioner\s+\.effort-tile\.practitioner-only\s*\{\s*display:\s*flex/);
});

// ── /dashboard.js wiring ──────────────────────────────────────────────────

test('/dashboard.js includes ensureEffortView function + state', async () => {
  const r = await request(app).get('/dashboard.js');
  assert.equal(r.statusCode, 200);
  assert.match(r.text, /function ensureEffortView/);
  assert.match(r.text, /effortState/);
});

test('/dashboard.js Effort tab is in activateTab allowlist', async () => {
  const r = await request(app).get('/dashboard.js');
  assert.match(r.text, /'effort'/);
  assert.match(r.text, /\['live',\s*'cost',\s*'bus',\s*'audit',\s*'effort',\s*'register'\]/);
});

test('/dashboard.js calls /api/v1/output/* endpoints', async () => {
  const r = await request(app).get('/dashboard.js');
  assert.match(r.text, /\/api\/v1\/output\/ratios/);
  assert.match(r.text, /\/api\/v1\/output\/coverage-gap/);
  assert.match(r.text, /\/api\/v1\/output\/composition/);
  assert.match(r.text, /\/api\/v1\/output\/anomalies/);
});

test('/dashboard.js default audience is buyer (s345 #9234 Criterion 5)', async () => {
  const r = await request(app).get('/dashboard.js');
  assert.match(r.text, /audience:\s*'buyer'/);
});

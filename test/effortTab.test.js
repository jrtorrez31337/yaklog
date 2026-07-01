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
  // CP14 Operate tab added 2026-06-26 (PLAN-OPERATE-EYES-ON-GLASS-VIEW.md
  // parch ratify #10925); allowlist extended with 'operate' as 7th entry.
  assert.match(r.text, /\['live',\s*'cost',\s*'bus',\s*'audit',\s*'effort',\s*'register',\s*'operate'\]/);
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

// ── CP13.7 (parch #10812): Effort empty/loading/error states ───────────────
// Marker-style (no jsdom): assert the shared state vocabulary + sanitizer ship
// so a regression that strips empty-state handling can't land silently.

test('/dashboard CSS includes shared .effort-state empty/loading/error block', async () => {
  const r = await request(app).get('/dashboard');
  assert.match(r.text, /\.effort-state\s*\{/, '.effort-state base style missing');
  assert.match(r.text, /\.effort-state\.is-error\s+\.es-title/, 'error-state title color missing');
  // Reduced-motion must disable the skeleton shimmer (WCAG 2.3.3 / §2 motion rule).
  assert.match(r.text, /prefers-reduced-motion:\s*reduce[\s\S]*\.effort-skeleton\s*\{\s*animation:\s*none/);
  // Retry affordance meets target-size floor (WCAG 2.5.8: ≥24px; we use 32px).
  assert.match(r.text, /\.es-retry\s*\{[^}]*min-height:\s*32px/);
});

test('/dashboard composition tbody ships a loading state, not a bare "Loading…" cell', async () => {
  const r = await request(app).get('/dashboard');
  assert.match(r.text, /id="effort-composition-tbody"[\s\S]*effort-state/, 'composition tbody should seed an effort-state');
  assert.match(r.text, /id="effort-composition-tbody"[\s\S]*role="status"/, 'loading state needs aria-live status role');
});

test('/dashboard.js includes error sanitizer + shared state helper', async () => {
  const r = await request(app).get('/dashboard.js');
  assert.match(r.text, /function sanitizeEffortError/);
  assert.match(r.text, /function effortStateHtml/);
  assert.match(r.text, /function bindEffortRetry/);
});

test('/dashboard.js sanitizer maps HTTP codes (no raw status leaked to glass)', async () => {
  const r = await request(app).get('/dashboard.js');
  assert.match(r.text, /HTTP 40\[13\]/, '401/403 → Access denied mapping missing');
  assert.match(r.text, /HTTP 5\\d\\d/, '5xx → Service error mapping missing');
  // The coverage-gap tile sub must run through the sanitizer, not echo _error raw.
  assert.match(r.text, /cgapSub[\s\S]{0,120}sanitizeEffortError\(coverage\._error\)/);
});

test('/dashboard.js composition/anomaly render through the shared state helper', async () => {
  const r = await request(app).get('/dashboard.js');
  // Composition error path: sanitized + retry-enabled.
  assert.match(r.text, /effortStateHtml\('error',[\s\S]{0,120}sanitizeEffortError\(comp\._error\)/);
  // Composition empty path is distinct from error.
  assert.match(r.text, /effortStateHtml\('empty',[\s\S]{0,80}No agent activity/);
  // Anomaly insufficient-history empty state.
  assert.match(r.text, /Not enough history yet/);
});

// ── CP13.8: buyer-banner link contrast (WCAG 1.4.3) ────────────────────────
test('/dashboard buyer-banner link uses accessible brand token, not UA-default', async () => {
  const r = await request(app).get('/dashboard');
  // The <a> must be styled off the UA-default #0000ee (1.86:1 on --panel).
  assert.match(r.text, /\.effort-buyer-banner a\s*\{[^}]*color:\s*var\(--blue\)/);
  // ...with a visible keyboard focus ring.
  assert.match(r.text, /\.effort-buyer-banner a:focus-visible\s*\{[^}]*outline:/);
});

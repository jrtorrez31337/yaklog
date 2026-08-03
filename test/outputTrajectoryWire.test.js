// Task #288 Trajectory Lens BROWSER WIRE — yaklog-ui-agent.
// (Server-side endpoint tests live in outputTrajectory.test.js — yaklog-dev's.)
//
// Marker-style: verifies the served #output tab ships the Trajectory band wired
// to /output/trajectory, with governance-anchored labels (techmark #12417), inline
// SVG (no chart-lib dep), and the a11y contract (sr-only fallback + aria-label).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-traj-wire-'));
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

test('/dashboard ships the #output Trajectory band with governance-anchored controls', async () => {
  const r = await request(app).get('/dashboard');
  assert.equal(r.statusCode, 200);
  assert.match(r.text, /class="output-trajectory-section"[^>]*aria-label="Governance coverage trajectory"/);
  assert.match(r.text, /id="output-trajectory-metric"/);
  assert.match(r.text, /id="output-trajectory-topn"/);
  // Governance-anchored option labels, NOT bare "Commits over time".
  assert.match(r.text, /Commits under governance/);
  assert.match(r.text, /PRs merged under governance/);
});

test('/dashboard.js wires the Trajectory to /output/trajectory + pivot + time-nav', async () => {
  const r = await request(app).get('/dashboard.js');
  assert.match(r.text, /function _renderOutputTrajectory/);
  assert.match(r.text, /function _buildTrajectoryChart/);
  assert.match(r.text, /\/api\/v1\/output\/trajectory/);
  // pivot param uses the analytical-band toggle state; re-renders on pivot change.
  assert.match(r.text, /pivot=' \+ _outputPivot/);
  assert.match(r.text, /_renderOutputTrajectory\(\);\s*\/\/ trajectory re-pivots/);
});

test('/dashboard.js Trajectory uses inline SVG (no chart-lib) + a11y contract', async () => {
  const r = await request(app).get('/dashboard.js');
  // Inline SVG via createElementNS, not a charting library.
  assert.match(r.text, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg'/);
  // AT contract: role=img + aria-label summary + sr-only data-table fallback.
  assert.match(r.text, /role: 'img'/);
  assert.match(r.text, /setAttribute\('aria-label', 'Cumulative '/);
  assert.match(r.text, /class: 'sr-only'/);
  // Empty state governance-worded; honest error sanitized (no raw HTTP to glass).
  assert.match(r.text, /No governance activity in this window\./);
  assert.match(r.text, /Couldn’t load trajectory\. Retry shortly\./);
});

test('/dashboard CSS honors prefers-reduced-motion on the trajectory', async () => {
  const r = await request(app).get('/dashboard');
  assert.match(r.text, /prefers-reduced-motion:\s*reduce[\s\S]*\.otl-dot\s*\{\s*transition:\s*none/);
});

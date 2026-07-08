// ADR-0041 P1 #output shared-hero tab — plexus-ui-agent.
//
// Marker-style (mirrors effortTab / reposA11y): verifies the served dashboard
// ships the #output tab + hero band wired to /output/hero-summary, and — the
// load-bearing one — that the hero RENDER path references ONLY the cross-tier-safe
// hero-summary fields (render-tier Fold-B isolation, sister-shape ssw-devops
// #11946 §D + yaklog-dev's endpoint-tier forbidden-keys test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-output-p1-'));
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

// ── markup ────────────────────────────────────────────────────────────────
test('/dashboard ships the #output tab button + panel', async () => {
  const r = await request(app).get('/dashboard');
  assert.equal(r.statusCode, 200);
  assert.match(r.text, /<button class="tab-btn" data-tab="output">Output/);
  assert.match(r.text, /<section class="tab-panel" data-tab="output" id="tab-output">/);
  assert.match(r.text, /id="output-hero-strip"[^>]*aria-label="Cluster output summary"/);
});

test('/dashboard #output hero has the 5 cross-tier-safe tiles (locked labels)', async () => {
  const r = await request(app).get('/dashboard');
  for (const [key, label] of [
    ['repos_governed_total', 'Repos governed'],
    ['pr_merged_count_cumulative', 'Merged PRs'],
    ['attribution_integrity_pct', 'Attribution integrity'],
    ['attributed_agents', 'Attributed agents'],
    ['pending_bare_git_requests', 'Pending mints'],
  ]) {
    assert.match(r.text, new RegExp('data-hero="' + key + '"'), `missing hero tile ${key}`);
    assert.match(r.text, new RegExp(label), `missing label ${label}`);
  }
  // R2 lifetime cue present so the picker-invariant tile doesn't read as broken.
  assert.match(r.text, /lifetime · all-time/);
});

// ── JS wiring ───────────────────────────────────────────────────────────────
test('/dashboard.js mounts #output + fetches hero-summary + honest error copy', async () => {
  const r = await request(app).get('/dashboard.js');
  assert.match(r.text, /function mountOutputTab/);
  assert.match(r.text, /\/api\/v1\/output\/hero-summary/);
  assert.match(r.text, /Couldn’t load output summary\. Retry shortly\./);
  // Time-nav inherit + honest-error (no raw HTTP to glass).
  assert.match(r.text, /dashboardTimeRangeChange/);
  assert.doesNotMatch(r.text, /output summary[^"]*HTTP \$\{/);
});

test('/dashboard.js #output hero render references ONLY cross-tier-safe fields (Fold-B render isolation)', async () => {
  const r = await request(app).get('/dashboard.js');
  // Isolate the output-hero render block.
  const start = r.text.indexOf('async function _renderOutputHero');
  const end = r.text.indexOf('function mountOutputTab');
  assert.ok(start >= 0 && end > start, 'could not locate _renderOutputHero block');
  const block = r.text.slice(start, end);
  // Tier-gated field names must NOT appear in the always-visible hero render.
  for (const forbidden of ['dollar_per_', 'pr_merge_rate', 'time_to_merge', '_per_merged_pr', 'commit_count', 'pace']) {
    assert.ok(!block.includes(forbidden), `tier-gated field '${forbidden}' leaked into #output hero render`);
  }
});

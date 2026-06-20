// CP13.6 Phase 2.3 — output_pr-backed ratios tests
//
// Tests cover:
//   - pr_merge_rate computed cohort-based (PRs opened in period; rate ≤ 1.0)
//   - time_to_merge_hours computed as median (p50)
//   - dollar_per_pr_merged Phase 2 additive ratio (Q4 Option C)
//   - audience-tier canon (parch #9799 + s345 #9792 Fold-B correction):
//     buyer = NO output-strand ratios; investor = cost/value + rate;
//     practitioner = all 8 ratios

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp136-phase23-ratios-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const { closeDb, initializeDb, upsertOutputPr } = require('../src/db');
const {
  computeRatios,
  filterRatiosByAudience,
  PRACTITIONER_INVESTOR_RATIOS,
  PRACTITIONER_ONLY_RATIOS,
} = require('../src/outputRatios');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

const NOW_ISO = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function seedPr({ pr_number, state, opened_at, merged_at, closed_at = merged_at, owner_repo = 'jrtorrez31337/yaklog' }) {
  upsertOutputPr({
    github_owner_repo: owner_repo,
    pr_number,
    state,
    title: `PR ${pr_number}`,
    author_login: 'jrtorrez31337',
    author_email: null,
    base_ref: 'main',
    head_ref: `feature/pr-${pr_number}`,
    opened_at,
    merged_at,
    closed_at,
    merge_commit_sha: merged_at ? `sha-${pr_number}` : null,
    commit_count: null,
    last_synced_at: NOW_ISO,
  });
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

test.before(() => {
  const db = initializeDb();
  db.prepare(`INSERT INTO cost_daily (date, agent_id, model, cost_usd, computed_at)
    VALUES (date('now'), 'yaklog-dev-agent', 'claude', 200.0, datetime('now'))`).run();

  // 10 PRs opened in last 30d: 5 merged + 5 still open
  // Cohort: pr_merge_rate = 5/10 = 0.5
  // time_to_merge_hours: median of [1, 2, 4, 8, 16] = 4
  seedPr({ pr_number: 1, state: 'merged', opened_at: isoDaysAgo(20), merged_at: isoDaysAgo(20 - 1/24) });
  seedPr({ pr_number: 2, state: 'merged', opened_at: isoDaysAgo(18), merged_at: isoDaysAgo(18 - 2/24) });
  seedPr({ pr_number: 3, state: 'merged', opened_at: isoDaysAgo(15), merged_at: isoDaysAgo(15 - 4/24) });
  seedPr({ pr_number: 4, state: 'merged', opened_at: isoDaysAgo(10), merged_at: isoDaysAgo(10 - 8/24) });
  seedPr({ pr_number: 5, state: 'merged', opened_at: isoDaysAgo(5), merged_at: isoDaysAgo(5 - 16/24) });
  seedPr({ pr_number: 6, state: 'open', opened_at: isoDaysAgo(7), merged_at: null, closed_at: null });
  seedPr({ pr_number: 7, state: 'open', opened_at: isoDaysAgo(5), merged_at: null, closed_at: null });
  seedPr({ pr_number: 8, state: 'open', opened_at: isoDaysAgo(3), merged_at: null, closed_at: null });
  seedPr({ pr_number: 9, state: 'open', opened_at: isoDaysAgo(2), merged_at: null, closed_at: null });
  seedPr({ pr_number: 10, state: 'open', opened_at: isoDaysAgo(1), merged_at: null, closed_at: null });
});

test('pr_merge_rate: cohort-based (PRs opened in period; rate <= 1.0 by-construction)', () => {
  const db = initializeDb();
  const r = computeRatios(db, { period: '30d' });
  assert.equal(r._pr_opens_cohort_size, 10);
  assert.equal(r._pr_cohort_merged, 5);
  assert.equal(r.pr_merge_rate, 0.5);
});

test('time_to_merge_hours: median of merged-PR durations (~4h for fixture)', () => {
  const db = initializeDb();
  const r = computeRatios(db, { period: '30d' });
  assert.ok(r.time_to_merge_hours !== null);
  assert.ok(r.time_to_merge_hours > 2 && r.time_to_merge_hours < 8,
    `expected median near 4h; got ${r.time_to_merge_hours}`);
});

test('dollar_per_pr_merged: cost / PRs merged in period ($200 / 5 = $40)', () => {
  const db = initializeDb();
  const r = computeRatios(db, { period: '30d' });
  assert.equal(r._pr_merges_in_period, 5);
  assert.equal(r.dollar_per_pr_merged, 40);
});

test('Fold-B canon: buyer-tier gets NO output-strand ratios', () => {
  const db = initializeDb();
  const ratios = computeRatios(db, { period: '30d' });
  const buyer = filterRatiosByAudience(ratios, 'buyer');
  for (const key of Object.keys(buyer)) {
    if (key.startsWith('_')) continue;
    assert.ok(false, `buyer tier should have no output-strand ratios; got: ${key}`);
  }
  assert.equal(buyer._audience, 'buyer');
});

test('Fold-B canon: investor-tier gets cost/value + outcome-rate; NOT activity-numerator', () => {
  const db = initializeDb();
  const ratios = computeRatios(db, { period: '30d' });
  const investor = filterRatiosByAudience(ratios, 'investor');
  assert.ok('dollar_per_merged_pr' in investor);
  assert.ok('dollar_per_pr_merged' in investor);
  assert.ok('dollar_per_agent_cycle' in investor);
  assert.ok('pr_merge_rate' in investor);
  assert.ok('time_to_merge_hours' in investor);
  assert.ok(!('coord_messages_per_merged_pr' in investor));
  assert.ok(!('tool_invocations_per_merged_pr' in investor));
  assert.ok(!('agents_engaged_per_merged_pr' in investor));
});

test('Fold-B canon: practitioner-tier gets ALL 8 ratios', () => {
  const db = initializeDb();
  const ratios = computeRatios(db, { period: '30d' });
  const practitioner = filterRatiosByAudience(ratios, 'practitioner');
  for (const ratio of PRACTITIONER_INVESTOR_RATIOS) {
    assert.ok(ratio in practitioner, `expected ${ratio} in practitioner tier`);
  }
  for (const ratio of PRACTITIONER_ONLY_RATIOS) {
    assert.ok(ratio in practitioner, `expected ${ratio} in practitioner tier`);
  }
});

test('Fold-B canon: dollar_per_merged_pr (Phase 1) retroactively NOT buyer per parch #9799 *footnote', () => {
  const db = initializeDb();
  const ratios = computeRatios(db, { period: '30d' });
  const buyer = filterRatiosByAudience(ratios, 'buyer');
  assert.ok(!('dollar_per_merged_pr' in buyer),
    'dollar_per_merged_pr retroactive Fold-B correction per parch #9799 + yaklog-dev #9819 commitment');
});

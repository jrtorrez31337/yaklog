// Cost "Accounts" sortable-header a11y — plexus-ui-agent (Phase 2.7 F1+F2, parch #11565).
//
// Marker-style (mirrors effortTab / ptahTraceCopy): asserts the served dashboard
// makes the Accounts sort keyboard-operable (WCAG 2.1.1) via a real <button> and
// conveys sort state to AT (WCAG 4.1.2) via aria-sort. Surfaced by the Phase 2.7
// browser smoke (~/qa/effort-empty-state/harness-27.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-acct-a11y-'));
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

test('/dashboard.js Accounts headers use a keyboard-operable button + aria-sort', async () => {
  const r = await request(app).get('/dashboard.js');
  assert.equal(r.statusCode, 200);
  // th carries aria-sort state (WCAG 4.1.2).
  assert.match(r.text, /['"]aria-sort['"]\s*:\s*isSorted/);
  // A real <button class="th-sort"> is the sort control (WCAG 2.1.1 keyboard).
  assert.match(r.text, /el\('button',\s*\{[^}]*class:\s*'th-sort'/);
  // The old mouse-only clickable-th pattern must be gone.
  assert.doesNotMatch(r.text, /'data-sort-key':\s*c\.k,\s*style:\s*'cursor:pointer/);
});

test('/dashboard CSS gives the .th-sort control a visible keyboard focus ring', async () => {
  const r = await request(app).get('/dashboard');
  assert.match(r.text, /\.comp-table th \.th-sort\s*\{/);
  assert.match(r.text, /\.th-sort:focus-visible\s*\{[^}]*outline/);
});

// CP17.B Repos manage-form submit-button contrast (RF2) — yaklog-ui-agent (parch #11812).
//
// RF2-only subset: RF1 (heatmap cell a11y) is canonically yaklog-dev's role='button'
// interactive fix at d77f5d2 (pairs with the CP17.C drill-in modal). This branch
// keeps only the independent submit-button contrast fix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-rf2-'));
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

test('/dashboard manage-form button uses an accessible-contrast background (RF2)', async () => {
  const r = await request(app).get('/dashboard');
  assert.equal(r.statusCode, 200);
  // Must NOT be the old white-on-var(--blue) (#60a5fa) combo = 2.56:1.
  assert.match(r.text, /\.repos-manage-form button\s*\{[^}]*background:\s*#2563eb/);
  assert.doesNotMatch(r.text, /\.repos-manage-form button\s*\{[^}]*background:\s*var\(--blue\)/);
});

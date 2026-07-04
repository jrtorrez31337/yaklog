// Ptah trace-view empty/error microcopy — plexus-ui-agent (yaklog-dev #11243).
//
// Marker-style (mirrors test/effortTab.test.js): asserts the served dashboard.js
// carries honest, on-voice Ptah empty/error copy — no em-dash (cluster AI-tell
// canon) and no raw "HTTP <status>" leaked to operator glass.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-ptah-copy-'));
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

test('/dashboard.js Ptah empty-state has no em-dash (AI-tell canon)', async () => {
  const r = await request(app).get('/dashboard.js');
  assert.equal(r.statusCode, 200);
  assert.match(r.text, /No Ptah episodes yet\. Awaiting the first trace emit\./);
  assert.doesNotMatch(r.text, /No Ptah episodes yet —/, 'em-dash must be gone from Ptah empty-state');
});

test('/dashboard.js Ptah error states do not leak raw HTTP status to glass', async () => {
  const r = await request(app).get('/dashboard.js');
  // The pre-existing `error: HTTP ${status}` / `trace fetch: HTTP ${status}` leaks.
  assert.doesNotMatch(r.text, /error: HTTP \$\{epRes\.status\}/);
  assert.doesNotMatch(r.text, /trace fetch: HTTP \$\{trRes\.status\}/);
  // ...replaced with honest, sanitized operator copy.
  assert.match(r.text, /Couldn’t load Ptah episodes\. Retry shortly\./);
  assert.match(r.text, /Couldn’t load traces for this episode\. Retry shortly\./);
});

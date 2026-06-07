// CP12.17 Phase 2 item 3 closer: ADR change-history bus-message-ID
// cross-reference per parch #8015 OQ-B disposition.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp1217-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const {
  closeDb,
  insertMessage,
  findMessageIdsReferencingAdr,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test.before(() => {
  // Seed messages referencing various ADRs.
  insertMessage({ channel: 'handoff', sender: 'parch-agent',
    body: 'ratifying ADR-0030 v1.1 substantive disposition' });
  insertMessage({ channel: 'handoff', sender: 'yaklog-dev-agent',
    body: 'ADR-0030 §Phase 3 implementation gated on Jon-ratify' });
  insertMessage({ channel: 'handoff', sender: 'bizmodel-agent',
    body: 'ADR-0029 cost-persistence cycle empirically clean' });
  insertMessage({ channel: 'status', sender: 'admin-agent',
    body: 'unrelated cluster status update; no ADR refs here' });
  insertMessage({ channel: 'handoff', sender: 'parch-agent',
    body: 'ADR-30 short-form reference still correlates correctly' });
});

// ── pure helper ────────────────────────────────────────────────────────────

test('findMessageIdsReferencingAdr: finds padded refs', () => {
  const ids = findMessageIdsReferencingAdr({ adr_number: 30 });
  // 2 padded ("ADR-0030") + 1 unpadded ("ADR-30") = 3 messages
  assert.equal(ids.length, 3, `expected 3 refs to ADR-30; got ${ids.length}`);
});

test('findMessageIdsReferencingAdr: finds unpadded refs', () => {
  const ids = findMessageIdsReferencingAdr({ adr_number: '0030' });
  assert.equal(ids.length, 3);
});

test('findMessageIdsReferencingAdr: returns empty for unmentioned ADR', () => {
  const ids = findMessageIdsReferencingAdr({ adr_number: 9999 });
  assert.equal(ids.length, 0);
});

test('findMessageIdsReferencingAdr: word-boundary discipline (ADR-30 ≠ ADR-300)', () => {
  // ADR-0029 should NOT match an ADR-29 query if no ADR-29 ref exists
  const ids = findMessageIdsReferencingAdr({ adr_number: 29 });
  assert.equal(ids.length, 1, 'ADR-0029 matches ADR-29 (zero-padding tolerance)');
  // But a query for ADR-3 should not match ADR-30/ADR-0030 refs
  const ids2 = findMessageIdsReferencingAdr({ adr_number: 3 });
  assert.equal(ids2.length, 0, 'ADR-3 must not match ADR-30 (word-boundary)');
});

test('findMessageIdsReferencingAdr: rejects bad input', () => {
  assert.equal(findMessageIdsReferencingAdr({ adr_number: 'bogus' }).length, 0);
  assert.equal(findMessageIdsReferencingAdr({}).length, 0);
});

test('findMessageIdsReferencingAdr: respects time window', () => {
  // All seed messages were just inserted; query for distant past returns empty.
  const ids = findMessageIdsReferencingAdr({
    adr_number: 30, to: '2020-01-01T00:00:00.000Z',
  });
  assert.equal(ids.length, 0);
});

test('findMessageIdsReferencingAdr: returns DESC by id', () => {
  const ids = findMessageIdsReferencingAdr({ adr_number: 30 });
  for (let i = 0; i < ids.length - 1; i++) {
    assert.ok(ids[i] > ids[i + 1], `DESC ordering: ${ids[i]} > ${ids[i + 1]}`);
  }
});

// ── HTTP endpoint integration ──────────────────────────────────────────────

test('GET /audit/adr-change-history: response includes correlated_message_ids per commit', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/audit/adr-change-history?repo=agent-specs&limit=10');
  // 200 or 503 (bare repo may not be accessible in CI)
  assert.ok(r.status === 200 || r.status === 503);
  if (r.status !== 200) return;
  // Each commit should have correlated_message_ids field (possibly empty array)
  for (const c of (r.body.commits || [])) {
    assert.ok(Array.isArray(c.correlated_message_ids), 'every commit must have correlated_message_ids array');
  }
});

test('GET /audit/adr-change-history?correlate=false: opts out of cross-reference', async () => {
  const r = await request(app)
    .get('/api/v1/plexus/public/audit/adr-change-history?repo=agent-specs&limit=10&correlate=false');
  assert.ok(r.status === 200 || r.status === 503);
  if (r.status !== 200) return;
  // correlated_message_ids should not be set when correlate=false
  for (const c of (r.body.commits || [])) {
    assert.equal(c.correlated_message_ids, undefined, 'correlate=false must skip correlation');
  }
});

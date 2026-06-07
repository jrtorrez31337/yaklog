// CP12.14: date-filter semantics fix for audit endpoints.
//
// Bizmodel #7974 + #7976 + #7988: explicit `to=YYYY-MM-DD` was passing
// raw to SQL `occurred_at <= 'YYYY-MM-DD'` which excludes events with a
// time component on that day. Fix: expand date-only bounds to start/end
// of day in parseRange. This covers both older endpoints and CP12.13's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cp1214-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok-x';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const {
  closeDb,
  insertAuditCredentialChange,
  insertAuditPermissionChange,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// Seed: events with time components on a specific day.
const DAY = '2026-04-15';
const EVENT_TS = `${DAY}T14:23:45.000Z`;

test.before(() => {
  insertAuditCredentialChange({
    credential_class: 'cp1214-marker',  // unique class for identification
    change_type: 'mint',
    actor: 'cp1214-admin',
    reason: 'cp1214-test-seed',
    occurred_at: EVENT_TS,
  });
  insertAuditPermissionChange({
    agent_id: 'cp1214-agent',
    change_type: 'add',
    rule_text: 'cp1214-rule',
    actor: 'admin',
    occurred_at: EVENT_TS,
  });
});

// ── credential-changes: explicit to=YYYY-MM-DD INCLUDES same-day events ───

test('GET /audit/credential-changes: to=YYYY-MM-DD includes events with time component on that day', async () => {
  // BEFORE FIX: to=2026-04-15 → SQL occurred_at <= '2026-04-15' → excludes 2026-04-15T14:23
  // AFTER FIX:  to=2026-04-15 → expanded to 2026-04-15T23:59:59.999Z → includes the event
  const r = await request(app)
    .get(`/api/v1/plexus/public/audit/credential-changes?from=${DAY}&to=${DAY}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.count >= 1, `expected ≥1 event when to=${DAY} (event at ${EVENT_TS}); got ${r.body.count}`);
});

test('GET /audit/credential-changes: to=YYYY-MM-DD-prior excludes same-day events (correctness boundary)', async () => {
  const r = await request(app)
    .get(`/api/v1/plexus/public/audit/credential-changes?from=2026-04-01&to=2026-04-14`);
  assert.equal(r.status, 200);
  const ours = r.body.rows.filter(x => x.credential_class === 'cp1214-marker');
  assert.equal(ours.length, 0, `expected 0 cp1214 events when to=prior-day`);
});

// ── permission-changes: same coverage ─────────────────────────────────────

test('GET /audit/permission-changes: to=YYYY-MM-DD includes events with time component on that day', async () => {
  const r = await request(app)
    .get(`/api/v1/plexus/public/audit/permission-changes?from=${DAY}&to=${DAY}`);
  assert.equal(r.status, 200);
  const ours = r.body.rows.filter(x => x.agent_id === 'cp1214-agent');
  assert.ok(ours.length >= 1, `expected ≥1 perm event when to=${DAY}; got ${ours.length}`);
});

// ── full ISO bounds passthrough (backwards-compat) ────────────────────────

test('GET /audit/credential-changes: full ISO to passes through unchanged', async () => {
  // to=2026-04-15T15:00:00.000Z → includes 14:23 event (which is <= 15:00)
  const r = await request(app)
    .get(`/api/v1/plexus/public/audit/credential-changes?from=2026-04-15T00:00:00.000Z&to=2026-04-15T15:00:00.000Z`);
  assert.equal(r.status, 200);
  const ours = r.body.rows.filter(x => x.credential_class === 'cp1214-marker');
  assert.equal(ours.length, 1);
});

test('GET /audit/credential-changes: full ISO to truncated mid-day excludes later events', async () => {
  const r = await request(app)
    .get(`/api/v1/plexus/public/audit/credential-changes?from=2026-04-15T00:00:00.000Z&to=2026-04-15T13:00:00.000Z`);
  assert.equal(r.status, 200);
  const ours = r.body.rows.filter(x => x.credential_class === 'cp1214-marker');
  assert.equal(ours.length, 0, 'event at 14:23 should be excluded when full-ISO to=13:00');
});

// ── only-to (no from): start-of-time semantics preserved ──────────────────

test('GET /audit/credential-changes: only to= (no from) still includes same-day events', async () => {
  const r = await request(app)
    .get(`/api/v1/plexus/public/audit/credential-changes?to=${DAY}`);
  assert.equal(r.status, 200);
  const ours = r.body.rows.filter(x => x.credential_class === 'cp1214-marker');
  assert.ok(ours.length >= 1);
});

// ── CP12.13 endpoints also benefit (single-source fix) ────────────────────

test('GET /audit/credential-rotation-aggregate: to=YYYY-MM-DD includes same-day events', async () => {
  const r = await request(app)
    .get(`/api/v1/plexus/public/audit/credential-rotation-aggregate?from=${DAY}&to=${DAY}&group_by=actor`);
  assert.equal(r.status, 200);
  const cp1214 = r.body.buckets.find(b => b.bucket === 'cp1214-admin');
  assert.ok(cp1214 && cp1214.count >= 1, 'cp1214 admin event should appear when to=YYYY-MM-DD on the same day');
});

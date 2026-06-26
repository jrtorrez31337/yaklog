// CP16 Pillar audit-rollup substrate Phase 1a — schema migrations + helpers.
//
// PLAN-CP16-PILLAR-AUDIT-ROLLUP-SUBSTRATE.md §3 schema + §4 helpers.
// Driver tests cover empirical-rollup behavior; this suite covers schema +
// helper contract (sister-shape costRollup.test.js + costSubstrate.test.js).
//
// Coverage:
//   - 3 tables exist with correct PK shape
//   - Each upsert idempotent (re-call updates count + rolled_up_at)
//   - List filters: framework / object_class / agent_id / from_date / to_date
//   - Validation: required fields throw; negative count throws

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-audit-rollup-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.NODE_ENV = 'test';

const {
  closeDb,
  upsertAuditDailyByControlArea,
  upsertAuditDailyByObjectClass,
  upsertAuditDailyByAgent,
  listAuditDailyByControlArea,
  listAuditDailyByObjectClass,
  listAuditDailyByAgent,
} = require('../src/db');

// Force schema init by touching getDb (any helper call triggers it).
upsertAuditDailyByControlArea({
  occurred_date: '2026-06-20',
  control_framework: 'soc2',
  control_area: 'CC6',
  count: 12,
});

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test('schema: 3 rollup tables created with PK shape', () => {
  const { getDb } = require('../src/db');
  // getDb is internal to module — use any helper to ensure init then inspect via pragma
  // Re-import + use raw better-sqlite3 handle via Database
  const Database = require('better-sqlite3');
  const db = new Database(process.env.YAKLOG_DB_PATH);
  try {
    const cca = db.pragma('table_info(audit_daily_by_control_area)');
    assert.ok(cca.length > 0, 'audit_daily_by_control_area exists');
    assert.ok(cca.some((c) => c.name === 'occurred_date' && c.pk > 0));
    assert.ok(cca.some((c) => c.name === 'control_framework' && c.pk > 0));
    assert.ok(cca.some((c) => c.name === 'control_area' && c.pk > 0));

    const cob = db.pragma('table_info(audit_daily_by_object_class)');
    assert.ok(cob.length > 0, 'audit_daily_by_object_class exists');
    assert.ok(cob.some((c) => c.name === 'occurred_date' && c.pk > 0));
    assert.ok(cob.some((c) => c.name === 'object_class' && c.pk > 0));

    const cba = db.pragma('table_info(audit_daily_by_agent)');
    assert.ok(cba.length > 0, 'audit_daily_by_agent exists');
    assert.ok(cba.some((c) => c.name === 'occurred_date' && c.pk > 0));
    assert.ok(cba.some((c) => c.name === 'agent_id' && c.pk > 0));
    assert.ok(cba.some((c) => c.name === 'object_class' && c.pk > 0));
  } finally {
    db.close();
  }
});

test('upsertAuditDailyByControlArea: idempotent UPSERT updates count + rolled_up_at', () => {
  upsertAuditDailyByControlArea({
    occurred_date: '2026-06-21',
    control_framework: 'soc2',
    control_area: 'CC6',
    count: 5,
    rolled_up_at: '2026-06-26T10:00:00.000Z',
  });
  let rows = listAuditDailyByControlArea({ control_framework: 'soc2', from_date: '2026-06-21', to_date: '2026-06-21' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 5);
  assert.equal(rows[0].rolled_up_at, '2026-06-26T10:00:00.000Z');

  // Re-upsert with new count + rolled_up_at
  upsertAuditDailyByControlArea({
    occurred_date: '2026-06-21',
    control_framework: 'soc2',
    control_area: 'CC6',
    count: 7,
    rolled_up_at: '2026-06-26T11:00:00.000Z',
  });
  rows = listAuditDailyByControlArea({ control_framework: 'soc2', from_date: '2026-06-21', to_date: '2026-06-21' });
  assert.equal(rows.length, 1, 'still one row (PK conflict resolved)');
  assert.equal(rows[0].count, 7, 'count updated');
  assert.equal(rows[0].rolled_up_at, '2026-06-26T11:00:00.000Z', 'rolled_up_at updated');
});

test('upsertAuditDailyByObjectClass: idempotent + correct schema', () => {
  upsertAuditDailyByObjectClass({
    occurred_date: '2026-06-22',
    object_class: 'tool_invocation',
    count: 100,
  });
  upsertAuditDailyByObjectClass({
    occurred_date: '2026-06-22',
    object_class: 'tool_invocation',
    count: 105,
  });
  const rows = listAuditDailyByObjectClass({ object_class: 'tool_invocation', from_date: '2026-06-22', to_date: '2026-06-22' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 105);
});

test('upsertAuditDailyByAgent: per-class faceted; per-agent row tuple', () => {
  upsertAuditDailyByAgent({
    occurred_date: '2026-06-23',
    agent_id: 'cp16-test-agent',
    object_class: 'tool_invocation',
    count: 42,
  });
  upsertAuditDailyByAgent({
    occurred_date: '2026-06-23',
    agent_id: 'cp16-test-agent',
    object_class: 'file_access',
    count: 7,
  });
  // Distinct rows per (date, agent, class)
  const rows = listAuditDailyByAgent({ agent_id: 'cp16-test-agent', from_date: '2026-06-23', to_date: '2026-06-23' });
  assert.equal(rows.length, 2);
  const byClass = Object.fromEntries(rows.map((r) => [r.object_class, r.count]));
  assert.equal(byClass.tool_invocation, 42);
  assert.equal(byClass.file_access, 7);
});

test('list filters: from_date/to_date bounds inclusive', () => {
  upsertAuditDailyByObjectClass({ occurred_date: '2026-06-10', object_class: 'attestation', count: 1 });
  upsertAuditDailyByObjectClass({ occurred_date: '2026-06-15', object_class: 'attestation', count: 2 });
  upsertAuditDailyByObjectClass({ occurred_date: '2026-06-20', object_class: 'attestation', count: 3 });
  const rows = listAuditDailyByObjectClass({ object_class: 'attestation', from_date: '2026-06-12', to_date: '2026-06-18' });
  assert.equal(rows.length, 1, 'only 06-15 in range');
  assert.equal(rows[0].count, 2);
});

test('validation: required fields throw + negative count throws', () => {
  assert.throws(() => upsertAuditDailyByControlArea({ control_framework: 'soc2', control_area: 'CC6', count: 1 }), /occurred_date/);
  assert.throws(() => upsertAuditDailyByObjectClass({ occurred_date: '2026-06-26', count: 1 }), /object_class/);
  assert.throws(() => upsertAuditDailyByAgent({ occurred_date: '2026-06-26', agent_id: 'a', object_class: 'tool_invocation', count: -1 }), /non-negative/);
});

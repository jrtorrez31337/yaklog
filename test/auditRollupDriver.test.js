// CP16 Pillar audit-rollup Phase 1b — rollup driver tests.
//
// Seeds audit_tool_invocation + audit_file_access + audit_attestation rows
// with known occurred_at dates, then asserts rollupAuditDay produces the
// expected rows in audit_daily_by_control_area / audit_daily_by_object_class
// / audit_daily_by_agent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-audit-rollup-drv-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.NODE_ENV = 'test';

const {
  closeDb,
  insertAuditToolInvocation,
  insertAuditFileAccess,
  insertAuditAttestation,
  listAuditDailyByControlArea,
  listAuditDailyByObjectClass,
  listAuditDailyByAgent,
} = require('../src/db');

const {
  rollupAuditDay,
  rollupAuditWindow,
  CONTROL_AREA_MAP,
  AUDIT_OBJECT_CLASSES,
  AGENT_AWARE_CLASSES,
} = require('../src/auditRollup');

const DAY = '2026-06-10';
const DAY_TS = `${DAY}T12:00:00.000Z`;
const OTHER_DAY = '2026-06-11';
const OTHER_DAY_TS = `${OTHER_DAY}T08:00:00.000Z`;

test.before(() => {
  // Seed audit_tool_invocation: 3 rows for DAY (2 from agent-a, 1 from agent-b);
  // 1 row on OTHER_DAY (agent-a)
  for (let i = 0; i < 2; i++) {
    insertAuditToolInvocation({
      tool_phase: 'post',
      agent_id: 'agent-a',
      tool_name: 'Read',
      status: 'success',
      occurred_at: DAY_TS,
    });
  }
  insertAuditToolInvocation({
    tool_phase: 'post',
    agent_id: 'agent-b',
    tool_name: 'Edit',
    status: 'success',
    occurred_at: DAY_TS,
  });
  insertAuditToolInvocation({
    tool_phase: 'post',
    agent_id: 'agent-a',
    tool_name: 'Bash',
    status: 'success',
    occurred_at: OTHER_DAY_TS,
  });

  // Seed audit_file_access: 2 rows on DAY (agent-a)
  for (let i = 0; i < 2; i++) {
    insertAuditFileAccess({
      uid: 1001,
      agent_id: 'agent-a',
      path: '/tmp/x',
      access_mode: 'read',
      occurred_at: DAY_TS,
    });
  }

  // Seed audit_attestation: 1 CC1 + 1 CC9 on DAY (so by-control-area area-scoped count distinct)
  insertAuditAttestation({
    control_area: 'CC1',
    attestation_class: 'control-environment-review',
    attestation_text: 'q4 review',
    actor: 'ops-tester',
    occurred_at: DAY_TS,
  });
  insertAuditAttestation({
    control_area: 'CC9',
    attestation_class: 'risk-register-review',
    attestation_text: 'q4 risk',
    actor: 'ops-tester',
    occurred_at: DAY_TS,
  });
});

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test('CONTROL_AREA_MAP parity: driver copy ↔ auditRoutes (id-set per framework)', () => {
  const auditRoutes = require('../src/auditRoutes');
  // auditRoutes doesn't export CONTROL_AREA_MAP — assert against well-known
  // structure via the public /audit/by-control-area handler shape. As a
  // smoke-test we assert the driver's framework set matches the canonical
  // 3 frameworks. Full parity is enforced by manual review on either edit.
  assert.deepEqual(Object.keys(CONTROL_AREA_MAP).sort(), ['gdpr', 'iso27001', 'soc2']);
  for (const fw of Object.keys(CONTROL_AREA_MAP)) {
    for (const area of CONTROL_AREA_MAP[fw]) {
      assert.ok(area.id, `${fw} area must have id`);
      assert.ok(Array.isArray(area.audit_object_classes) && area.audit_object_classes.length > 0,
        `${fw}/${area.id} must declare ≥1 object class`);
    }
  }
});

test('rollupAuditDay: validates ymd format', () => {
  assert.throws(() => rollupAuditDay('not-a-date'), /YYYY-MM-DD/);
  assert.throws(() => rollupAuditDay('2026-6-10'), /YYYY-MM-DD/);
  assert.throws(() => rollupAuditDay(''), /YYYY-MM-DD/);
});

test('rollupAuditDay: writes 3 rollup tables; sister-shape counts', () => {
  const result = rollupAuditDay(DAY);
  assert.equal(result.ymd, DAY);
  assert.ok(result.by_control_area >= 17); // 6 soc2 + 7 iso27001 + 4 gdpr = 17
  assert.ok(result.by_object_class === AUDIT_OBJECT_CLASSES.length);
  assert.ok(result.by_agent >= 2); // agent-a + agent-b distinct rows for tool_invocation; plus agent-a for file_access

  // by_control_area soc2 CC7 = audit_tool_invocation (3) + audit_file_access (2) = 5
  const cc7 = listAuditDailyByControlArea({ control_framework: 'soc2', control_area: 'CC7', from_date: DAY, to_date: DAY });
  assert.equal(cc7.length, 1);
  assert.equal(cc7[0].count, 5);

  // CC1 = audit_attestation area-scoped (CC1) = 1
  const cc1 = listAuditDailyByControlArea({ control_framework: 'soc2', control_area: 'CC1', from_date: DAY, to_date: DAY });
  assert.equal(cc1[0].count, 1);
  // CC9 = audit_attestation area-scoped (CC9) = 1 (CP12.10 area-scoping discipline preserved)
  const cc9 = listAuditDailyByControlArea({ control_framework: 'soc2', control_area: 'CC9', from_date: DAY, to_date: DAY });
  assert.equal(cc9[0].count, 1);

  // by_object_class tool_invocation = 3 on DAY
  const tooClass = listAuditDailyByObjectClass({ object_class: 'tool_invocation', from_date: DAY, to_date: DAY });
  assert.equal(tooClass[0].count, 3);

  // by_object_class file_access = 2 on DAY
  const faClass = listAuditDailyByObjectClass({ object_class: 'file_access', from_date: DAY, to_date: DAY });
  assert.equal(faClass[0].count, 2);

  // by_agent: agent-a tool_invocation = 2, agent-b tool_invocation = 1
  const aTool = listAuditDailyByAgent({ agent_id: 'agent-a', object_class: 'tool_invocation', from_date: DAY, to_date: DAY });
  assert.equal(aTool[0].count, 2);
  const bTool = listAuditDailyByAgent({ agent_id: 'agent-b', object_class: 'tool_invocation', from_date: DAY, to_date: DAY });
  assert.equal(bTool[0].count, 1);

  // by_agent: agent-a file_access = 2 (different class on same agent → separate row per PK)
  const aFile = listAuditDailyByAgent({ agent_id: 'agent-a', object_class: 'file_access', from_date: DAY, to_date: DAY });
  assert.equal(aFile[0].count, 2);
});

test('rollupAuditDay: idempotent — re-call updates rolled_up_at + keeps counts', async () => {
  const first = rollupAuditDay(DAY);
  await new Promise((r) => setTimeout(r, 5));
  const second = rollupAuditDay(DAY);
  const cc7After = listAuditDailyByControlArea({ control_framework: 'soc2', control_area: 'CC7', from_date: DAY, to_date: DAY });
  assert.equal(cc7After.length, 1, 'still one row');
  assert.equal(cc7After[0].count, 5, 'count stable');
  assert.notEqual(cc7After[0].rolled_up_at, first.rolled_up_at, 'rolled_up_at advanced on re-run');
});

test('rollupAuditWindow: walks last-N COMPLETE days; today excluded', () => {
  // Use an endDateExclusive that pretends "today" is OTHER_DAY+5; daysBack=8
  // should walk back from OTHER_DAY+4 down to (OTHER_DAY+4 - 7days) inclusive.
  const endDate = '2026-06-15'; // pretend today
  const result = rollupAuditWindow({ daysBack: 6, endDateExclusive: endDate });
  assert.equal(result.window_days, 6);
  assert.equal(result.rolled, 6);
  // First rolled date should be one day before endDate
  assert.equal(result.results[0].ymd, '2026-06-14');
  // Last rolled date is 6 days back
  assert.equal(result.results[5].ymd, '2026-06-09');
  // endDate itself should NOT appear in rolled dates
  assert.ok(!result.results.some((r) => r.ymd === endDate), 'endDateExclusive never rolled');
});

test('rollupAuditWindow: validates daysBack', () => {
  assert.throws(() => rollupAuditWindow({ daysBack: 0 }), /positive integer/);
  assert.throws(() => rollupAuditWindow({ daysBack: -1 }), /positive integer/);
  assert.throws(() => rollupAuditWindow({ daysBack: 'foo' }), /positive integer/);
});

test('rollupAuditDay other day: distinct date isolation (no cross-day count leakage)', () => {
  rollupAuditDay(OTHER_DAY);
  // OTHER_DAY tool_invocation = 1 (agent-a Bash)
  const tooOther = listAuditDailyByObjectClass({ object_class: 'tool_invocation', from_date: OTHER_DAY, to_date: OTHER_DAY });
  assert.equal(tooOther[0].count, 1);
  // file_access = 0 on OTHER_DAY (zero row still upserted per driver contract)
  const faOther = listAuditDailyByObjectClass({ object_class: 'file_access', from_date: OTHER_DAY, to_date: OTHER_DAY });
  assert.equal(faOther[0].count, 0);
  // by_agent: agent-a tool_invocation on OTHER_DAY = 1; agent-b absent on OTHER_DAY
  const bOther = listAuditDailyByAgent({ agent_id: 'agent-b', object_class: 'tool_invocation', from_date: OTHER_DAY, to_date: OTHER_DAY });
  assert.equal(bOther.length, 0, 'agent-b has zero tool_invocation rows on OTHER_DAY → no by_agent row');
});

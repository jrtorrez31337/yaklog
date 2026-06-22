// Task #137 Per-Ptah-Agent Audit File substrate tests per parch #10266 ratify.
// Covers schema migration, agent_id validation (ptah-* namespace bound),
// per-agent file isolation, structured + blob column semantics, cross-agent
// UNION-ALL, idempotent provisionForAgent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-ptah-audit-test-'));
process.env.YAKLOG_PTAH_AUDIT_DB_DIR = tempDir;

const ptahAuditDb = require('../src/ptahAuditDb');

test.after(() => {
  ptahAuditDb.closeAll();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

test('pathFor rejects non-ptah-* agent_id (namespace bound per /register sub-OQ Option (c))', () => {
  assert.throws(() => ptahAuditDb.pathFor('admin-agent'),
    /ptah-\* namespace/);
  assert.throws(() => ptahAuditDb.pathFor('parch-agent'),
    /ptah-\* namespace/);
  assert.throws(() => ptahAuditDb.pathFor('not-ptah-something'),
    /ptah-\* namespace/);
});

test('pathFor accepts ptah-* agent_id', () => {
  const p = ptahAuditDb.pathFor('ptah-jon-desktop');
  assert.match(p, /ptah-audit-ptah-jon-desktop\.db$/);
});

test('pathFor rejects agent_id failing AGENT_ID_RE', () => {
  assert.throws(() => ptahAuditDb.pathFor('!!invalid'),
    /AGENT_ID_RE/);
  assert.throws(() => ptahAuditDb.pathFor(''),
    /AGENT_ID_RE/);
});

test('pathFor sanitizes / in agent_id (defense-in-depth)', () => {
  const p = ptahAuditDb.pathFor('ptah-a/b');
  // / replaced by _ in filename
  assert.match(p, /ptah-audit-ptah-a_b\.db$/);
  // No directory traversal
  assert.ok(!p.includes('/b.db'));
});

test('getDb creates file on first call + idempotent on second', () => {
  const db1 = ptahAuditDb.getDb('ptah-alpha');
  const file1 = ptahAuditDb.pathFor('ptah-alpha');
  assert.ok(fs.existsSync(file1), 'DB file created');
  const db2 = ptahAuditDb.getDb('ptah-alpha');
  assert.equal(db1, db2, 'same handle returned on second call');
});

test('provisionForAgent pre-creates file (called by /register handler)', () => {
  ptahAuditDb.provisionForAgent('ptah-beta');
  assert.ok(fs.existsSync(ptahAuditDb.pathFor('ptah-beta')));
});

test('insertEvent + getEventsForAgent round-trip', () => {
  const event = {
    event_id: 'evt-001',
    occurred_at: '2026-06-22T01:00:00Z',
    event_kind: 'tool_invocation',
    tool_name: 'desktop.type',
    tool_status: 'ok',
    model: 'claude-sonnet-4-6',
    cost_usd_micros: 1234,
    tokens_input: 100,
    tokens_output: 50,
    tokens_cache_read: 10,
    tokens_cache_write: 5,
    elapsed_ms: 1500,
    auth_mode: 'per-agent-bearer',
    context_json: { window: 'Notepad', selector: 'edit-1' },
  };
  ptahAuditDb.insertEvent('ptah-gamma', event);
  const rows = ptahAuditDb.getEventsForAgent('ptah-gamma');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_id, 'evt-001');
  assert.equal(rows[0].tool_name, 'desktop.type');
  assert.equal(rows[0].cost_usd_micros, 1234);
  assert.equal(rows[0].auth_mode, 'per-agent-bearer');
  // context_json round-trips as JSON string
  const ctx = JSON.parse(rows[0].context_json);
  assert.equal(ctx.window, 'Notepad');
});

test('insertEvent context_json accepts string OR object', () => {
  ptahAuditDb.insertEvent('ptah-delta', {
    event_id: 'evt-str',
    occurred_at: '2026-06-22T01:00:00Z',
    event_kind: 'tool_invocation',
    auth_mode: 'ops-key',
    context_json: '{"already":"stringified"}',
  });
  const rows = ptahAuditDb.getEventsForAgent('ptah-delta');
  assert.equal(JSON.parse(rows[0].context_json).already, 'stringified');
});

test('per-agent file isolation: alpha events do not appear in beta queries', () => {
  ptahAuditDb.insertEvent('ptah-iso-a', {
    event_id: 'iso-a-1', occurred_at: '2026-06-22T02:00:00Z',
    event_kind: 'tool_invocation', auth_mode: 'per-agent-bearer',
  });
  ptahAuditDb.insertEvent('ptah-iso-b', {
    event_id: 'iso-b-1', occurred_at: '2026-06-22T02:00:00Z',
    event_kind: 'tool_invocation', auth_mode: 'per-agent-bearer',
  });
  const aRows = ptahAuditDb.getEventsForAgent('ptah-iso-a');
  const bRows = ptahAuditDb.getEventsForAgent('ptah-iso-b');
  assert.equal(aRows.length, 1);
  assert.equal(aRows[0].event_id, 'iso-a-1');
  assert.equal(bRows.length, 1);
  assert.equal(bRows[0].event_id, 'iso-b-1');
});

test('listPtahDbs discovers all per-Ptah-agent files', () => {
  // Earlier tests created several agents; verify they all enumerate.
  const dbs = ptahAuditDb.listPtahDbs();
  const ids = new Set(dbs.map(d => d.agentId));
  assert.ok(ids.has('ptah-alpha'));
  assert.ok(ids.has('ptah-beta'));
  assert.ok(ids.has('ptah-gamma'));
  assert.ok(ids.has('ptah-iso-a'));
  assert.ok(ids.has('ptah-iso-b'));
});

test('unionAllEvents merges across all per-Ptah-agent files (Q5 ratify)', () => {
  const merged = ptahAuditDb.unionAllEvents({ limit: 100 });
  // All events from gamma, delta, iso-a, iso-b should appear, tagged with agent_id
  const byAgent = new Map();
  for (const e of merged) {
    if (!byAgent.has(e.agent_id)) byAgent.set(e.agent_id, []);
    byAgent.get(e.agent_id).push(e);
  }
  assert.ok(byAgent.has('ptah-gamma'));
  assert.ok(byAgent.has('ptah-delta'));
  assert.ok(byAgent.has('ptah-iso-a'));
  assert.ok(byAgent.has('ptah-iso-b'));
});

test('unionAllEvents respects limit', () => {
  const limited = ptahAuditDb.unionAllEvents({ limit: 2 });
  assert.ok(limited.length <= 2);
});

test('getEventsForAgent filters by event_kind', () => {
  ptahAuditDb.insertEvent('ptah-filter', {
    event_id: 'f-1', occurred_at: '2026-06-22T03:00:00Z',
    event_kind: 'tool_invocation', auth_mode: 'per-agent-bearer',
  });
  ptahAuditDb.insertEvent('ptah-filter', {
    event_id: 'f-2', occurred_at: '2026-06-22T03:00:01Z',
    event_kind: 'session_start', auth_mode: 'per-agent-bearer',
  });
  const tools = ptahAuditDb.getEventsForAgent('ptah-filter', { event_kind: 'tool_invocation' });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].event_id, 'f-1');
});

test('getEventsForAgent filters by occurred_at range', () => {
  // Use clean integer-second ISO bounds to avoid ISO-fractional lexical
  // sort ambiguity (`.` < `Z` confounds bare-Z vs fractional comparisons).
  // ptah-filter has f-1 @ 03:00:00Z + f-2 @ 03:00:01Z (inserted in test 13)
  const range = ptahAuditDb.getEventsForAgent('ptah-filter', {
    from: '2026-06-22T03:00:01Z',
    to: '2026-06-22T03:00:02Z',
  });
  // Only f-2 (occurred at 03:00:01) falls in this inclusive range
  assert.equal(range.length, 1);
  assert.equal(range[0].event_id, 'f-2');
});

test('insertEvent unique event_id constraint rejects duplicate', () => {
  ptahAuditDb.insertEvent('ptah-dup', {
    event_id: 'dup-1', occurred_at: '2026-06-22T04:00:00Z',
    event_kind: 'tool_invocation', auth_mode: 'per-agent-bearer',
  });
  assert.throws(() => ptahAuditDb.insertEvent('ptah-dup', {
    event_id: 'dup-1', occurred_at: '2026-06-22T04:00:01Z',
    event_kind: 'tool_invocation', auth_mode: 'per-agent-bearer',
  }), /UNIQUE/);
});

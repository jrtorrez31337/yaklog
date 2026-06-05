// CP12.4 (2026-06-05): tests for agent_activity → audit_tool_invocation
// DRY-augment ingester (ADR-0030 OQ#8 implementation).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-auditingest-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.NODE_ENV = 'test';

const {
  closeDb,
  insertAgentActivity,
  listAuditToolInvocations,
  getIngesterCursor,
  scanAgentActivityForAudit,
} = require('../src/db');

const ingester = require('../src/auditFromActivity');

test.after(() => {
  ingester.stopTicker();
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ─── scanAgentActivityForAudit ──────────────────────────────────────────────

test('scanAgentActivityForAudit: filters to tool-invocation events only', () => {
  insertAgentActivity('agent-scan', [
    { ts: '2026-06-05T10:00:00Z', event: 'SessionStart', payload: null },
    { ts: '2026-06-05T10:00:01Z', event: 'PreToolUse',   payload: null },
    { ts: '2026-06-05T10:00:02Z', event: 'PostToolUse',  payload: { status: 'ok' } },
    { ts: '2026-06-05T10:00:03Z', event: 'Stop',         payload: { reason: 'natural' } },
    { ts: '2026-06-05T10:00:04Z', event: 'SubagentStart',payload: { subagent_type: 'plan' } },
  ]);
  const rows = scanAgentActivityForAudit(0, 100);
  const events = rows.map(r => r.event).sort();
  assert.deepEqual(events, ['PostToolUse', 'PreToolUse', 'SubagentStart']);
});

// ─── distillRow ─────────────────────────────────────────────────────────────

test('distillRow: PreToolUse with null payload → tool_name=(unknown)', () => {
  const out = ingester._internal.distillRow({
    id: 1, agent_id: 'a', ts: '2026-06-05T10:00:00Z', event: 'PreToolUse', payload_json: null,
  });
  assert.equal(out.tool_phase, 'pre');
  assert.equal(out.tool_name, '(unknown)');
  assert.equal(out.source_event_id, 1);
});

test('distillRow: PreToolUse with tool payload → tool_name from payload', () => {
  const out = ingester._internal.distillRow({
    id: 2, agent_id: 'a', ts: '2026-06-05T10:00:00Z', event: 'PreToolUse',
    payload_json: JSON.stringify({ tool: 'Bash', cmd: 'git status', desc: 'show tree' }),
  });
  assert.equal(out.tool_name, 'Bash');
  assert.ok(out.input_digest);   // computed from cmd + desc
  assert.equal(out.input_digest.length, 64);
});

test('distillRow: PostToolUse status=ok → status:ok + tool_phase:post', () => {
  const out = ingester._internal.distillRow({
    id: 3, agent_id: 'a', ts: '2026-06-05T10:00:00Z', event: 'PostToolUse',
    payload_json: '{"status":"ok"}',
  });
  assert.equal(out.tool_phase, 'post');
  assert.equal(out.status, 'ok');
});

test('distillRow: PostToolUseFailure → tool_phase:failure + status:error + status_detail truncated', () => {
  const longReason = 'x'.repeat(500);
  const out = ingester._internal.distillRow({
    id: 4, agent_id: 'a', ts: '2026-06-05T10:00:00Z', event: 'PostToolUseFailure',
    payload_json: JSON.stringify({ tool: 'Bash', reason: longReason }),
  });
  assert.equal(out.tool_phase, 'failure');
  assert.equal(out.status, 'error');
  assert.equal(out.status_detail.length, 200);
});

test('distillRow: SubagentStart → tool_name=subagent:<type> + subagent_type set', () => {
  const out = ingester._internal.distillRow({
    id: 5, agent_id: 'a', ts: '2026-06-05T10:00:00Z', event: 'SubagentStart',
    payload_json: JSON.stringify({ subagent_type: 'code-reviewer' }),
  });
  assert.equal(out.tool_phase, 'pre');
  assert.equal(out.tool_name, 'subagent:code-reviewer');
  assert.equal(out.subagent_type, 'code-reviewer');
});

test('distillRow: non-tool event returns null', () => {
  assert.equal(ingester._internal.distillRow({
    id: 6, agent_id: 'a', ts: '2026-06-05T10:00:00Z', event: 'SessionStart', payload_json: null,
  }), null);
  assert.equal(ingester._internal.distillRow({
    id: 7, agent_id: 'a', ts: '2026-06-05T10:00:00Z', event: 'Stop', payload_json: '{"reason":"natural"}',
  }), null);
});

test('distillRow: malformed JSON payload → graceful fallback to (unknown)', () => {
  const out = ingester._internal.distillRow({
    id: 8, agent_id: 'a', ts: '2026-06-05T10:00:00Z', event: 'PreToolUse',
    payload_json: 'not valid json{',
  });
  assert.equal(out.tool_name, '(unknown)');
  assert.equal(out.input_digest, null);
});

// ─── runIngesterTick (end-to-end) ───────────────────────────────────────────

test('runIngesterTick: ingests fresh rows + advances cursor + writes audit_tool_invocation', async () => {
  insertAgentActivity('agent-tick', [
    { ts: '2026-06-05T10:01:00Z', event: 'PreToolUse',  payload: null },
    { ts: '2026-06-05T10:01:01Z', event: 'PostToolUse', payload: { status: 'ok' } },
  ]);
  const before = listAuditToolInvocations({ agent_id: 'agent-tick' }).length;
  const r = await ingester.runIngesterTick();
  const after = listAuditToolInvocations({ agent_id: 'agent-tick' }).length;
  assert.equal(after - before, 2);
  assert.ok(r.advanced_to >= r.after_id);
  const cursor = getIngesterCursor(ingester.INGESTER_NAME);
  assert.ok(cursor);
  assert.ok(cursor.last_source_id > 0);
});

test('runIngesterTick: second call processes only new rows (cursor honored)', async () => {
  const before = listAuditToolInvocations({ agent_id: 'agent-cursor' }).length;
  await ingester.runIngesterTick();  // drains anything pre-existing
  insertAgentActivity('agent-cursor', [
    { ts: '2026-06-05T10:02:00Z', event: 'PostToolUse', payload: { status: 'ok' } },
  ]);
  const r = await ingester.runIngesterTick();
  assert.equal(r.processed, 1, 'should ingest exactly the one new row');
  const after = listAuditToolInvocations({ agent_id: 'agent-cursor' }).length;
  assert.equal(after - before, 1);
});

test('runIngesterTick: empty backlog → processed=0 + cursor unchanged', async () => {
  await ingester.drain();  // ensure caught up
  const cursorBefore = getIngesterCursor(ingester.INGESTER_NAME);
  const r = await ingester.runIngesterTick();
  assert.equal(r.processed, 0);
  const cursorAfter = getIngesterCursor(ingester.INGESTER_NAME);
  assert.equal(cursorAfter.last_source_id, cursorBefore.last_source_id);
});

// ─── drain ─────────────────────────────────────────────────────────────────

test('drain: processes large backlog across multiple iterations', async () => {
  // Insert a chunk of rows.
  const rows = [];
  for (let i = 0; i < 50; i++) {
    rows.push({ ts: `2026-06-05T11:00:${String(i).padStart(2, '0')}Z`, event: 'PreToolUse', payload: null });
  }
  insertAgentActivity('agent-drain', rows);
  const before = listAuditToolInvocations({ agent_id: 'agent-drain' }).length;
  const r = await ingester.drain({ maxRowsPerTick: 20 });  // force multiple iters
  const after = listAuditToolInvocations({ agent_id: 'agent-drain' }).length;
  assert.equal(after - before, 50);
  assert.ok(r.iterations >= 1);
});

// ─── audit-trail integrity ─────────────────────────────────────────────────

test('integrity: source_event_id back-references the agent_activity row', async () => {
  insertAgentActivity('agent-fk', [
    { ts: '2026-06-05T12:00:00Z', event: 'PreToolUse', payload: { tool: 'Read', file: '/etc/x' } },
  ]);
  await ingester.runIngesterTick();
  const rows = listAuditToolInvocations({ agent_id: 'agent-fk' });
  assert.ok(rows.length > 0);
  // source_event_id should point to a real agent_activity.id
  for (const r of rows) {
    assert.ok(r.source_event_id != null && r.source_event_id > 0);
    assert.equal(r.event_id.length, 16);   // hash-chain forensic marker
  }
});

test('integrity: hash-chain event_id is deterministic-yet-distinct across rows', async () => {
  insertAgentActivity('agent-chain', [
    { ts: '2026-06-05T13:00:00Z', event: 'PreToolUse',  payload: { tool: 'Bash', cmd: 'ls' } },
    { ts: '2026-06-05T13:00:01Z', event: 'PostToolUse', payload: { status: 'ok' } },
  ]);
  await ingester.runIngesterTick();
  const rows = listAuditToolInvocations({ agent_id: 'agent-chain' });
  assert.ok(rows.length >= 2);
  const ids = new Set(rows.map(r => r.event_id));
  assert.equal(ids.size, rows.length, 'every event_id must be distinct');
  for (const r of rows) assert.match(r.event_id, /^[0-9a-f]{16}$/);
});

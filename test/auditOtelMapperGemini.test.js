// Phase 0 Item B Task B.5 — gemini_cli.tool_call event mapping.
// Per PLAN-ADR-0032-PHASE-0-CROSS-RUNTIME-TELEMETRY-PARITY.md
// section 2.2 schema mapping table for Gemini events.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-otel-mapper-gemini-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'tok';
process.env.YAKLOG_OPS_API_KEYS = 'ops-key';
process.env.YAKLOG_PRESENCE_SWEEP_MS = '0';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const { closeDb, getDb } = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

function makeBatch(records, resourceAttrs = []) {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttrs },
        scopeLogs: [
          { logRecords: records },
        ],
      },
    ],
  };
}

function geminiToolCall({ span_id = 'gem-span-1', function_name = 'edit_file', success = true, decision = 'auto_accept', conversation_id = 'gem-sess-1', tool_type = 'native', mcp_server_name = null, prompt_id = 'prompt-1', duration_ms = 88 } = {}) {
  const attrs = [
    { key: 'function_name',          value: { stringValue: function_name } },
    { key: 'success',                value: { boolValue: success } },
    { key: 'decision',               value: { stringValue: decision } },
    { key: 'gen_ai.conversation.id', value: { stringValue: conversation_id } },
    { key: 'tool_type',              value: { stringValue: tool_type } },
    { key: 'prompt_id',              value: { stringValue: prompt_id } },
    { key: 'duration_ms',            value: { intValue: duration_ms } },
  ];
  if (mcp_server_name) attrs.push({ key: 'mcp_server_name', value: { stringValue: mcp_server_name } });
  return {
    name: 'gemini_cli.tool_call',
    timeUnixNano: '1718000000000000000',
    spanId: span_id,
    attributes: attrs,
  };
}

test('gemini_cli.tool_call → audit_tool_invocation row with runtime_class=gemini', async () => {
  const r = await request(app)
    .post('/api/v1/audit/ingest/otel')
    .set('Authorization', 'Bearer ops-key')
    .send(makeBatch([geminiToolCall()], [
      { key: 'yaklog.agent_id', value: { stringValue: 'gemini-agent' } },
    ]));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ingested_count, 1);

  const db = getDb();
  const row = db.prepare(`SELECT * FROM audit_tool_invocation WHERE span_id = ?`).get('gem-span-1');
  assert.ok(row);
  assert.equal(row.runtime_class, 'gemini');
  assert.equal(row.agent_id, 'gemini-agent');
  assert.equal(row.tool_name, 'edit_file');
  assert.equal(row.tool_phase, 'ToolCall');
  assert.equal(row.status, 'success');
  assert.equal(row.session_correlator, 'gem-sess-1');
  assert.equal(row.duration_ms, 88);
  assert.equal(row.approval_state, 'auto_accept');
  assert.equal(row.prompt_correlator, 'prompt-1');
  assert.equal(row.tool_provenance, 'native');
});

test('gemini_cli.tool_call with tool_type=mcp + mcp_server_name → tool_provenance=mcp:<server>', async () => {
  await request(app)
    .post('/api/v1/audit/ingest/otel')
    .set('Authorization', 'Bearer ops-key')
    .send(makeBatch([geminiToolCall({
      span_id: 'gem-mcp-1', tool_type: 'mcp', mcp_server_name: 'filesystem',
    })], [
      { key: 'yaklog.agent_id', value: { stringValue: 'gemini-agent' } },
    ]));
  const db = getDb();
  const row = db.prepare(`SELECT tool_provenance FROM audit_tool_invocation WHERE span_id = ?`).get('gem-mcp-1');
  assert.equal(row.tool_provenance, 'mcp:filesystem');
});

test('gemini_cli.tool_call decision=reject → approval_state=reject', async () => {
  await request(app)
    .post('/api/v1/audit/ingest/otel')
    .set('Authorization', 'Bearer ops-key')
    .send(makeBatch([geminiToolCall({ span_id: 'gem-reject-1', decision: 'reject' })], [
      { key: 'yaklog.agent_id', value: { stringValue: 'gemini-agent' } },
    ]));
  const db = getDb();
  const row = db.prepare(`SELECT approval_state FROM audit_tool_invocation WHERE span_id = ?`).get('gem-reject-1');
  assert.equal(row.approval_state, 'reject');
});

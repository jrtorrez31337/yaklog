// Phase 0 Item B Task B.3 — codex.tool_result event mapping.
// Per PLAN-ADR-0032-PHASE-0-CROSS-RUNTIME-TELEMETRY-PARITY.md
// section 2.2 schema mapping table for Codex events.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-otel-mapper-codex-'));
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

function codexToolResult({ span_id = 'codex-span-1', function_name = 'Bash', success = true, conversation_id = 'sess-1', duration_ms = 42 } = {}) {
  return {
    name: 'codex.tool_result',
    timeUnixNano: '1718000000000000000',
    spanId: span_id,
    attributes: [
      { key: 'function_name', value: { stringValue: function_name } },
      { key: 'success',       value: { boolValue: success } },
      { key: 'conversation.id', value: { stringValue: conversation_id } },
      { key: 'duration_ms',   value: { intValue: duration_ms } },
    ],
  };
}

test('codex.tool_result → audit_tool_invocation row with runtime_class=codex', async () => {
  const r = await request(app)
    .post('/api/v1/audit/ingest/otel')
    .set('Authorization', 'Bearer ops-key')
    .send(makeBatch([codexToolResult()], [
      { key: 'plexus.agent_id', value: { stringValue: 'aieng3-agent' } },
    ]));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ingested_count, 1, 'should ingest 1 row');

  const db = getDb();
  const row = db.prepare(`SELECT * FROM audit_tool_invocation WHERE span_id = ?`).get('codex-span-1');
  assert.ok(row, 'row should exist');
  assert.equal(row.runtime_class, 'codex');
  assert.equal(row.agent_id, 'aieng3-agent');
  assert.equal(row.tool_name, 'Bash');
  assert.equal(row.tool_phase, 'PostToolUse');
  assert.equal(row.status, 'success');
  assert.equal(row.session_correlator, 'sess-1');
  assert.equal(row.duration_ms, 42);
});

test('codex.tool_result with success=false → status=failure', async () => {
  await request(app)
    .post('/api/v1/audit/ingest/otel')
    .set('Authorization', 'Bearer ops-key')
    .send(makeBatch([codexToolResult({ span_id: 'codex-span-2', success: false })], [
      { key: 'plexus.agent_id', value: { stringValue: 'aieng3-agent' } },
    ]));
  const db = getDb();
  const row = db.prepare(`SELECT status FROM audit_tool_invocation WHERE span_id = ?`).get('codex-span-2');
  assert.equal(row.status, 'failure');
});

test('codex.tool_result duplicate span_id → idempotent (single row)', async () => {
  await request(app)
    .post('/api/v1/audit/ingest/otel')
    .set('Authorization', 'Bearer ops-key')
    .send(makeBatch([codexToolResult({ span_id: 'codex-dedup-1' })], [
      { key: 'plexus.agent_id', value: { stringValue: 'aieng3-agent' } },
    ]));
  // Re-post the same span
  const r2 = await request(app)
    .post('/api/v1/audit/ingest/otel')
    .set('Authorization', 'Bearer ops-key')
    .send(makeBatch([codexToolResult({ span_id: 'codex-dedup-1' })], [
      { key: 'plexus.agent_id', value: { stringValue: 'aieng3-agent' } },
    ]));
  assert.equal(r2.body.ingested_count, 0, 'duplicate should not re-insert');
  assert.equal(r2.body.skipped_count, 1, 'duplicate should be counted as skipped');

  const db = getDb();
  const cnt = db.prepare(`SELECT COUNT(*) as n FROM audit_tool_invocation WHERE span_id = ?`).get('codex-dedup-1');
  assert.equal(cnt.n, 1);
});

test('unknown event type → skipped (not errored)', async () => {
  const r = await request(app)
    .post('/api/v1/audit/ingest/otel')
    .set('Authorization', 'Bearer ops-key')
    .send(makeBatch([{ name: 'some.unknown.event', timeUnixNano: '0', attributes: [] }]));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ingested_count, 0);
  assert.equal(r.body.skipped_count, 1);
  assert.equal((r.body.errors || []).length, 0);
});

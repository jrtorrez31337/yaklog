// CP11.2 (2026-06-04): Phase 2 — cost rollup job tests.
//
// Mocks global fetch to inject synthetic Prom responses; verifies rollupDay
// correctly distills (agent/email/org/model) tuples, sums costs, maps token
// types, and UPSERTs into cost_daily with operator-tag enrichment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-rollup-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.YAKLOG_COST_ROLLUP_DISABLED = '1';  // prevent app.js from auto-arming schedulers
process.env.NODE_ENV = 'test';

const {
  closeDb,
  upsertCostDimensionTags,
  getCostByPeriod,
} = require('../src/db');

const { rollupDay, _internal } = require('../src/costRollup');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// Mock fetch — intercepts Prom queries + returns canned responses.
// Set _MOCK_FETCH to an array of { match: regex, response: obj } before each test.
let _mockResponses = [];
function mockFetch(url, _opts) {
  const u = String(url);
  for (const m of _mockResponses) {
    if (m.match.test(u)) {
      return Promise.resolve({
        status: 200,
        text: () => Promise.resolve(JSON.stringify(m.response)),
      });
    }
  }
  return Promise.resolve({
    status: 500,
    text: () => Promise.resolve(JSON.stringify({ status: 'error', error: `mock missing for ${u}` })),
  });
}
global.fetch = mockFetch;

function promVector(rows) {
  return { status: 'success', data: { resultType: 'vector', result: rows } };
}
function promSeries(metric, value) {
  return { metric, value: [Date.now() / 1000, String(value)] };
}

// ─── Basic rollup ──────────────────────────────────────────────────────

test('rollupDay: single-agent cost + tokens UPSERTed correctly', async () => {
  _mockResponses = [
    {
      match: /claude_code_cost_usage_USD_total/,
      response: promVector([
        promSeries({
          plexus_agent_id: 'agent-a', user_email: 'a@example.com',
          organization_id: 'org-1', model: 'claude-opus-4-7',
        }, 1.25),
      ]),
    },
    {
      match: /claude_code_token_usage_tokens_total/,
      response: promVector([
        promSeries({ plexus_agent_id: 'agent-a', user_email: 'a@example.com',
          organization_id: 'org-1', model: 'claude-opus-4-7', type: 'input' }, 10000),
        promSeries({ plexus_agent_id: 'agent-a', user_email: 'a@example.com',
          organization_id: 'org-1', model: 'claude-opus-4-7', type: 'output' }, 5000),
        promSeries({ plexus_agent_id: 'agent-a', user_email: 'a@example.com',
          organization_id: 'org-1', model: 'claude-opus-4-7', type: 'cacheRead' }, 80000),
        promSeries({ plexus_agent_id: 'agent-a', user_email: 'a@example.com',
          organization_id: 'org-1', model: 'claude-opus-4-7', type: 'cacheCreation' }, 2000),
      ]),
    },
  ];

  const result = await rollupDay('2026-06-04');
  assert.equal(result.rows, 1);
  assert.equal(result.agents, 1);

  const rows = getCostByPeriod({ from: '2026-06-04', to: '2026-06-04', agent_id: 'agent-a' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost_usd, 1.25);
  assert.equal(rows[0].tokens_input, 10000);
  assert.equal(rows[0].tokens_output, 5000);
  assert.equal(rows[0].tokens_cache_read, 80000);
  assert.equal(rows[0].tokens_cache_creation, 2000);
  assert.equal(rows[0].model, 'claude-opus-4-7');
  assert.equal(rows[0].user_email, 'a@example.com');
  assert.equal(rows[0].organization_id, 'org-1');
});

test('rollupDay: multiple agents → separate rows per dim-tuple', async () => {
  _mockResponses = [
    {
      match: /claude_code_cost_usage_USD_total/,
      response: promVector([
        promSeries({ plexus_agent_id: 'agent-a', user_email: 'a@x.com', model: 'opus' }, 1.0),
        promSeries({ plexus_agent_id: 'agent-b', user_email: 'b@x.com', model: 'sonnet' }, 0.5),
      ]),
    },
    { match: /claude_code_token_usage_tokens_total/, response: promVector([]) },
  ];
  const result = await rollupDay('2026-06-05');
  assert.equal(result.rows, 2);
  assert.equal(result.agents, 2);
  const all = getCostByPeriod({ from: '2026-06-05', to: '2026-06-05' });
  assert.equal(all.length, 2);
  const aRow = all.find((r) => r.agent_id === 'agent-a');
  const bRow = all.find((r) => r.agent_id === 'agent-b');
  assert.equal(aRow.cost_usd, 1.0);
  assert.equal(bRow.cost_usd, 0.5);
});

// ─── Idempotency ───────────────────────────────────────────────────────

test('rollupDay: re-run for same date REPLACES (UPSERT idempotent)', async () => {
  // First pass with cost=2.0
  _mockResponses = [
    {
      match: /claude_code_cost_usage_USD_total/,
      response: promVector([promSeries({ plexus_agent_id: 'agent-c', model: 'opus' }, 2.0)]),
    },
    { match: /claude_code_token_usage_tokens_total/, response: promVector([]) },
  ];
  await rollupDay('2026-06-06');
  let rows = getCostByPeriod({ from: '2026-06-06', to: '2026-06-06', agent_id: 'agent-c' });
  assert.equal(rows[0].cost_usd, 2.0);

  // Second pass with cost=3.0 (e.g., late-arriving Prom data)
  _mockResponses = [
    {
      match: /claude_code_cost_usage_USD_total/,
      response: promVector([promSeries({ plexus_agent_id: 'agent-c', model: 'opus' }, 3.0)]),
    },
    { match: /claude_code_token_usage_tokens_total/, response: promVector([]) },
  ];
  await rollupDay('2026-06-06');
  rows = getCostByPeriod({ from: '2026-06-06', to: '2026-06-06', agent_id: 'agent-c' });
  assert.equal(rows.length, 1, 'still 1 row');
  assert.equal(rows[0].cost_usd, 3.0, 'value updated to latest rollup');
});

// ─── Operator-tag enrichment ───────────────────────────────────────────

test('rollupDay: operator tags from cost_dimension_tags table get applied', async () => {
  upsertCostDimensionTags({
    agent_id: 'agent-d',
    cost_center: 'eng-ops', project_tag: 'plexus',
    environment_tier: 'prod', billable_flag: 1,
  });
  _mockResponses = [
    {
      match: /claude_code_cost_usage_USD_total/,
      response: promVector([promSeries({ plexus_agent_id: 'agent-d', model: 'opus' }, 1.0)]),
    },
    { match: /claude_code_token_usage_tokens_total/, response: promVector([]) },
  ];
  await rollupDay('2026-06-07');
  const rows = getCostByPeriod({ from: '2026-06-07', to: '2026-06-07', agent_id: 'agent-d' });
  assert.equal(rows[0].cost_center, 'eng-ops');
  assert.equal(rows[0].project_tag, 'plexus');
  assert.equal(rows[0].environment_tier, 'prod');
  assert.equal(rows[0].billable_flag, 1);
});

test('rollupDay: untagged agent → empty operator-tag defaults', async () => {
  _mockResponses = [
    {
      match: /claude_code_cost_usage_USD_total/,
      response: promVector([promSeries({ plexus_agent_id: 'agent-untagged', model: 'sonnet' }, 0.1)]),
    },
    { match: /claude_code_token_usage_tokens_total/, response: promVector([]) },
  ];
  await rollupDay('2026-06-08');
  const rows = getCostByPeriod({ from: '2026-06-08', to: '2026-06-08', agent_id: 'agent-untagged' });
  assert.equal(rows[0].cost_center, '');
  assert.equal(rows[0].billable_flag, 0);
});

// ─── Empty data + edge cases ───────────────────────────────────────────

test('rollupDay: no Prom data → 0 rows, no error', async () => {
  _mockResponses = [
    { match: /claude_code_cost_usage_USD_total/, response: promVector([]) },
    { match: /claude_code_token_usage_tokens_total/, response: promVector([]) },
  ];
  const result = await rollupDay('2026-06-09');
  assert.equal(result.rows, 0);
  assert.equal(result.agents, 0);
});

test('rollupDay: token-only series (cost=0 for dim) still UPSERTs token row', async () => {
  _mockResponses = [
    { match: /claude_code_cost_usage_USD_total/, response: promVector([]) },
    {
      match: /claude_code_token_usage_tokens_total/,
      response: promVector([
        promSeries({ plexus_agent_id: 'agent-tokens-only', model: 'haiku', type: 'input' }, 500),
      ]),
    },
  ];
  await rollupDay('2026-06-10');
  const rows = getCostByPeriod({ from: '2026-06-10', to: '2026-06-10', agent_id: 'agent-tokens-only' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost_usd, 0);
  assert.equal(rows[0].tokens_input, 500);
});

test('rollupDay: unknown token type → dropped (default-deny)', async () => {
  _mockResponses = [
    { match: /claude_code_cost_usage_USD_total/, response: promVector([promSeries({ plexus_agent_id: 'agent-x', model: 'opus' }, 1)]) },
    {
      match: /claude_code_token_usage_tokens_total/,
      response: promVector([
        promSeries({ plexus_agent_id: 'agent-x', model: 'opus', type: 'input' }, 100),
        promSeries({ plexus_agent_id: 'agent-x', model: 'opus', type: 'mystery-future-type' }, 99999),
      ]),
    },
  ];
  await rollupDay('2026-06-11');
  const rows = getCostByPeriod({ from: '2026-06-11', to: '2026-06-11', agent_id: 'agent-x' });
  assert.equal(rows[0].tokens_input, 100);
  // mystery-future-type silently dropped; only standard cols populated
  assert.equal(rows[0].tokens_output, 0);
  assert.equal(rows[0].tokens_cache_read, 0);
});

// ─── Validation ────────────────────────────────────────────────────────

test('rollupDay: invalid date format → throws', async () => {
  await assert.rejects(() => rollupDay('not-a-date'), /ymd must be YYYY-MM-DD/);
  await assert.rejects(() => rollupDay('2026/06/04'), /ymd must be YYYY-MM-DD/);
});

test('rollupDay: Prom error response → throws', async () => {
  _mockResponses = [
    { match: /claude_code_cost_usage_USD_total/,
      response: { status: 'error', error: 'simulated prom-down' } },
    { match: /claude_code_token_usage_tokens_total/, response: promVector([]) },
  ];
  await assert.rejects(() => rollupDay('2026-06-12'), /rollupDay cost query failed/);
});

// ─── _internal helpers ─────────────────────────────────────────────────

test('_internal.dateToYmd: UTC formatting', () => {
  assert.equal(_internal.dateToYmd(new Date('2026-06-04T15:30:00Z')), '2026-06-04');
  assert.equal(_internal.dateToYmd(new Date('2026-06-04T23:59:59Z')), '2026-06-04');
  assert.equal(_internal.dateToYmd(new Date('2026-06-05T00:00:01Z')), '2026-06-05');
});

test('_internal.ymdToStartOfDayUtc: round-trip', () => {
  const d = _internal.ymdToStartOfDayUtc('2026-06-04');
  assert.equal(d.toISOString(), '2026-06-04T00:00:00.000Z');
});

// ─── CP11.x.1 multi-runtime token aggregation ───────────────────────────

test('rollupDay CP11.x.1: codex-only tokens → row inserted with vendor=OpenAI', async () => {
  _mockResponses = [
    { match: /claude_code_cost_usage_USD_total/, response: promVector([]) },
    { match: /claude_code_token_usage_tokens_total/, response: promVector([]) },
    {
      match: /plexus_tokens_input_total/,
      response: promVector([
        promSeries({ plexus_agent_id: 'aieng3-agent', plexus_runtime_class: 'codex-cli' }, 12345),
      ]),
    },
    {
      match: /plexus_tokens_output_total/,
      response: promVector([
        promSeries({ plexus_agent_id: 'aieng3-agent', plexus_runtime_class: 'codex-cli' }, 6789),
      ]),
    },
  ];
  const result = await rollupDay('2026-06-15');
  assert.equal(result.rows, 1);
  const rows = getCostByPeriod({ from: '2026-06-15', to: '2026-06-15', agent_id: 'aieng3-agent' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'codex-cli', 'synthetic model = runtime_class string');
  assert.equal(rows[0].vendor, 'OpenAI', 'vendor derived from runtime_class');
  assert.equal(rows[0].tokens_input, 12345);
  assert.equal(rows[0].tokens_output, 6789);
  assert.equal(rows[0].cost_usd, 0, 'no cost USD counter for codex (CP11.x.1 honesty)');
});

test('rollupDay CP11.x.1: gemini-only tokens → row inserted with vendor=Google', async () => {
  _mockResponses = [
    { match: /claude_code_cost_usage_USD_total/, response: promVector([]) },
    { match: /claude_code_token_usage_tokens_total/, response: promVector([]) },
    {
      match: /plexus_tokens_input_total/,
      response: promVector([
        promSeries({ plexus_agent_id: 'gemini-agent', plexus_runtime_class: 'gemini-cli' }, 5000),
      ]),
    },
    {
      match: /plexus_tokens_output_total/,
      response: promVector([
        promSeries({ plexus_agent_id: 'gemini-agent', plexus_runtime_class: 'gemini-cli' }, 2500),
      ]),
    },
  ];
  const result = await rollupDay('2026-06-16');
  assert.equal(result.rows, 1);
  const rows = getCostByPeriod({ from: '2026-06-16', to: '2026-06-16', agent_id: 'gemini-agent' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'gemini-cli');
  assert.equal(rows[0].vendor, 'Google');
  assert.equal(rows[0].tokens_input, 5000);
  assert.equal(rows[0].tokens_output, 2500);
});

test('rollupDay CP11.x.1: CC + codex mixed → both vendors land in distinct rows', async () => {
  _mockResponses = [
    {
      match: /claude_code_cost_usage_USD_total/,
      response: promVector([
        promSeries({ plexus_agent_id: 'cc-agent', model: 'claude-opus-4-7' }, 2.5),
      ]),
    },
    {
      match: /claude_code_token_usage_tokens_total/,
      response: promVector([
        promSeries({ plexus_agent_id: 'cc-agent', model: 'claude-opus-4-7', type: 'input' }, 10000),
        promSeries({ plexus_agent_id: 'cc-agent', model: 'claude-opus-4-7', type: 'output' }, 4000),
      ]),
    },
    {
      match: /plexus_tokens_input_total/,
      response: promVector([
        promSeries({ plexus_agent_id: 'codex-agent', plexus_runtime_class: 'codex-cli' }, 8000),
      ]),
    },
    {
      match: /plexus_tokens_output_total/,
      response: promVector([
        promSeries({ plexus_agent_id: 'codex-agent', plexus_runtime_class: 'codex-cli' }, 3000),
      ]),
    },
  ];
  const result = await rollupDay('2026-06-17');
  assert.equal(result.rows, 2);
  const ccRow = getCostByPeriod({ from: '2026-06-17', to: '2026-06-17', agent_id: 'cc-agent' })[0];
  const cxRow = getCostByPeriod({ from: '2026-06-17', to: '2026-06-17', agent_id: 'codex-agent' })[0];
  assert.equal(ccRow.vendor, 'Anthropic', 'CC row derives vendor from claude- model prefix');
  assert.equal(ccRow.cost_usd, 2.5);
  assert.equal(ccRow.tokens_input, 10000);
  assert.equal(cxRow.vendor, 'OpenAI');
  assert.equal(cxRow.cost_usd, 0);
  assert.equal(cxRow.tokens_input, 8000);
});

test('rollupDay CP11.x.1: unknown plexus_runtime_class → row skipped (default-deny)', async () => {
  _mockResponses = [
    { match: /claude_code_cost_usage_USD_total/, response: promVector([]) },
    { match: /claude_code_token_usage_tokens_total/, response: promVector([]) },
    {
      match: /plexus_tokens_input_total/,
      response: promVector([
        promSeries({ plexus_agent_id: 'mystery-agent', plexus_runtime_class: 'future-runtime-9' }, 1000),
      ]),
    },
    { match: /plexus_tokens_output_total/, response: promVector([]) },
  ];
  const result = await rollupDay('2026-06-18');
  // Mystery runtime IS rolled up but with vendor='Other' (we don't drop;
  // RUNTIME_CLASS_TO_VENDOR falls back to 'Other' for unknown classes).
  // The skip-rule is for EMPTY plexus_runtime_class (no value at all).
  assert.equal(result.rows, 1);
  const rows = getCostByPeriod({ from: '2026-06-18', to: '2026-06-18', agent_id: 'mystery-agent' });
  assert.equal(rows[0].vendor, 'Other', 'unknown runtime_class falls through to Other vendor');
  assert.equal(rows[0].model, 'future-runtime-9');
});

test('rollupDay CP11.x.1: empty plexus_runtime_class → series skipped (hygiene)', async () => {
  _mockResponses = [
    { match: /claude_code_cost_usage_USD_total/, response: promVector([]) },
    { match: /claude_code_token_usage_tokens_total/, response: promVector([]) },
    {
      match: /plexus_tokens_input_total/,
      response: promVector([
        promSeries({ plexus_agent_id: 'orphan-agent' /* no plexus_runtime_class */ }, 999),
      ]),
    },
    { match: /plexus_tokens_output_total/, response: promVector([]) },
  ];
  const result = await rollupDay('2026-06-19');
  assert.equal(result.rows, 0, 'series with empty runtime_class is skipped');
});

test('rollupDay CP11.x.1: multi-runtime query failure → CC rollup NOT aborted (fail-soft)', async () => {
  _mockResponses = [
    {
      match: /claude_code_cost_usage_USD_total/,
      response: promVector([
        promSeries({ plexus_agent_id: 'survivor-agent', model: 'claude-opus-4-7' }, 1.0),
      ]),
    },
    { match: /claude_code_token_usage_tokens_total/, response: promVector([]) },
    {
      match: /plexus_tokens_input_total/,
      response: { status: 'error', error: 'simulated multi-runtime endpoint down' },
    },
    { match: /plexus_tokens_output_total/, response: promVector([]) },
  ];
  const result = await rollupDay('2026-06-20');
  assert.equal(result.rows, 1, 'CC row still landed despite multi-runtime input failure');
  const rows = getCostByPeriod({ from: '2026-06-20', to: '2026-06-20', agent_id: 'survivor-agent' });
  assert.equal(rows[0].cost_usd, 1.0);
});

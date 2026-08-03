// CP11.1 (2026-06-04): cost-persistence helpers test suite.
// Tests the Phase 1 substrate pre-staged per Jon-direct "do not stop until
// #cost has been updated and ready for review." Schema + helpers only;
// rollup/API/dashboard arrive in Phase 2/3/4 post ADR-0029 ratify.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-cost-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.NODE_ENV = 'test';

const {
  closeDb,
  upsertCostDaily, getCostByPeriod,
  upsertCostDimensionTags, getCostDimensionTags,
  upsertCostBudget, getCostBudgets,
  insertCostReconciliation, listCostReconciliations,
} = require('../src/db');

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// ─── cost_daily UPSERT semantics ───────────────────────────────────────

test('cost_daily: insert + read back', () => {
  upsertCostDaily({
    date: '2026-06-04', agent_id: 'agent-a', user_email: 'a@example.com',
    model: 'claude-opus-4-7', cost_center: 'eng-ops',
    tokens_input: 1000, tokens_output: 500, cost_usd: 0.12,
  });
  const rows = getCostByPeriod({ from: '2026-06-04', to: '2026-06-04' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent_id, 'agent-a');
  assert.equal(rows[0].cost_usd, 0.12);
  assert.equal(rows[0].cost_center, 'eng-ops');
});

test('cost_daily: UPSERT idempotent on full dim-tuple — second write replaces values', () => {
  upsertCostDaily({
    date: '2026-06-04', agent_id: 'agent-a', user_email: 'a@example.com',
    model: 'claude-opus-4-7', cost_center: 'eng-ops',
    tokens_input: 1000, tokens_output: 500, cost_usd: 0.12,
  });
  // Same dim-tuple, different values — should REPLACE the prior row
  upsertCostDaily({
    date: '2026-06-04', agent_id: 'agent-a', user_email: 'a@example.com',
    model: 'claude-opus-4-7', cost_center: 'eng-ops',
    tokens_input: 2000, tokens_output: 1000, cost_usd: 0.25,
  });
  const rows = getCostByPeriod({ from: '2026-06-04', to: '2026-06-04', agent_id: 'agent-a' });
  assert.equal(rows.length, 1, 'still 1 row after re-UPSERT');
  assert.equal(rows[0].cost_usd, 0.25, 'value updated to latest');
  assert.equal(rows[0].tokens_input, 2000);
});

test('cost_daily: different cost_center → separate rows (dim-tuple expansion)', () => {
  upsertCostDaily({
    date: '2026-06-05', agent_id: 'agent-b', cost_center: 'eng-ops', cost_usd: 1.0,
  });
  upsertCostDaily({
    date: '2026-06-05', agent_id: 'agent-b', cost_center: 'gamedev', cost_usd: 2.0,
  });
  const rows = getCostByPeriod({ from: '2026-06-05', to: '2026-06-05', agent_id: 'agent-b' });
  assert.equal(rows.length, 2);
  const total = rows.reduce((s, r) => s + r.cost_usd, 0);
  assert.equal(total, 3.0);
});

test('cost_daily: empty-string defaults distinguish unallocated', () => {
  upsertCostDaily({
    date: '2026-06-06', agent_id: 'agent-c', cost_usd: 0.5,
    // cost_center / project_tag / etc. omitted → all default to ''
  });
  const rows = getCostByPeriod({ from: '2026-06-06', to: '2026-06-06', agent_id: 'agent-c' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cost_center, '');
  assert.equal(rows[0].project_tag, '');
  assert.equal(rows[0].billable_flag, 0);
});

test('cost_daily: getCostByPeriod date-range filter works', () => {
  upsertCostDaily({ date: '2026-05-01', agent_id: 'd1', cost_usd: 1 });
  upsertCostDaily({ date: '2026-05-15', agent_id: 'd1', cost_usd: 2 });
  upsertCostDaily({ date: '2026-05-30', agent_id: 'd1', cost_usd: 3 });
  const may2hMonth = getCostByPeriod({ from: '2026-05-01', to: '2026-05-31', agent_id: 'd1' });
  assert.equal(may2hMonth.length, 3);
  const mid = getCostByPeriod({ from: '2026-05-10', to: '2026-05-20', agent_id: 'd1' });
  assert.equal(mid.length, 1);
  assert.equal(mid[0].cost_usd, 2);
});

test('cost_daily: getCostByPeriod cost_center filter', () => {
  // Already seeded above with cost_center='eng-ops' rows
  const eng = getCostByPeriod({ from: '2026-06-04', to: '2026-06-05', cost_center: 'eng-ops' });
  assert.ok(eng.every(r => r.cost_center === 'eng-ops'));
  assert.ok(eng.length >= 2);
});

test('cost_daily: missing required date → throws', () => {
  assert.throws(() => upsertCostDaily({ agent_id: 'x' }), /date is required/);
});

// ─── cost_dimension_tags forward-propagation ───────────────────────────

test('cost_dimension_tags: upsert + read back per agent', () => {
  upsertCostDimensionTags({
    agent_id: 'agent-a',
    cost_center: 'eng-ops', project_tag: 'yaklog', environment_tier: 'prod',
    billable_flag: 0, updated_by: 'jon',
  });
  const t = getCostDimensionTags('agent-a');
  assert.equal(t.cost_center, 'eng-ops');
  assert.equal(t.project_tag, 'yaklog');
  assert.equal(t.environment_tier, 'prod');
  assert.equal(t.billable_flag, 0);
});

test('cost_dimension_tags: upsert overwrites existing tag set', () => {
  upsertCostDimensionTags({ agent_id: 'agent-a', cost_center: 'bizdev', updated_by: 'jon' });
  const t = getCostDimensionTags('agent-a');
  assert.equal(t.cost_center, 'bizdev');
});

test('cost_dimension_tags: get all when agent_id omitted', () => {
  const all = getCostDimensionTags();
  assert.ok(Array.isArray(all));
  assert.ok(all.length >= 1);
});

test('cost_dimension_tags: unknown agent_id → null', () => {
  assert.equal(getCostDimensionTags('does-not-exist'), null);
});

test('cost_dimension_tags: missing agent_id → throws', () => {
  assert.throws(() => upsertCostDimensionTags({ cost_center: 'x' }), /agent_id is required/);
});

// ─── cost_budgets envelopes ────────────────────────────────────────────

test('cost_budgets: insert monthly envelope', () => {
  upsertCostBudget({
    cost_center: 'eng-ops', period_kind: 'monthly', period_anchor: '2026-06',
    budget_usd: 5000, carry_over: 'strict', updated_by: 'jon',
  });
  const b = getCostBudgets({ cost_center: 'eng-ops', period_kind: 'monthly', period_anchor: '2026-06' });
  assert.equal(b.length, 1);
  assert.equal(b[0].budget_usd, 5000);
  assert.equal(b[0].carry_over, 'strict');
  assert.equal(b[0].threshold_pct_warn, 80);  // default
  assert.equal(b[0].threshold_pct_at, 100);
  assert.equal(b[0].threshold_pct_over, 120);
});

test('cost_budgets: upsert overwrites budget_usd + thresholds + carry_over', () => {
  upsertCostBudget({
    cost_center: 'eng-ops', period_kind: 'monthly', period_anchor: '2026-06',
    budget_usd: 6000, carry_over: 'carry_balance',
    threshold_pct_warn: 75, threshold_pct_at: 100, threshold_pct_over: 130,
  });
  const b = getCostBudgets({ cost_center: 'eng-ops', period_kind: 'monthly', period_anchor: '2026-06' });
  assert.equal(b[0].budget_usd, 6000);
  assert.equal(b[0].carry_over, 'carry_balance');
  assert.equal(b[0].threshold_pct_warn, 75);
  assert.equal(b[0].threshold_pct_over, 130);
});

test('cost_budgets: cluster-wide envelope (empty cost_center)', () => {
  upsertCostBudget({
    cost_center: '', period_kind: 'monthly', period_anchor: '2026-06',
    budget_usd: 10000,
  });
  const b = getCostBudgets({ cost_center: '', period_kind: 'monthly', period_anchor: '2026-06' });
  assert.equal(b.length, 1);
  assert.equal(b[0].cost_center, '');
});

test('cost_budgets: invalid period_kind → throws', () => {
  assert.throws(
    () => upsertCostBudget({ cost_center: 'x', period_kind: 'weekly', period_anchor: '2026-06', budget_usd: 100 }),
    /period_kind must be one of/
  );
});

test('cost_budgets: negative budget_usd → throws', () => {
  assert.throws(
    () => upsertCostBudget({ cost_center: 'x', period_kind: 'monthly', period_anchor: '2026-06', budget_usd: -1 }),
    /budget_usd must be non-negative/
  );
});

// ─── cost_reconciliation append-only ───────────────────────────────────

test('cost_reconciliation: insert + computed delta_usd + delta_pct', () => {
  const r = insertCostReconciliation({
    period_start: '2026-05-01', period_end: '2026-05-31',
    invoice_label: 'Anthropic May 2026',
    invoice_total_usd: 1100.0, yaklog_total_usd: 1000.0,
    reconciled_by: 'ops-key-abc',
  });
  assert.ok(r.id > 0);
  assert.equal(r.delta_usd, 100);
  assert.equal(r.delta_pct, 10);  // 100/1000 = 10%
});

test('cost_reconciliation: list returns newest first', () => {
  insertCostReconciliation({
    period_start: '2026-04-01', period_end: '2026-04-30',
    invoice_total_usd: 800, yaklog_total_usd: 820,  // negative delta (invoice < yaklog)
    reconciled_by: 'ops-key-xyz',
  });
  const rows = listCostReconciliations();
  assert.ok(rows.length >= 2);
  // Newest first
  assert.ok(rows[0].id > rows[1].id);
});

test('cost_reconciliation: division-by-zero handled (yaklog_total=0)', () => {
  const r = insertCostReconciliation({
    period_start: '2026-03-01', period_end: '2026-03-31',
    invoice_total_usd: 100, yaklog_total_usd: 0,
    reconciled_by: 'ops-key',
  });
  assert.equal(r.delta_pct, 100);  // fallback for div-by-zero with non-zero invoice
});

test('cost_reconciliation: both zero → delta_pct = 0', () => {
  const r = insertCostReconciliation({
    period_start: '2026-02-01', period_end: '2026-02-28',
    invoice_total_usd: 0, yaklog_total_usd: 0,
    reconciled_by: 'ops-key',
  });
  assert.equal(r.delta_pct, 0);
});

test('cost_reconciliation: concentration_json accepts object or string', () => {
  insertCostReconciliation({
    period_start: '2026-01-01', period_end: '2026-01-31',
    invoice_total_usd: 100, yaklog_total_usd: 90,
    concentration_json: { top_dim: 'cost_center', top_value: 'eng-ops', divergence_usd: 8 },
    reconciled_by: 'ops-key',
  });
  const rows = listCostReconciliations({ limit: 1 });
  const j = JSON.parse(rows[0].concentration_json);
  assert.equal(j.top_dim, 'cost_center');
  assert.equal(j.divergence_usd, 8);
});

test('cost_reconciliation: missing reconciled_by → throws', () => {
  assert.throws(
    () => insertCostReconciliation({
      period_start: '2026-01-01', period_end: '2026-01-31',
      invoice_total_usd: 100, yaklog_total_usd: 90,
    }),
    /reconciled_by required/
  );
});

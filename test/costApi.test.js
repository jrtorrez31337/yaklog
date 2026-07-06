// CP11.3 (2026-06-04): Phase 3 cost API endpoint tests.
// Tests the 9 public read + 3 ops-key mutation endpoints + costQuery helpers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaklog-costapi-test-'));
process.env.YAKLOG_DB_PATH = path.join(tempDir, 'yaklog.db');
process.env.YAKLOG_API_KEYS = 'test-key';
process.env.YAKLOG_OPS_API_KEYS = 'ops-key-secret';
process.env.YAKLOG_COST_ROLLUP_DISABLED = '1';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const {
  closeDb,
  upsertCostDaily,
  upsertCostBudget,
} = require('../src/db');
const costQuery = require('../src/costQuery');

const auth = { Authorization: 'Bearer test-key' };
const opsAuth = { Authorization: 'Bearer ops-key-secret' };

test.after(() => {
  closeDb();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

// Seed cost_daily with a few days of data (relative to today so periods land correctly)
const today = costQuery._internal.todayUtc();
const T = (offsetDays) => costQuery._internal.ymd(new Date(Date.now() - offsetDays * 86400_000));

// Month-boundary-aware helper for mtd assertions per secops #11256 root-cause fix
// (Jon-direct #11262). Returns true if `T(offset)` falls in the current calendar
// month — used so mtd-scoped assertions don't fail on the 1st when yesterday
// (T(1)) or older offsets straddle into last month.
const _isInCurrentMonth = (offsetDays) => {
  const d = new Date(Date.now() - offsetDays * 86400_000);
  const now = new Date();
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
};
// Sum of seeded rows that would fall in current-month for eng-ops cost-center:
// T(0)=7 always in-month; T(1)=15 depends; T(3)=40 depends.
const _mtdEngOpsExpected = 7 + (_isInCurrentMonth(1) ? 15 : 0) + (_isInCurrentMonth(3) ? 40 : 0);

test('seed: insert test cost_daily rows', () => {
  // Today: $10 across 2 agents
  upsertCostDaily({ date: T(0), agent_id: 'agent-a', model: 'opus', cost_usd: 7, cost_center: 'eng-ops' });
  upsertCostDaily({ date: T(0), agent_id: 'agent-b', model: 'sonnet', cost_usd: 3, cost_center: 'gamedev' });
  // Yesterday: $20
  upsertCostDaily({ date: T(1), agent_id: 'agent-a', model: 'opus', cost_usd: 15, cost_center: 'eng-ops' });
  upsertCostDaily({ date: T(1), agent_id: 'agent-b', model: 'sonnet', cost_usd: 5, cost_center: 'gamedev' });
  // 3 days ago: $40
  upsertCostDaily({ date: T(3), agent_id: 'agent-a', model: 'opus', cost_usd: 40, cost_center: 'eng-ops' });
  // 10 days ago: $100 (for 30d but not 7d)
  upsertCostDaily({ date: T(10), agent_id: 'agent-c', model: 'haiku', cost_usd: 100 });
  // 40 days ago: $500 (for last-month-ish, not in current month)
  upsertCostDaily({ date: T(40), agent_id: 'agent-d', model: 'opus', cost_usd: 500 });

  // Budget for eng-ops cost-center current month
  const periodAnchor = today.slice(0, 7);
  upsertCostBudget({
    cost_center: 'eng-ops', period_kind: 'monthly', period_anchor: periodAnchor,
    budget_usd: 50, threshold_pct_warn: 80, threshold_pct_at: 100, threshold_pct_over: 120,
  });

  assert.ok(true);
});

// ─── /cost/summary ─────────────────────────────────────────────────────

test('GET /cost/summary?period=today → sums today only', async () => {
  const r = await request(app).get('/api/v1/plexus/public/cost/summary?period=today');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.value_usd, 10);
  assert.equal(r.body.period, 'today');
});

test('GET /cost/summary?period=7d → sums last 7 days', async () => {
  const r = await request(app).get('/api/v1/plexus/public/cost/summary?period=7d');
  assert.equal(r.statusCode, 200);
  // today (10) + yesterday (20) + 3-days-ago (40) = 70
  assert.equal(r.body.value_usd, 70);
});

test('GET /cost/summary?period=30d → includes 10-days-ago row', async () => {
  const r = await request(app).get('/api/v1/plexus/public/cost/summary?period=30d');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.value_usd, 170);  // 70 + 100
});

test('GET /cost/summary?period=invalid → 400', async () => {
  const r = await request(app).get('/api/v1/plexus/public/cost/summary?period=bogus');
  assert.equal(r.statusCode, 400);
});

// ─── /cost/daily ───────────────────────────────────────────────────────

test('GET /cost/daily?from&to → returns raw rows', async () => {
  const r = await request(app).get(`/api/v1/plexus/public/cost/daily?from=${T(1)}&to=${T(0)}`);
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.rows.length >= 4);  // 2 agents × 2 days
});

test('GET /cost/daily?from&to&by=cost_center → groups by dim', async () => {
  const r = await request(app).get(`/api/v1/plexus/public/cost/daily?from=${T(3)}&to=${T(0)}&by=cost_center`);
  assert.equal(r.statusCode, 200);
  const eng = r.body.rows.find(g => g.cost_center === 'eng-ops');
  const game = r.body.rows.find(g => g.cost_center === 'gamedev');
  assert.equal(eng.cost_usd, 62);  // 7 + 15 + 40
  assert.equal(game.cost_usd, 8);  // 3 + 5
});

// Task #264 Phase 2.7 (Jon-direct 2026-07-06): days_active field for
// agent-account timeline view — count distinct dates the group had activity.
test('GET /cost/daily?by=agent_id → grouped rows include days_active count', async () => {
  const r = await request(app).get(`/api/v1/plexus/public/cost/daily?from=${T(3)}&to=${T(0)}&by=agent_id`);
  assert.equal(r.statusCode, 200);
  for (const row of r.body.rows) {
    assert.ok(Number.isInteger(row.days_active), `days_active must be integer (got ${row.days_active})`);
    assert.ok(row.days_active >= 1, 'days_active must be >= 1 for any grouped row');
    // date_min/date_max shape preserved
    assert.match(row.date_min, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(row.date_max, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('GET /cost/daily?by=invalid_dim → 400', async () => {
  const r = await request(app).get(`/api/v1/plexus/public/cost/daily?from=${T(1)}&to=${T(0)}&by=nope`);
  assert.equal(r.statusCode, 400);
});

test('GET /cost/daily?missing-from → 400', async () => {
  const r = await request(app).get('/api/v1/plexus/public/cost/daily?to=2026-06-04');
  assert.equal(r.statusCode, 400);
});

// ─── /cost/projection ──────────────────────────────────────────────────

test('GET /cost/projection?period=eom → linear extrapolation', async () => {
  const r = await request(app).get('/api/v1/plexus/public/cost/projection?period=eom');
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.projected_usd >= 0);
  assert.ok(r.body.current_usd >= 0);
  assert.ok(r.body.basis_label.startsWith('Linear projection'));
});

test('GET /cost/projection?period=invalid → 400', async () => {
  const r = await request(app).get('/api/v1/plexus/public/cost/projection?period=nope');
  assert.equal(r.statusCode, 400);
});

// ─── /cost/compare ─────────────────────────────────────────────────────

test('GET /cost/compare?period=mtd&compare_to=last_month_to_date → delta', async () => {
  const r = await request(app).get('/api/v1/plexus/public/cost/compare?period=mtd&compare_to=last_month_to_date');
  assert.equal(r.statusCode, 200);
  assert.ok(typeof r.body.delta_usd === 'number');
  assert.ok(typeof r.body.delta_pct === 'number');
  assert.ok(r.body.current.value_usd >= 0);
  assert.ok(r.body.compare.value_usd >= 0);
});

// ─── /cost/burn-vs-budget ──────────────────────────────────────────────

test('GET /cost/burn-vs-budget?cost_center=eng-ops → returns burn state', async () => {
  const r = await request(app).get('/api/v1/plexus/public/cost/burn-vs-budget?cost_center=eng-ops&period_kind=monthly');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.cost_center, 'eng-ops');
  assert.equal(r.body.budget_usd, 50);
  // Boundary-aware: 7 (today, always in-month) + 15 (yest, if in-month) + 40 (3d-ago, if in-month)
  assert.ok(r.body.actual_usd >= _mtdEngOpsExpected, `actual_usd=${r.body.actual_usd} expected>=${_mtdEngOpsExpected}`);
  assert.ok(['green', 'warn', 'at', 'over'].includes(r.body.threshold_state));
});

test('GET /cost/burn-vs-budget?cost_center=no-budget → threshold_state=no-budget', async () => {
  const r = await request(app).get('/api/v1/plexus/public/cost/burn-vs-budget?cost_center=no-such-center');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.threshold_state, 'no-budget');
  assert.equal(r.body.budget_usd, null);
});

test('GET /cost/burn-vs-budget?period_kind=weekly → 400', async () => {
  const r = await request(app).get('/api/v1/plexus/public/cost/burn-vs-budget?cost_center=x&period_kind=weekly');
  assert.equal(r.statusCode, 400);
});

// ─── /cost/by-cost-center ──────────────────────────────────────────────

test('GET /cost/by-cost-center?period=mtd → CC breakdown with budgets', async () => {
  const r = await request(app).get('/api/v1/plexus/public/cost/by-cost-center?period=mtd');
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.rows.length >= 2);
  const eng = r.body.rows.find(row => row.cost_center === 'eng-ops');
  // Boundary-aware per secops #11256: T(0) always in-month; T(1)+T(3) may not
  assert.ok(eng.actual_usd >= _mtdEngOpsExpected, `eng.actual_usd=${eng.actual_usd} expected>=${_mtdEngOpsExpected}`);
  assert.equal(eng.budget_usd, 50);
});

// ─── /cost/by-api-key ──────────────────────────────────────────────────

test('GET /cost/by-api-key?period_start&period_end → per-API-key totals', async () => {
  const r = await request(app).get(`/api/v1/plexus/public/cost/by-api-key?period_start=${T(3)}&period_end=${T(0)}`);
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.rows.length >= 2);
  assert.ok(r.body.rows.every(g => typeof g.total_usd === 'number'));
});

// ─── /cost/anomaly-detail ──────────────────────────────────────────────

test('GET /cost/anomaly-detail?date → day-vs-baseline analysis', async () => {
  const r = await request(app).get(`/api/v1/plexus/public/cost/anomaly-detail?date=${T(0)}`);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.date, T(0));
  assert.ok(r.body.top_contributors.length >= 1);
  assert.ok(typeof r.body.day_total_usd === 'number');
});

test('GET /cost/anomaly-detail?dim_key=invalid → 400', async () => {
  const r = await request(app).get(`/api/v1/plexus/public/cost/anomaly-detail?date=${T(0)}&dim_key=garbage`);
  assert.equal(r.statusCode, 400);
});

// ─── /cost/export ──────────────────────────────────────────────────────

test('GET /cost/export?format=csv&period=mtd → CSV stream', async () => {
  const r = await request(app).get('/api/v1/plexus/public/cost/export?format=csv&period=mtd');
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  assert.match(r.text, /^date,/);  // default header begins with 'date'
});

test('GET /cost/export?schema=anthropic-invoice → invoice-shaped CSV', async () => {
  const r = await request(app).get('/api/v1/plexus/public/cost/export?format=csv&period=mtd&schema=anthropic-invoice');
  assert.equal(r.statusCode, 200);
  assert.match(r.text, /^period_start,period_end,api_key_label,model,input_tokens/);
});

test('GET /cost/export?format=json → 400 (only csv v1)', async () => {
  const r = await request(app).get('/api/v1/plexus/public/cost/export?format=json&period=mtd');
  assert.equal(r.statusCode, 400);
});

// ─── /ops/cost/dimension-tag ───────────────────────────────────────────

test('PUT /ops/cost/dimension-tag (ops-key) → upsert', async () => {
  const r = await request(app).put('/api/v1/ops/cost/dimension-tag').set(opsAuth).send({
    agent_id: 'agent-x', cost_center: 'platform', project_tag: 'plexus',
    environment_tier: 'prod', billable_flag: true,
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
});

test('PUT /ops/cost/dimension-tag (no ops-key) → 403', async () => {
  const r = await request(app).put('/api/v1/ops/cost/dimension-tag').set(auth).send({ agent_id: 'x' });
  assert.equal(r.statusCode, 403);
});

test('PUT /ops/cost/dimension-tag missing agent_id → 400', async () => {
  const r = await request(app).put('/api/v1/ops/cost/dimension-tag').set(opsAuth).send({});
  assert.equal(r.statusCode, 400);
});

// ─── /ops/cost/budget ──────────────────────────────────────────────────

test('PUT /ops/cost/budget → upsert', async () => {
  const r = await request(app).put('/api/v1/ops/cost/budget').set(opsAuth).send({
    cost_center: 'platform', period_kind: 'monthly', period_anchor: '2026-07',
    budget_usd: 100, carry_over: 'strict',
  });
  assert.equal(r.statusCode, 200);
});

test('PUT /ops/cost/budget invalid period_kind → 400', async () => {
  const r = await request(app).put('/api/v1/ops/cost/budget').set(opsAuth).send({
    cost_center: 'x', period_kind: 'weekly', period_anchor: '2026-07', budget_usd: 100,
  });
  assert.equal(r.statusCode, 400);
});

// ─── /ops/cost/reconcile ───────────────────────────────────────────────

test('POST /ops/cost/reconcile → insert + delta computed + concentration', async () => {
  const r = await request(app).post('/api/v1/ops/cost/reconcile').set(opsAuth).send({
    period_start: T(3), period_end: T(0),
    invoice_label: 'test invoice', invoice_total_usd: 80,
  });
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.id > 0);
  assert.equal(r.body.plexus_total_usd, 70);  // sum of T(0)+T(1)+T(3): 10+20+40
  assert.equal(r.body.delta_usd, 10);  // 80 invoice - 70 plexus
  assert.ok(Array.isArray(r.body.top_dims));
});

test('POST /ops/cost/reconcile missing period_start → 400', async () => {
  const r = await request(app).post('/api/v1/ops/cost/reconcile').set(opsAuth).send({
    invoice_total_usd: 100,
  });
  assert.equal(r.statusCode, 400);
});

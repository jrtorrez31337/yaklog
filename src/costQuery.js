// CP11.3 (2026-06-04): Phase 3 helper — calendar period math + hybrid
// persisted+live cost computation. Used by the public read endpoints
// + ops-key mutation endpoints + future dashboard tiles.
//
// Per ratified ADR-0029 v2.3: SQLite cost_daily is canon for periods
// extending past current day; Prom is the live tail for today's
// elapsed-since-last-rollup window.

const config = require('./config');
const { getCostByPeriod, getCostBudgets } = require('./db');

// ── Date helpers (UTC throughout) ──────────────────────────────────────

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}
function ymd(d) { return d.toISOString().slice(0, 10); }

function startOfMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function startOfQuarter(d = new Date()) {
  const q = Math.floor(d.getUTCMonth() / 3);
  return new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1));
}
function startOfYear(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}
function endOfMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));  // day 0 of next = last of this
}
function endOfQuarter(d = new Date()) {
  const q = Math.floor(d.getUTCMonth() / 3);
  return new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0));
}
function endOfYear(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), 11, 31));
}
function daysBetween(fromDate, toDate) {
  return Math.floor((toDate - fromDate) / 86400_000) + 1;
}

// Fiscal-period config (cluster-wide per OQ#9 CONCUR). Default Jan-Dec
// (matches calendar); override via YAKLOG_FISCAL_YEAR_START_MONTH env
// (1-12; 1=January, 4=April-March fiscal, etc.).
const FISCAL_YEAR_START_MONTH = Math.max(1, Math.min(12,
  parseInt(process.env.YAKLOG_FISCAL_YEAR_START_MONTH || '1', 10) || 1));

function fiscalYearStart(d = new Date()) {
  let year = d.getUTCFullYear();
  if (d.getUTCMonth() < FISCAL_YEAR_START_MONTH - 1) year -= 1;
  return new Date(Date.UTC(year, FISCAL_YEAR_START_MONTH - 1, 1));
}
function fiscalQuarterStart(d = new Date()) {
  const fyStart = fiscalYearStart(d);
  const monthsSinceFyStart = (d.getUTCFullYear() - fyStart.getUTCFullYear()) * 12 + d.getUTCMonth() - fyStart.getUTCMonth();
  const fq = Math.floor(monthsSinceFyStart / 3);
  return new Date(Date.UTC(fyStart.getUTCFullYear(), fyStart.getUTCMonth() + fq * 3, 1));
}
function fiscalYearEnd(d = new Date()) {
  const start = fiscalYearStart(d);
  return new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), 0));
}
function fiscalQuarterEnd(d = new Date()) {
  const start = fiscalQuarterStart(d);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, 0));
}

// Resolve period name → { from: YYYY-MM-DD, to: YYYY-MM-DD, label }.
// `to` is INCLUSIVE upper-bound (matches getCostByPeriod's date <= to).
function periodToRange(period, now = new Date()) {
  const today = ymd(now);
  switch (period) {
    case 'today':        return { from: today, to: today, label: 'today (UTC)' };
    case '7d': {
      const from = ymd(new Date(now - 6 * 86400_000));  // includes today + 6 prior = 7
      return { from, to: today, label: 'last 7 days' };
    }
    case '30d': {
      const from = ymd(new Date(now - 29 * 86400_000));
      return { from, to: today, label: 'last 30 days' };
    }
    case '90d': {
      const from = ymd(new Date(now - 89 * 86400_000));
      return { from, to: today, label: 'last 90 days' };
    }
    case 'mtd':          return { from: ymd(startOfMonth(now)), to: today, label: 'MTD (UTC)' };
    case 'qtd':          return { from: ymd(startOfQuarter(now)), to: today, label: 'QTD (calendar)' };
    case 'ytd':          return { from: ymd(startOfYear(now)), to: today, label: 'YTD (calendar)' };
    case 'last_month': {
      const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
      const lastMonthStart = new Date(Date.UTC(lastMonthEnd.getUTCFullYear(), lastMonthEnd.getUTCMonth(), 1));
      return { from: ymd(lastMonthStart), to: ymd(lastMonthEnd), label: 'last month' };
    }
    case 'last_month_to_date': {
      // Same day-of-month last month as today, capped at days-in-last-month
      const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const daysInLastMonth = endOfMonth(lastMonth).getUTCDate();
      const todayDom = Math.min(now.getUTCDate(), daysInLastMonth);
      return {
        from: ymd(lastMonth),
        to: ymd(new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth(), todayDom))),
        label: `last month to date (through day ${todayDom})`,
      };
    }
    case 'last_year': {
      const ly = now.getUTCFullYear() - 1;
      return {
        from: ymd(new Date(Date.UTC(ly, 0, 1))),
        to: ymd(new Date(Date.UTC(ly, 11, 31))),
        label: `${ly} (calendar year)`,
      };
    }
    case 'lifetime':     return { from: '1970-01-01', to: today, label: 'lifetime' };
    case 'fiscal-mtd':   return { from: ymd(startOfMonth(now)), to: today, label: 'fiscal MTD' };
    case 'fiscal-qtd':   return { from: ymd(fiscalQuarterStart(now)), to: today, label: 'fiscal QTD' };
    case 'fiscal-ytd':   return { from: ymd(fiscalYearStart(now)), to: today, label: 'fiscal YTD' };
    default:
      throw new Error(`periodToRange: unknown period '${period}'`);
  }
}

function projectionPeriodToRange(period, now = new Date()) {
  switch (period) {
    case 'eom':         return { current_from: ymd(startOfMonth(now)), current_to: ymd(now), period_end: ymd(endOfMonth(now)), label: 'end of month' };
    case 'eoq':         return { current_from: ymd(startOfQuarter(now)), current_to: ymd(now), period_end: ymd(endOfQuarter(now)), label: 'end of quarter' };
    case 'eoy':         return { current_from: ymd(startOfYear(now)), current_to: ymd(now), period_end: ymd(endOfYear(now)), label: 'end of year' };
    case 'fiscal-eom':  return { current_from: ymd(startOfMonth(now)), current_to: ymd(now), period_end: ymd(endOfMonth(now)), label: 'end of fiscal month' };
    case 'fiscal-eoq':  return { current_from: ymd(fiscalQuarterStart(now)), current_to: ymd(now), period_end: ymd(fiscalQuarterEnd(now)), label: 'end of fiscal quarter' };
    case 'fiscal-eoy':  return { current_from: ymd(fiscalYearStart(now)), current_to: ymd(now), period_end: ymd(fiscalYearEnd(now)), label: 'end of fiscal year' };
    default:
      throw new Error(`projectionPeriodToRange: unknown period '${period}'`);
  }
}

// ── Hybrid persisted + live cost summation ─────────────────────────────

// Sum cost_daily over [from, to] with optional dimension filters.
// Returns { value_usd, source, computed_at } where source is one of:
//   - 'persisted+live' (period includes today; live Prom tail folded in)
//   - 'persisted'      (period entirely in past; no live tail)
async function sumCostForRange({ from, to, ...dims }) {
  const rows = getCostByPeriod({ from, to, ...dims });
  let persisted = 0;
  let mostRecentComputed = null;
  for (const r of rows) {
    persisted += r.cost_usd;
    if (!mostRecentComputed || r.computed_at > mostRecentComputed) {
      mostRecentComputed = r.computed_at;
    }
  }

  // If `to` includes today, no live-tail addition needed — intraday rollup
  // covers today's data up to most-recent rollup tick. Operator-visible
  // staleness window = 1h (matches scheduleIntraday default).
  // (Future enhancement: optionally query Prom for the gap between
  // most-recent rollup's computed_at and now. Skipped in v1 per OQ
  // disposition — keeps endpoint simple + idempotent.)
  return {
    value_usd: persisted,
    source: 'persisted',
    computed_at: mostRecentComputed || new Date().toISOString(),
  };
}

// Compute current-period burn-vs-budget for one cost_center.
function burnVsBudget({ cost_center = '', period_kind = 'monthly' }, now = new Date()) {
  const periodAnchor = period_kind === 'monthly'
    ? ymd(now).slice(0, 7)                       // 'YYYY-MM'
    : `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;  // 'YYYY-Qn'

  const budgets = getCostBudgets({ cost_center, period_kind, period_anchor: periodAnchor });
  const budget = budgets[0] || null;

  const range = period_kind === 'monthly'
    ? { from: ymd(startOfMonth(now)), to: ymd(now) }
    : { from: ymd(startOfQuarter(now)), to: ymd(now) };

  const rows = getCostByPeriod({ from: range.from, to: range.to, cost_center });
  const actual = rows.reduce((s, r) => s + r.cost_usd, 0);

  const result = {
    cost_center,
    period_kind,
    period_anchor: periodAnchor,
    actual_usd: actual,
    budget_usd: budget ? budget.budget_usd : null,
    threshold_state: 'no-budget',
  };

  if (budget) {
    const pct = budget.budget_usd > 0 ? (actual / budget.budget_usd) * 100 : 0;
    result.pct_consumed = pct;
    if (pct >= budget.threshold_pct_over) result.threshold_state = 'over';
    else if (pct >= budget.threshold_pct_at) result.threshold_state = 'at';
    else if (pct >= budget.threshold_pct_warn) result.threshold_state = 'warn';
    else result.threshold_state = 'green';

    // Days-of-runway: how many days at current burn rate until envelope exhausted
    const periodEnd = period_kind === 'monthly' ? endOfMonth(now) : endOfQuarter(now);
    const elapsedDays = daysBetween(period_kind === 'monthly' ? startOfMonth(now) : startOfQuarter(now), now);
    const totalPeriodDays = daysBetween(period_kind === 'monthly' ? startOfMonth(now) : startOfQuarter(now), periodEnd);
    const dailyBurn = elapsedDays > 0 ? actual / elapsedDays : 0;
    const remainingUsd = Math.max(0, budget.budget_usd - actual);
    result.daily_burn_usd = dailyBurn;
    result.days_of_runway = dailyBurn > 0 ? remainingUsd / dailyBurn : Infinity;
    result.projected_eop_usd = dailyBurn * totalPeriodDays;
    result.days_elapsed = elapsedDays;
    result.days_in_period = totalPeriodDays;
    if (!Number.isFinite(result.days_of_runway)) result.days_of_runway = null;
  }

  return result;
}

// Project end-of-period USD by linear extrapolation from current pace.
// Per OQ#4 CONCUR (no scenarios) + bizmodel §Q4 (linear only, basis-labeled).
function projectByLinear({ current_from, current_to, period_end }) {
  const rows = getCostByPeriod({ from: current_from, to: current_to });
  const currentUsd = rows.reduce((s, r) => s + r.cost_usd, 0);

  const fromDate = new Date(`${current_from}T00:00:00Z`);
  const toDate = new Date(`${current_to}T00:00:00Z`);
  const periodEndDate = new Date(`${period_end}T00:00:00Z`);

  const elapsedDays = daysBetween(fromDate, toDate);
  const totalPeriodDays = daysBetween(fromDate, periodEndDate);
  const dailyAvg = elapsedDays > 0 ? currentUsd / elapsedDays : 0;
  const projected = dailyAvg * totalPeriodDays;

  return {
    projected_usd: projected,
    current_usd: currentUsd,
    basis_days: elapsedDays,
    basis_avg_per_day: dailyAvg,
    basis_label: `Linear projection from last ${elapsedDays}d`,
    period_start: current_from,
    period_end,
  };
}

module.exports = {
  periodToRange,
  projectionPeriodToRange,
  sumCostForRange,
  burnVsBudget,
  projectByLinear,
  // helpers exported for tests
  _internal: {
    todayUtc, ymd, startOfMonth, startOfQuarter, startOfYear,
    endOfMonth, endOfQuarter, endOfYear, daysBetween,
    fiscalYearStart, fiscalQuarterStart, fiscalYearEnd, fiscalQuarterEnd,
    FISCAL_YEAR_START_MONTH,
  },
};

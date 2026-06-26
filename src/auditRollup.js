// CP16 Pillar audit-rollup driver (2026-06-26). Sister-shape src/costRollup.js
// (Prom-source) BUT direct-SQLite-source since audit_* tables already hold
// canonical rows. Per PLAN-CP16-PILLAR-AUDIT-ROLLUP-SUBSTRATE.md §4.
//
// API:
//   - rollupAuditDay(ymd)               — UPSERT all 3 rollup tables for one
//                                         calendar day (UTC).
//   - rollupAuditWindow({daysBack})     — walk last-N COMPLETE days; current
//                                         day excluded so live-query path
//                                         remains authoritative for "today".
//   - rollupAuditBackfill({daysBack})   — one-shot at deploy; UPSERTs are
//                                         idempotent so this is safe to
//                                         re-run.
//
// Source of truth for control-area + object-class enumeration:
// auditRoutes.CONTROL_AREA_MAP (re-exported below to break circular import).

const {
  upsertAuditDailyByControlArea,
  upsertAuditDailyByObjectClass,
  upsertAuditDailyByAgent,
  countAuditToolInvocations,
  countAuditFileAccess,
  countAuditCredentialChanges,
  countAuditPermissionChanges,
  countAuditAttestations,
  countAuditChannelSubscriptionChanges,
  countPolicyRules,
  countPolicyViolations,
  getDb,
} = require('./db');

// Sister-shape CONTROL_AREA_MAP from auditRoutes.js — duplicated here to
// avoid circular import (auditRoutes → auditRollup → auditRoutes would loop).
// If CONTROL_AREA_MAP changes in auditRoutes, both copies must update.
// Tests assert parity between them.
const CONTROL_AREA_MAP = {
  soc2: [
    { id: 'CC1', audit_object_classes: ['audit_attestation'] },
    { id: 'CC2', audit_object_classes: ['audit_attestation', 'audit_channel_subscription_change'] },
    { id: 'CC6', audit_object_classes: ['audit_permission_change', 'audit_credential_change', 'audit_channel_subscription_change'] },
    { id: 'CC7', audit_object_classes: ['audit_tool_invocation', 'audit_file_access'] },
    { id: 'CC8', audit_object_classes: ['audit_permission_change'] },
    { id: 'CC9', audit_object_classes: ['audit_attestation'] },
  ],
  iso27001: [
    { id: 'A.5',  audit_object_classes: ['policy_rule'] },
    { id: 'A.8',  audit_object_classes: ['audit_file_access'] },
    { id: 'A.9',  audit_object_classes: ['audit_permission_change', 'audit_credential_change', 'audit_channel_subscription_change'] },
    { id: 'A.12', audit_object_classes: ['audit_tool_invocation'] },
    { id: 'A.13', audit_object_classes: ['audit_credential_change'] },
    { id: 'A.16', audit_object_classes: ['policy_violation'] },
    { id: 'A.18', audit_object_classes: ['policy_rule', 'policy_violation'] },
  ],
  gdpr: [
    { id: 'Art.6',  audit_object_classes: ['audit_permission_change'] },
    { id: 'Art.15', audit_object_classes: ['audit_file_access'] },
    { id: 'Art.17', audit_object_classes: ['audit_credential_change'] },
    { id: 'Art.30', audit_object_classes: ['audit_tool_invocation', 'audit_file_access'] },
  ],
};

const AUDIT_OBJECT_CLASSES = [
  'audit_tool_invocation',
  'audit_file_access',
  'audit_credential_change',
  'audit_permission_change',
  'audit_attestation',
  'audit_channel_subscription_change',
  'policy_rule',
  'policy_violation',
];

// Classes that have agent_id columns we can group by (per-agent rollup tier).
const AGENT_AWARE_CLASSES = [
  'audit_tool_invocation',
  'audit_file_access',
  'audit_permission_change',
  'audit_channel_subscription_change',
];

function _todayUtcYmd() {
  return new Date().toISOString().slice(0, 10);
}

function _ymdRange(ymd) {
  return { from: `${ymd}T00:00:00.000Z`, to: `${ymd}T23:59:59.999Z` };
}

// Count rows touching `ymd` for a single object class, optionally scoped to
// a control_area (for audit_attestation per CP12.10 area-scoping discipline).
function _countClassOnDate(cls, ymd, { control_area } = {}) {
  const { from, to } = _ymdRange(ymd);
  switch (cls) {
    case 'audit_tool_invocation':            return countAuditToolInvocations({ from, to });
    case 'audit_file_access':                return countAuditFileAccess({ from, to });
    case 'audit_credential_change':          return countAuditCredentialChanges({ from, to });
    case 'audit_permission_change':          return countAuditPermissionChanges({ from, to });
    case 'audit_attestation':                return countAuditAttestations({ from, to, control_area });
    case 'audit_channel_subscription_change':return countAuditChannelSubscriptionChanges({ from, to });
    case 'policy_rule':                      return countPolicyRules();
    case 'policy_violation':                 return countPolicyViolations({ from, to });
    default:
      throw new Error(`_countClassOnDate: unknown class "${cls}"`);
  }
}

// Per-class per-agent count on date. Returns Map<agent_id, count> for the day.
// Uses direct SQL since count* helpers don't expose group_by.
function _countClassOnDateByAgent(cls, ymd) {
  if (!AGENT_AWARE_CLASSES.includes(cls)) return new Map();
  const { from, to } = _ymdRange(ymd);
  const tableMap = {
    audit_tool_invocation: 'audit_tool_invocation',
    audit_file_access: 'audit_file_access',
    audit_permission_change: 'audit_permission_change',
    audit_channel_subscription_change: 'audit_channel_subscription_change',
  };
  const table = tableMap[cls];
  const rows = getDb().prepare(
    `SELECT agent_id, COUNT(*) AS c FROM ${table}
     WHERE occurred_at >= @from AND occurred_at <= @to
       AND agent_id IS NOT NULL
     GROUP BY agent_id`
  ).all({ from, to });
  const out = new Map();
  for (const r of rows) out.set(r.agent_id, r.c);
  return out;
}

// Roll up one day across all 3 rollup tables. Idempotent: re-call updates
// counts + rolled_up_at. Returns `{by_control_area, by_object_class, by_agent}`
// row counts written (operator visibility).
function rollupAuditDay(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
    throw new Error(`rollupAuditDay: ymd must be YYYY-MM-DD, got "${ymd}"`);
  }
  const rolled_up_at = new Date().toISOString();
  let cca = 0; let coc = 0; let cba = 0;

  // by_control_area: per (framework, area), sum counts across area's classes
  for (const [framework, areas] of Object.entries(CONTROL_AREA_MAP)) {
    for (const area of areas) {
      let count = 0;
      for (const cls of area.audit_object_classes) {
        count += _countClassOnDate(cls, ymd, { control_area: area.id });
      }
      upsertAuditDailyByControlArea({
        occurred_date: ymd,
        control_framework: framework,
        control_area: area.id,
        count,
        rolled_up_at,
      });
      cca++;
    }
  }

  // by_object_class: per class, count rows on the day
  for (const cls of AUDIT_OBJECT_CLASSES) {
    const count = _countClassOnDate(cls, ymd);
    upsertAuditDailyByObjectClass({
      occurred_date: ymd,
      // strip 'audit_' prefix for canonical PLAN §3 vocab
      object_class: cls.replace(/^audit_/, ''),
      count,
      rolled_up_at,
    });
    coc++;
  }

  // by_agent: per (agent, class), count rows on the day (agent-aware classes only)
  for (const cls of AGENT_AWARE_CLASSES) {
    const byAgent = _countClassOnDateByAgent(cls, ymd);
    for (const [agent_id, count] of byAgent) {
      upsertAuditDailyByAgent({
        occurred_date: ymd,
        agent_id,
        object_class: cls.replace(/^audit_/, ''),
        count,
        rolled_up_at,
      });
      cba++;
    }
  }

  return { ymd, rolled_up_at, by_control_area: cca, by_object_class: coc, by_agent: cba };
}

// Walk last-N COMPLETE days backward from yesterday (today excluded so live-
// query path remains authoritative for "today" partial-day). Sister-shape
// costRollup.backfill but bounded by absolute-date arithmetic, not Prom
// retention.
function rollupAuditWindow({ daysBack = 90, endDateExclusive } = {}) {
  if (typeof daysBack !== 'number' || daysBack < 1) {
    throw new Error(`rollupAuditWindow: daysBack must be positive integer, got ${daysBack}`);
  }
  const todayUtc = endDateExclusive || _todayUtcYmd();
  const todayMs = new Date(`${todayUtc}T00:00:00.000Z`).getTime();
  const results = [];
  for (let i = 1; i <= daysBack; i++) {
    const dateMs = todayMs - (i * 86400_000);
    const ymd = new Date(dateMs).toISOString().slice(0, 10);
    results.push(rollupAuditDay(ymd));
  }
  return { window_days: daysBack, end_date_exclusive: todayUtc, rolled: results.length, results };
}

// Backfill alias (clearer name at deploy-time).
function rollupAuditBackfill(opts) {
  return rollupAuditWindow(opts);
}

module.exports = {
  rollupAuditDay,
  rollupAuditWindow,
  rollupAuditBackfill,
  // exported for test parity assertion + future maintainers
  CONTROL_AREA_MAP,
  AUDIT_OBJECT_CLASSES,
  AGENT_AWARE_CLASSES,
};

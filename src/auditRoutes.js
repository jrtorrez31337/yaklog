// CP12.2 (2026-06-04): Phase 1 audit + governance read API surface.
// Implements ratified ADR-0030 v1.1 §5.1 — 15 public read endpoints under
// /api/v1/plexus/public/audit/* and /api/v1/plexus/public/policy/*.
//
// Trust model: network-isolation only (no per-request auth). Mounted via
// publicRouter pattern in src/app.js; mirrors /cost/* posture from
// src/plexusRoutes.js publicRouter.
//
// Period vocabulary: shared with src/costQuery.js periodToRange (single
// source of truth — DRY enforced via import, NOT duplication). If costQuery
// ever loses periodToRange export we add a local mini-copy with a comment.

const express = require('express');
const router = express.Router();

const {
  listAuditToolInvocations,
  getAuditToolInvocationByEventId,
  listAuditFileAccess,
  listAuditCredentialChanges,
  listAuditPermissionChanges,
  listAuditAttestations,
  listPolicyRules,
  getPolicyRule,
  listPolicyViolations,
  listPresence,
  // CP12.13 Phase 2 aggregate views
  listRegistrationEventsByAgent,
  aggregateRegistrationEventsByAgent,
  aggregateCredentialChanges,
  // CP12.15 Phase 2 channel-subscription change history
  listAuditChannelSubscriptionChanges,
} = require('./db');

const costQuery = require('./costQuery');

// ── helpers ───────────────────────────────────────────────────────────────

function clampLimit(raw, def = 100, max = 1000) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

// CP12.14: explicit date-only bounds are expanded to start/end of day in
// ISO form so the SQL lex-compare against occurred_at (which always has a
// time component) doesn't accidentally exclude same-day events. Mirrors the
// period-branch behavior. Fixes bizmodel #7974 + #7976 + #7988 half-open
// to= bug observed across the older /audit/{tool-invocations, file-access,
// credential-changes, permission-changes} endpoints + applies to the
// CP12.13 explicit-bounds code path too. Full-ISO bounds passthrough.
function expandIsoBound(s, endOfDay) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return endOfDay ? `${s}T23:59:59.999Z` : `${s}T00:00:00.000Z`;
  }
  return s;
}

function parseRange(req, { defaultPeriod = null } = {}) {
  // Returns { from, to, period? } resolving either explicit from/to or named period.
  const period = req.query.period ? String(req.query.period) : null;
  const explicitFrom = req.query.from ? String(req.query.from) : null;
  const explicitTo = req.query.to ? String(req.query.to) : null;
  if (period) {
    const r = costQuery.periodToRange(period);
    // Convert YYYY-MM-DD bounds to occurred_at ISO bounds (lex-comparable).
    return { period, from: `${r.from}T00:00:00.000Z`, to: `${r.to}T23:59:59.999Z`, label: r.label };
  }
  if (explicitFrom || explicitTo) {
    return {
      from: expandIsoBound(explicitFrom, false),
      to: expandIsoBound(explicitTo, true),
    };
  }
  if (defaultPeriod) {
    const r = costQuery.periodToRange(defaultPeriod);
    return { period: defaultPeriod, from: `${r.from}T00:00:00.000Z`, to: `${r.to}T23:59:59.999Z`, label: r.label };
  }
  return { from: null, to: null };
}

function badRequest(res, message) {
  return res.status(400).json({ error: 'BadRequest', message });
}
function notFound(res, message) {
  return res.status(404).json({ error: 'NotFound', message });
}
function notImplemented(res, message) {
  return res.status(501).json({ error: 'NotImplemented', message });
}
function safeError(res, e) {
  // No stack traces leak. Keep operator-visible message minimal.
  const msg = e && e.message ? String(e.message).slice(0, 200) : 'internal error';
  return res.status(500).json({ error: 'InternalError', message: msg });
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── control-area mapping (static; ADR-0030 v1.1 expanded subset) ──────────
//
// Each framework lists control areas with friendly name + which Phase-1
// audit-object classes contribute. Phase-2 will fold policy_violation,
// audit_reconciliation, registration-state-machine, subject_directory.
//
// Object-class IDs match table names so callers can drill back to the
// row-level endpoints unambiguously.

const CONTROL_AREA_MAP = {
  soc2: [
    { id: 'CC1', name: 'Control Environment', audit_object_classes: ['audit_attestation'] },
    { id: 'CC2', name: 'Communication & Information', audit_object_classes: ['audit_attestation'] },
    { id: 'CC6', name: 'Logical & Physical Access Controls', audit_object_classes: ['audit_permission_change', 'audit_credential_change', 'audit_channel_subscription_change'] },
    { id: 'CC7', name: 'System Operations', audit_object_classes: ['audit_tool_invocation', 'audit_file_access'] },
    { id: 'CC8', name: 'Change Management', audit_object_classes: ['audit_permission_change'] },
    { id: 'CC9', name: 'Risk Mitigation', audit_object_classes: ['audit_attestation'] },
  ],
  iso27001: [
    { id: 'A.5',  name: 'Information Security Policies', audit_object_classes: ['policy_rule'] },
    { id: 'A.8',  name: 'Asset Management', audit_object_classes: ['audit_file_access'] },
    { id: 'A.9',  name: 'Access Control', audit_object_classes: ['audit_permission_change', 'audit_credential_change', 'audit_channel_subscription_change'] },
    { id: 'A.12', name: 'Operations Security', audit_object_classes: ['audit_tool_invocation'] },
    { id: 'A.13', name: 'Communications Security', audit_object_classes: ['audit_credential_change'] },
    { id: 'A.16', name: 'Information Security Incident Management', audit_object_classes: ['policy_violation'] },
    { id: 'A.18', name: 'Compliance', audit_object_classes: ['policy_rule', 'policy_violation'] },
  ],
  gdpr: [
    { id: 'Art.6',  name: 'Lawfulness of Processing', audit_object_classes: ['audit_permission_change'] },
    { id: 'Art.15', name: 'Right of Access by the Data Subject', audit_object_classes: ['audit_file_access'] },
    { id: 'Art.17', name: 'Right to Erasure', audit_object_classes: ['audit_credential_change'] },
    { id: 'Art.30', name: 'Records of Processing Activities', audit_object_classes: ['audit_tool_invocation', 'audit_file_access'] },
  ],
};

function countsForObjectClasses(classes, { from, to, control_area } = {}) {
  // Single-class fast paths: invoke the helper with a large limit and count.
  // Phase 1 cap: 10k rows per class per period is empirically safe for the
  // dashboards we ship; if rollup hits this ceiling we move counts into SQL.
  // CP12.10: audit_attestation rows are filtered by control_area so a CC1
  // attestation doesn't inflate CC2's count.
  const limit = 10000;
  let total = 0;
  for (const cls of classes) {
    if (cls === 'audit_tool_invocation') {
      total += listAuditToolInvocations({ from, to, limit }).length;
    } else if (cls === 'audit_file_access') {
      total += listAuditFileAccess({ from, to, limit }).length;
    } else if (cls === 'audit_credential_change') {
      total += listAuditCredentialChanges({ from, to, limit }).length;
    } else if (cls === 'audit_permission_change') {
      total += listAuditPermissionChanges({ from, to, limit }).length;
    } else if (cls === 'audit_attestation') {
      total += listAuditAttestations({ from, to, control_area, limit }).length;
    } else if (cls === 'audit_channel_subscription_change') {
      total += listAuditChannelSubscriptionChanges({ from, to, limit }).length;
    } else if (cls === 'policy_rule') {
      total += listPolicyRules().length;
    } else if (cls === 'policy_violation') {
      total += listPolicyViolations({ from, to, limit }).length;
    }
  }
  return total;
}

// ──────────────────────────────────────────────────────────────────────────
// 1. GET /audit/summary
// ──────────────────────────────────────────────────────────────────────────

router.get('/audit/summary', (req, res) => {
  const period = req.query.period ? String(req.query.period) : 'mtd';
  try {
    const r = costQuery.periodToRange(period);
    const from = `${r.from}T00:00:00.000Z`;
    const to = `${r.to}T23:59:59.999Z`;
    const limit = 10000;
    const counts = {
      tool_invocations:    listAuditToolInvocations({ from, to, limit }).length,
      file_accesses:       listAuditFileAccess({ from, to, limit }).length,
      credential_changes:  listAuditCredentialChanges({ from, to, limit }).length,
      permission_changes:  listAuditPermissionChanges({ from, to, limit }).length,
      policy_violations:   listPolicyViolations({ from, to, limit }).length,
    };
    return res.json({
      period,
      from: r.from,
      to: r.to,
      label: r.label,
      counts,
      source: 'persisted',
      computed_at: new Date().toISOString(),
    });
  } catch (e) {
    if (/unknown period/.test(e.message)) return badRequest(res, e.message);
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 2. GET /audit/tool-invocations
// ──────────────────────────────────────────────────────────────────────────

router.get('/audit/tool-invocations', (req, res) => {
  try {
    const { from, to } = parseRange(req);
    const rows = listAuditToolInvocations({
      from, to,
      agent_id: req.query.agent ? String(req.query.agent) : undefined,
      tool_name: req.query.tool ? String(req.query.tool) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      limit: clampLimit(req.query.limit),
    });
    return res.json({ rows, count: rows.length });
  } catch (e) {
    if (/unknown period/.test(e.message)) return badRequest(res, e.message);
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 3. GET /audit/file-access
// ──────────────────────────────────────────────────────────────────────────

router.get('/audit/file-access', (req, res) => {
  try {
    const { from, to } = parseRange(req);
    const rows = listAuditFileAccess({
      from, to,
      agent_id: req.query.agent ? String(req.query.agent) : undefined,
      path_prefix: req.query.path_prefix ? String(req.query.path_prefix) : undefined,
      limit: clampLimit(req.query.limit),
    });
    return res.json({ rows, count: rows.length });
  } catch (e) {
    if (/unknown period/.test(e.message)) return badRequest(res, e.message);
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 4b. GET /audit/channel-subscriptions (CP12.15 Phase 2)
// ──────────────────────────────────────────────────────────────────────────

router.get('/audit/channel-subscriptions', (req, res) => {
  try {
    const { from, to } = parseRange(req);
    const rows = listAuditChannelSubscriptionChanges({
      from, to,
      agent_id: req.query.agent ? String(req.query.agent) : undefined,
      channel_name: req.query.channel ? String(req.query.channel) : undefined,
      limit: clampLimit(req.query.limit),
    });
    return res.json({ rows, count: rows.length });
  } catch (e) {
    if (/unknown period/.test(e.message)) return badRequest(res, e.message);
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 4. GET /audit/credential-changes
// ──────────────────────────────────────────────────────────────────────────

router.get('/audit/credential-changes', (req, res) => {
  try {
    const { from, to } = parseRange(req);
    const rows = listAuditCredentialChanges({
      from, to,
      credential_class: req.query.credential_class ? String(req.query.credential_class) : undefined,
      limit: clampLimit(req.query.limit),
    });
    return res.json({ rows, count: rows.length });
  } catch (e) {
    if (/unknown period/.test(e.message)) return badRequest(res, e.message);
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 5. GET /audit/permission-changes
// ──────────────────────────────────────────────────────────────────────────

router.get('/audit/permission-changes', (req, res) => {
  try {
    const { from, to } = parseRange(req);
    const rows = listAuditPermissionChanges({
      from, to,
      agent_id: req.query.agent ? String(req.query.agent) : undefined,
      limit: clampLimit(req.query.limit),
    });
    return res.json({ rows, count: rows.length });
  } catch (e) {
    if (/unknown period/.test(e.message)) return badRequest(res, e.message);
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 6. GET /audit/event/:event_id
// Phase 1 scope: lookup against audit_tool_invocation only. Other tables
// can be folded in once helpers grow getByEventId equivalents.
// ──────────────────────────────────────────────────────────────────────────

router.get('/audit/event/:event_id', (req, res) => {
  try {
    const row = getAuditToolInvocationByEventId(String(req.params.event_id));
    if (!row) return notFound(res, `event_id ${req.params.event_id} not found`);
    return res.json(row);
  } catch (e) {
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 7. GET /audit/agent-timeline
// Merges all 4 audit-object classes for one agent into a single time-DESC
// stream. JS merge (not SQL UNION) because helpers return class-shaped
// rows with differing columns — JS preserves shape via _class tag.
// ──────────────────────────────────────────────────────────────────────────

router.get('/audit/agent-timeline', (req, res) => {
  try {
    const agent = req.query.agent ? String(req.query.agent) : null;
    if (!agent) return badRequest(res, 'agent query param is required');
    const { from, to } = parseRange(req);
    const limit = clampLimit(req.query.limit);

    const fetchLimit = Math.max(limit * 4, 400);  // headroom across 4 classes
    const ti = listAuditToolInvocations({ from, to, agent_id: agent, limit: fetchLimit })
      .map(r => ({ _class: 'audit_tool_invocation', ...r }));
    const fa = listAuditFileAccess({ from, to, agent_id: agent, limit: fetchLimit })
      .map(r => ({ _class: 'audit_file_access', ...r }));
    // credential_change has no agent_id filter on the helper; fold by hand
    const cc = listAuditCredentialChanges({ from, to, limit: fetchLimit })
      .filter(r => r.agent_id === agent)
      .map(r => ({ _class: 'audit_credential_change', ...r }));
    const pc = listAuditPermissionChanges({ from, to, agent_id: agent, limit: fetchLimit })
      .map(r => ({ _class: 'audit_permission_change', ...r }));

    const merged = [...ti, ...fa, ...cc, ...pc]
      .sort((a, b) => (b.occurred_at || '').localeCompare(a.occurred_at || ''))
      .slice(0, limit);

    return res.json({ agent, from, to, rows: merged, count: merged.length });
  } catch (e) {
    if (/unknown period/.test(e.message)) return badRequest(res, e.message);
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 8. GET /audit/by-control-area
// ──────────────────────────────────────────────────────────────────────────

router.get('/audit/by-control-area', (req, res) => {
  try {
    const framework = req.query.control_framework ? String(req.query.control_framework) : null;
    if (!framework || !CONTROL_AREA_MAP[framework]) {
      return badRequest(res, `control_framework must be one of: ${Object.keys(CONTROL_AREA_MAP).join(', ')}`);
    }
    const period = req.query.period ? String(req.query.period) : 'mtd';
    const r = costQuery.periodToRange(period);
    const from = `${r.from}T00:00:00.000Z`;
    const to = `${r.to}T23:59:59.999Z`;

    const areas = CONTROL_AREA_MAP[framework].map(area => ({
      id: area.id,
      name: area.name,
      audit_object_classes: area.audit_object_classes,
      counts: {
        total: countsForObjectClasses(area.audit_object_classes, { from, to, control_area: area.id }),
      },
    }));

    return res.json({
      control_framework: framework,
      period,
      from: r.from,
      to: r.to,
      control_areas: areas,
    });
  } catch (e) {
    if (/unknown period/.test(e.message)) return badRequest(res, e.message);
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 9. GET /audit/anomaly-detail
// Phase 1 heuristic: per-agent rollup of policy-violation count + activity
// volume across the window. Sort DESC by policy_violation_count, ties
// broken by tool_invocation_count. Phase 2 will fold rate-of-change vs
// 7d baseline + cross-agent z-score.
// ──────────────────────────────────────────────────────────────────────────

router.get('/audit/anomaly-detail', (req, res) => {
  try {
    const { from, to } = parseRange(req, { defaultPeriod: '7d' });
    const limit = 10000;

    const ti = listAuditToolInvocations({ from, to, limit });
    const fa = listAuditFileAccess({ from, to, limit });
    const pv = listPolicyViolations({ from, to, limit });

    const byAgent = new Map();
    function bump(agent_id, key) {
      if (!agent_id) return;
      let row = byAgent.get(agent_id);
      if (!row) {
        row = { agent_id, policy_violation_count: 0, tool_invocation_count: 0, file_access_count: 0 };
        byAgent.set(agent_id, row);
      }
      row[key] += 1;
    }
    for (const r of ti) bump(r.agent_id, 'tool_invocation_count');
    for (const r of fa) bump(r.agent_id, 'file_access_count');
    for (const r of pv) bump(r.agent_id, 'policy_violation_count');

    const anomalies = [...byAgent.values()].sort((a, b) =>
      (b.policy_violation_count - a.policy_violation_count) ||
      (b.tool_invocation_count - a.tool_invocation_count));

    return res.json({ from, to, anomalies, heuristic: 'phase1-violation-count-desc' });
  } catch (e) {
    if (/unknown period/.test(e.message)) return badRequest(res, e.message);
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 10. GET /policy/rules
// ──────────────────────────────────────────────────────────────────────────

router.get('/policy/rules', (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    if (status && !['draft', 'active', 'deprecated'].includes(status)) {
      return badRequest(res, 'status must be draft|active|deprecated');
    }
    const rules = listPolicyRules({ status });
    return res.json({ rules, count: rules.length });
  } catch (e) {
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 11. GET /policy/rules/:rule_id
// ──────────────────────────────────────────────────────────────────────────

router.get('/policy/rules/:rule_id', (req, res) => {
  try {
    const rule = getPolicyRule(String(req.params.rule_id));
    if (!rule) return notFound(res, `rule_id ${req.params.rule_id} not found`);
    return res.json(rule);
  } catch (e) {
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 12. GET /policy/violations
// ──────────────────────────────────────────────────────────────────────────

router.get('/policy/violations', (req, res) => {
  try {
    const { from, to } = parseRange(req);
    const rows = listPolicyViolations({
      from, to,
      rule_id: req.query.rule_id ? String(req.query.rule_id) : undefined,
      disposition: req.query.disposition ? String(req.query.disposition) : undefined,
      limit: clampLimit(req.query.limit),
    });
    return res.json({ rows, count: rows.length });
  } catch (e) {
    if (/unknown period/.test(e.message)) return badRequest(res, e.message);
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 13. GET /policy/divergence
// Load-bearing GRC indicator: count of policies codified vs (active|draft|
// deprecated). Phase-2 will fold violations-since-ratification rate.
// ──────────────────────────────────────────────────────────────────────────

router.get('/policy/divergence', (req, res) => {
  try {
    const all = listPolicyRules();
    const counts = {
      policies_codified: all.length,
      policies_active: all.filter(r => r.status === 'active').length,
      policies_draft: all.filter(r => r.status === 'draft').length,
      policies_deprecated: all.filter(r => r.status === 'deprecated').length,
    };
    return res.json({ ...counts, computed_at: new Date().toISOString() });
  } catch (e) {
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 14. GET /audit/coverage-gap
// Per bizmodel R-A3 fold. Compares distinct(agent_id) appearing in
// audit_tool_invocation last 7d to the agents present in the cluster
// presence table. Output: any agent in presence but NOT in audit trail
// — these are the surfaces where instrumentation needs catch-up.
// ──────────────────────────────────────────────────────────────────────────

// CP12.9 (2026-06-06): per-agent disposition enrichment per Jon-direct
// honesty-of-the-tile ask. Classifies each "missing" agent so dashboard
// can distinguish genuine gaps from known-inactive / alias / different-
// runtime noise. Heuristics per cluster canon (project_* memories):
//   inactive       — daemon_state=down OR last_heartbeat > 7d ago
//   alias_of:<x>   — known-alias map (gamedev-godot-apple → macdev-godot)
//   different_runtime:<r> — known non-Claude-Code runtimes (gemini, codex)
//   genuine_gap    — daemon up + heartbeat fresh + no audit_tool_invocation
//                    in 7d window — this is the real instrumentation gap
//                    that needs operator attention
//
// Hard-coded knowledge in this file is the pragmatic Phase-1 path; a
// formal agent-registry lookup (per-agent runtime + disposition flag)
// would be Phase 2 once the agent_registry table lands.

const KNOWN_ALIAS_MAP = {
  'gamedev-godot-apple-agent': 'macdev-godot-agent',
};
const KNOWN_DIFFERENT_RUNTIME = {
  'gemini-agent': 'gemini-cli',
  'aieng3-agent': 'codex',
};

function classifyMissingAgent(agentId, presenceRow, nowMs) {
  if (KNOWN_ALIAS_MAP[agentId]) {
    return { agent_id: agentId, disposition: 'alias_of', detail: KNOWN_ALIAS_MAP[agentId] };
  }
  if (KNOWN_DIFFERENT_RUNTIME[agentId]) {
    return { agent_id: agentId, disposition: 'different_runtime', detail: KNOWN_DIFFERENT_RUNTIME[agentId] };
  }
  if (!presenceRow) {
    return { agent_id: agentId, disposition: 'no_presence_row', detail: null };
  }
  if (presenceRow.daemon_state === 'down') {
    return { agent_id: agentId, disposition: 'inactive', detail: 'daemon down' };
  }
  if (presenceRow.last_heartbeat_at) {
    const ageMs = nowMs - new Date(presenceRow.last_heartbeat_at).getTime();
    if (ageMs > 7 * 86400_000) {
      return { agent_id: agentId, disposition: 'inactive', detail: `heartbeat ${Math.floor(ageMs / 86400_000)}d old` };
    }
  }
  // Active + heartbeating + audited:false → this is the genuine gap
  return { agent_id: agentId, disposition: 'genuine_gap', detail: 'active but no audit_tool_invocation events' };
}

router.get('/audit/coverage-gap', (req, res) => {
  try {
    const now = new Date();
    const nowMs = now.getTime();
    const from = new Date(nowMs - 7 * 86400_000).toISOString();
    const to = now.toISOString();

    const tiRows = listAuditToolInvocations({ from, to, limit: 10000 });
    const audited = new Set(tiRows.map(r => r.agent_id).filter(Boolean));

    const presenceRows = listPresence();
    const presenceById = new Map(presenceRows.map(p => [p.agent_id, p]));
    const presenceAgents = new Set(presenceRows.map(p => p.agent_id).filter(Boolean));

    const missing = [...presenceAgents].filter(a => !audited.has(a)).sort();
    const missing_dispositions = missing.map(a => classifyMissingAgent(a, presenceById.get(a), nowMs));

    // Honest count: only genuine_gap entries are real instrumentation gaps.
    // alias / different_runtime / inactive are noise that the dashboard
    // should surface separately.
    const genuine_gap_count = missing_dispositions.filter(d => d.disposition === 'genuine_gap').length;
    const inactive_count = missing_dispositions.filter(d => d.disposition === 'inactive').length;
    const alias_count = missing_dispositions.filter(d => d.disposition === 'alias_of').length;
    const different_runtime_count = missing_dispositions.filter(d => d.disposition === 'different_runtime').length;

    return res.json({
      agents_audit_wired: audited.size,
      agents_missing_trail_7d: missing.length,
      genuine_gap_count,
      inactive_count,
      alias_count,
      different_runtime_count,
      missing_agent_ids: missing,
      missing_dispositions,
      window_from: from,
      window_to: to,
      computed_at: new Date().toISOString(),
    });
  } catch (e) {
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 15. GET /audit/export
// Phase 1: only the `generic` schema produces a payload. Bundle schemas
// (soc2-bundle, iso27001-bundle, gdpr-dsar) return 501 until Phase 2.
// ──────────────────────────────────────────────────────────────────────────

const EXPORT_SCHEMAS_PHASE1 = new Set(['generic']);
const EXPORT_SCHEMAS_PHASE2 = new Set(['soc2-bundle', 'iso27001-bundle', 'gdpr-dsar']);

router.get('/audit/export', (req, res) => {
  try {
    const format = req.query.format ? String(req.query.format) : 'csv';
    const schema = req.query.schema ? String(req.query.schema) : 'generic';
    const period = req.query.period ? String(req.query.period) : 'mtd';

    if (!['csv', 'json'].includes(format)) {
      return badRequest(res, 'format must be csv or json');
    }
    if (EXPORT_SCHEMAS_PHASE2.has(schema)) {
      return notImplemented(res, `Schema ${schema} ships in Phase 2`);
    }
    if (!EXPORT_SCHEMAS_PHASE1.has(schema)) {
      return badRequest(res, `unknown schema ${schema}`);
    }

    let range;
    try { range = costQuery.periodToRange(period); }
    catch (e) { return badRequest(res, e.message); }

    const from = `${range.from}T00:00:00.000Z`;
    const to = `${range.to}T23:59:59.999Z`;
    const rows = listAuditToolInvocations({ from, to, limit: 10000 });

    if (format === 'json') {
      return res.json({ schema, period, from: range.from, to: range.to, rows, count: rows.length });
    }

    // CSV
    const header = ['event_id', 'agent_id', 'occurred_at', 'tool_name', 'tool_phase',
      'input_digest', 'output_digest', 'status', 'status_detail', 'subagent_type',
      'source_event_id', 'payload_ref'];
    const lines = rows.map(r => header.map(h => csvEscape(r[h])).join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-export-${period}.csv"`);
    return res.send([header.join(','), ...lines].join('\n') + '\n');
  } catch (e) {
    return safeError(res, e);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// CP12.13 Phase 2 aggregate views — leverage existing substrate without new
// table additions. Channel-subscription change history deferred to a
// separate sub-cycle (substrate doesn't exist; needs Phase 2 substrate-
// addition decision before aggregating).
// ──────────────────────────────────────────────────────────────────────────

// 11. GET /audit/registration-timeline?agent_id=<id>&from=&to=&limit=&period=
router.get('/audit/registration-timeline', (req, res) => {
  try {
    const agent_id = req.query.agent_id ? String(req.query.agent_id) : null;
    if (!agent_id) return badRequest(res, 'agent_id query parameter required');
    const { from, to } = parseRange(req, { defaultPeriod: '30d' });
    const limit = clampLimit(req.query.limit, 200, 1000);
    // Substrate uses ISO `ts` column (not occurred_at) — same shape works since
    // parseRange returns ISO bounds usable for lex-compare on ISO timestamps.
    const events = listRegistrationEventsByAgent(agent_id, { from, to, limit });
    // Derive state transitions (ascending order — events list is DESC by ts).
    const asc = events.slice().reverse();
    const transitions = asc.map((e, i) => ({
      from: i > 0 ? asc[i - 1].event_type : null,
      to: e.event_type,
      ts: e.ts,
      actor: e.actor,
    }));
    return res.json({ agent_id, from, to, count: events.length, events, transitions });
  } catch (e) {
    if (/unknown period/.test(e.message)) return badRequest(res, e.message);
    return safeError(res, e);
  }
});

// 12. GET /audit/registration-timeline-summary?from=&to=&period=
router.get('/audit/registration-timeline-summary', (req, res) => {
  try {
    const { from, to } = parseRange(req, { defaultPeriod: '30d' });
    const rows = aggregateRegistrationEventsByAgent({ from, to });
    const byAgent = new Map();
    for (const r of rows) {
      let entry = byAgent.get(r.agent_id);
      if (!entry) {
        entry = { agent_id: r.agent_id, by_event_type: {}, total: 0 };
        byAgent.set(r.agent_id, entry);
      }
      entry.by_event_type[r.event_type] = r.count;
      entry.total += r.count;
    }
    const agents = [...byAgent.values()].sort((a, b) => b.total - a.total);
    return res.json({ from, to, agent_count: agents.length, agents });
  } catch (e) {
    if (/unknown period/.test(e.message)) return badRequest(res, e.message);
    return safeError(res, e);
  }
});

// 13. GET /audit/credential-rotation-aggregate?from=&to=&group_by=&period=
router.get('/audit/credential-rotation-aggregate', (req, res) => {
  try {
    const { from, to } = parseRange(req, { defaultPeriod: '30d' });
    const group_by = req.query.group_by ? String(req.query.group_by) : 'credential_class';
    const ALLOWED = ['credential_class', 'change_type', 'actor'];
    if (!ALLOWED.includes(group_by)) {
      return badRequest(res, `group_by must be one of ${ALLOWED.join('|')}`);
    }
    const buckets = aggregateCredentialChanges({ from, to, group_by });
    const total = buckets.reduce((s, b) => s + b.count, 0);
    return res.json({ from, to, group_by, total, buckets });
  } catch (e) {
    if (/unknown period/.test(e.message)) return badRequest(res, e.message);
    return safeError(res, e);
  }
});

// 14. GET /audit/adr-change-history?repo=agent-specs|agent-globals&limit=
//
// Aggregate over bare-repo git-log. Filters commits that touched ADR
// markdown files. Heuristic match: filename contains 'adr' (case-insensitive)
// AND ends in .md.
const ADR_REPO_ALLOWLIST = new Set(['agent-specs', 'agent-globals']);

router.get('/audit/adr-change-history', (req, res) => {
  try {
    const repo = req.query.repo ? String(req.query.repo) : 'agent-specs';
    if (!ADR_REPO_ALLOWLIST.has(repo)) {
      return badRequest(res, `repo must be one of ${[...ADR_REPO_ALLOWLIST].join('|')}`);
    }
    const limit = clampLimit(req.query.limit, 100, 500);
    const repoPath = `/srv/git/${repo}.git`;
    const { execFileSync } = require('child_process');
    let out = '';
    try {
      out = execFileSync('git', [
        '-C', repoPath,
        'log', '--all',
        '--diff-filter=AM',
        `-n`, String(limit * 3), // overscan: many commits won't touch ADRs
        `--pretty=format:%H|%aI|%an|%s`,
        '--name-only',
      ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    } catch (gitErr) {
      // Repo missing / not readable — return empty array with operator hint
      return res.status(503).json({
        error: 'GitUnavailable',
        message: `bare repo ${repoPath} not accessible: ${gitErr.code || gitErr.message}`,
        repo, commits: [], count: 0,
      });
    }
    // Parse: header line "sha|iso|author|subject" followed by file paths until blank line.
    const commits = [];
    let current = null;
    for (const raw of out.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (/^[0-9a-f]{40}\|/.test(line)) {
        if (current && current.files.length > 0) commits.push(current);
        const idx1 = line.indexOf('|');
        const idx2 = line.indexOf('|', idx1 + 1);
        const idx3 = line.indexOf('|', idx2 + 1);
        current = {
          sha: line.slice(0, idx1),
          ts: line.slice(idx1 + 1, idx2),
          author: line.slice(idx2 + 1, idx3),
          subject: line.slice(idx3 + 1),
          files: [],
        };
      } else if (line.trim() && current) {
        const path = line.trim();
        if (/\.md$/i.test(path) && /adr/i.test(path)) {
          current.files.push(path);
        }
      }
    }
    if (current && current.files.length > 0) commits.push(current);
    const adrCommits = commits.slice(0, limit);
    return res.json({ repo, limit, count: adrCommits.length, commits: adrCommits });
  } catch (e) {
    return safeError(res, e);
  }
});

module.exports = router;
module.exports._internals = { CONTROL_AREA_MAP, EXPORT_SCHEMAS_PHASE1, EXPORT_SCHEMAS_PHASE2 };

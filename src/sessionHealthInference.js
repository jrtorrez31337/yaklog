// Task #280 / PLAN-SESSION-HEALTH-SUBSTRATE §3.3 + §3.5: server-side
// session_health inference. Pure functions so tests can exercise them
// without a full app instance.
//
// Phase A scope (this file): derive `session_health_class` (GREEN/AMBER/RED
// per s345-aieng #12243 3-color operator collapse) + apply the OQ4
// "structural signal supersedes stale wrapper claim" override for daemon_only.
//
// error_loop (§3.3) deferred to Phase B — needs a consecutive-fails column
// that Phase A doesn't yet track.

// s345-aieng #12243 3-color mapping:
//   GREEN  honest_idle
//   AMBER  pending_input, quota_exceeded    (transient / will-clear)
//   RED    session_expired, context_exhausted, error_loop, daemon_only
const HEALTH_CLASS = {
  honest_idle:       'GREEN',
  pending_input:     'AMBER',
  quota_exceeded:    'AMBER',
  session_expired:   'RED',
  context_exhausted: 'RED',
  error_loop:        'RED',
  daemon_only:       'RED',
};

// Full enum for validation (§3.2 OQ1 disposition-locked at s345-aieng #12248).
const VALID_HEALTH_VALUES = new Set(Object.keys(HEALTH_CLASS));

// Idle-staleness window before we override any wrapper claim with daemon_only.
// s345-aieng #12245 discipline: silence-timeout is the ONLY trustworthy
// structural trip; use a bounded default + env override per OQ2.
const DEFAULT_IDLE_STALENESS_S = 600;
function getIdleStalenessMs() {
  const s = Number(process.env.YAKLOG_SESSION_HEALTH_IDLE_STALENESS_S
    || DEFAULT_IDLE_STALENESS_S);
  if (!Number.isFinite(s) || s <= 0) return DEFAULT_IDLE_STALENESS_S * 1000;
  return s * 1000;
}

// Session states where daemon_only inference makes sense: only for idle-ish
// runtimes. An active/tool_running session with a stale hook is a different
// problem (SSE-stale, handled by CP12.x.4) — not degraded-liveness.
const DAEMON_ONLY_ELIGIBLE_STATES = new Set(['idle', 'unknown', 'idle_between_tools']);

/**
 * Compute the effective session_health for a presence row at read-time.
 *
 * Precedence per §3.4 + OQ4:
 *   1. If decommissioned → null (never surface health on a retired row).
 *   2. If daemon_state != 'up' → null (session_health is a runtime concept;
 *      offline daemons have their own label).
 *   3. Structural daemon_only override fires ONLY when the wrapper HAS
 *      reported a session_health at some point AND that report is now stale
 *      beyond the staleness window (session_health_at older than window)
 *      AND session_state is idle-eligible. This is the "was reporting, went
 *      silent" signature — a genuine crash-of-runtime while daemon lives.
 *      A row with session_health = null (never reported) does NOT trip
 *      daemon_only — an un-observed agent may be honest-idle or install-gap
 *      or dead, and RED-crying-wolf on any of those trains operators to
 *      ignore the pill (s345-aieng #12245 fail-safe default = honest_idle
 *      until HIGH-confidence signal).
 *   4. Otherwise → the wrapper-emitted session_health as-persisted.
 *
 * @param {object} row presence row (must have session_health, session_health_at,
 *   session_state, daemon_state, decommissioned_at fields).
 * @param {number} [nowMs] optional now; defaults to Date.now(). Injectable
 *   for tests.
 * @returns {string|null} the effective health enum value or null.
 */
function computeEffectiveHealth(row, nowMs = Date.now()) {
  if (row.decommissioned_at) return null;
  if (row.daemon_state !== 'up') return null;

  // Structural daemon_only override (OQ4): only when the wrapper WAS
  // reporting and stopped. Never trip on cluster-wide first-time silence.
  if (row.session_health
      && row.session_health_at
      && DAEMON_ONLY_ELIGIBLE_STATES.has(row.session_state)) {
    const reportAgeMs = nowMs - new Date(row.session_health_at).getTime();
    if (Number.isFinite(reportAgeMs) && reportAgeMs > getIdleStalenessMs()) {
      return 'daemon_only';
    }
  }

  // No structural override → wrapper-emitted value (or null = unreported)
  return row.session_health || null;
}

/**
 * Map a session_health enum value to its operator-facing 3-color class.
 * Returns null for null/unreported so the UI can render "no pill".
 */
function classifyHealth(health) {
  if (!health) return null;
  return HEALTH_CLASS[health] || null;
}

module.exports = {
  HEALTH_CLASS,
  VALID_HEALTH_VALUES,
  DEFAULT_IDLE_STALENESS_S,
  getIdleStalenessMs,
  DAEMON_ONLY_ELIGIBLE_STATES,
  computeEffectiveHealth,
  classifyHealth,
};

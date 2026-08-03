// ADR-0041 v2 / secops #12076 — demo-mode render sanitization module.
//
// Purpose: when the dashboard is loaded with `?demo=1` in the URL, all
// identifiers (agent_id, repo_key) and scale-disclosure metric values
// (hero counts) are substituted with stable demo labels at RENDER TIME —
// so PTAH-captured screenshots of the real dashboard against live data
// carry zero real-world identifiers or metric scale into the customer-
// facing "What is Yaklog" page.
//
// Design principles:
//   1. Client-side render-time substitution. Server data untouched;
//      dogfood posture preserved (agent captures REAL dashboard).
//   2. Hash-based deterministic mapping — same real_id → same demo_slug
//      across every render site, so cross-view coherence holds
//      (AgentCard "agent-alpha" == trace "agent-alpha" == audit-log
//      actor "agent-alpha" for the same real agent).
//   3. Coverage completeness — one uncovered field = flag fails secops
//      Gate (1) per #12076. Wrapper helpers for the 3 identifier classes
//      + a stable demo hero-summary substitution.
//
// Usage from dashboard.js:
//   if (DemoSanitize.enabled()) {
//     agentIdText.textContent = DemoSanitize.agentId(realId);
//     repoKeyText.textContent = DemoSanitize.repoKey(realKey);
//     tileValue.textContent   = DemoSanitize.metric('repos_governed_total', realVal);
//   }
//
// Loaded via `<script src="/demoSanitize.js"></script>` in dashboard.html
// BEFORE dashboard.js (global window.DemoSanitize).

(function (global) {
  'use strict';

  // ── Pool of demo slugs ────────────────────────────────────────────────
  // Sized to comfortably cover current cluster agent count (~30 registered
  // agents) with room for growth. Slugs are memorable Greek letters +
  // rolling variants (alpha-1, alpha-2 for overflow).
  const DEMO_AGENT_ID_POOL = [
    'agent-alpha', 'agent-beta', 'agent-gamma', 'agent-delta',
    'agent-epsilon', 'agent-zeta', 'agent-eta', 'agent-theta',
    'agent-iota', 'agent-kappa', 'agent-lambda', 'agent-mu',
    'agent-nu', 'agent-xi', 'agent-omicron', 'agent-pi',
    'agent-rho', 'agent-sigma', 'agent-tau', 'agent-upsilon',
    'agent-phi', 'agent-chi', 'agent-psi', 'agent-omega',
    'agent-alpha-2', 'agent-beta-2', 'agent-gamma-2', 'agent-delta-2',
    'agent-epsilon-2', 'agent-zeta-2', 'agent-eta-2', 'agent-theta-2',
  ];

  const DEMO_REPO_KEY_POOL = [
    'demo-org/example-service', 'demo-org/example-web',
    'demo-org/example-api', 'demo-org/example-worker',
    'demo-org/example-docs', 'demo-org/example-infra',
    'demo-org/sample-cli', 'demo-org/sample-lib',
    'demo-org/sample-agent', 'demo-org/sample-runtime',
    'bare-git:sample-primary', 'bare-git:sample-secondary',
    'bare-git:sample-tertiary', 'bare-git:sample-canary',
  ];

  // ── Demo hero-summary metric values ───────────────────────────────────
  // Round + plausible + not real; sister-shape my outputHeroSummary seed.
  // Locked stable so cross-view coherence holds (same demo value on every
  // render site). Secops #12076 scale-disclosure discipline: prevents
  // competitor from inferring operational scale from live metrics.
  const DEMO_HERO_SUMMARY = Object.freeze({
    repos_governed_total: 47,
    repo_count_active_window: 12,
    pr_merged_count_cumulative: 1240,
    attribution_integrity_pct: 96,
    attribution_gap_count: 8,
    attributed_agents: 18,
    pending_bare_git_requests: 3,
    cluster_operating_since: '2026-04-01T00:00:00.000Z',
  });

  // ── FNV-1a 32-bit hash (deterministic, no crypto dep) ─────────────────
  // Same input → same output → stable cross-view slug mapping without any
  // per-session state or storage. Not cryptographically secure — that's
  // intentional (privacy from a screenshot, not from an adversary who
  // owns the substrate).
  function fnv1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i += 1) {
      hash ^= str.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash;
  }

  // ── URL flag detection ─────────────────────────────────────────────────
  function enabled() {
    try {
      return typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).has('demo');
    } catch {
      return false;
    }
  }

  // ── Public sanitizers ─────────────────────────────────────────────────

  // Returns a stable demo slug for a real agent_id. Same input → same
  // output across every render site + every session.
  function agentId(realId) {
    if (realId == null || realId === '') return realId;
    if (realId === 'unattributed') return 'unattributed'; // preserve semantic sentinel
    const idx = fnv1a(String(realId)) % DEMO_AGENT_ID_POOL.length;
    return DEMO_AGENT_ID_POOL[idx];
  }

  // Returns a stable demo slug for a real repo_key (github_owner_repo or
  // bare-git:name). Preserves the bare-git: prefix semantic.
  function repoKey(realKey) {
    if (realKey == null || realKey === '') return realKey;
    const isBareGit = String(realKey).startsWith('bare-git:');
    const idx = fnv1a(String(realKey)) % DEMO_REPO_KEY_POOL.length;
    const chosen = DEMO_REPO_KEY_POOL[idx];
    // If real was bare-git and demo happens to land on a github-style slug (or
    // vice-versa), swap to nearest-neighbor of matching class for coherence.
    if (isBareGit && !chosen.startsWith('bare-git:')) {
      return 'bare-git:sample-' + chosen.replace(/[^a-z]/g, '').slice(0, 8);
    }
    if (!isBareGit && chosen.startsWith('bare-git:')) {
      return 'demo-org/' + chosen.replace('bare-git:', '');
    }
    return chosen;
  }

  // Returns the demo value for a hero-summary metric key. Real value ignored
  // — the demo scale-disclosure discipline is that the metric SCALE itself
  // is what we hide (per secops #12076), not just the label.
  //
  // FAIL-SAFE: if fieldName is not in DEMO_HERO_SUMMARY, return a masked
  // sentinel ('—') rather than the real value. Per secops #12083 finding —
  // fail-open on unknown fields is exactly the "uncovered field leaks"
  // case #12076 forbids. When a new hero metric is added, extend
  // DEMO_HERO_SUMMARY explicitly rather than relying on realValue fallthrough.
  function metric(fieldName, _realValue) {
    if (Object.prototype.hasOwnProperty.call(DEMO_HERO_SUMMARY, fieldName)) {
      return DEMO_HERO_SUMMARY[fieldName];
    }
    // Fail-safe: unknown field → masked sentinel. Loud + visible so operator
    // sees the gap during ?demo=1 preview + can extend DEMO_HERO_SUMMARY.
    return '—';
  }

  // Sanitize an entire hero-summary response object (returns a new object).
  // Convenient wrapper — cover EVERY documented hero-summary field per
  // secops Gate (1) completeness discipline.
  function heroSummary(realResponse) {
    if (!realResponse || typeof realResponse !== 'object') return realResponse;
    const sanitized = { ...realResponse };
    for (const key of Object.keys(DEMO_HERO_SUMMARY)) {
      sanitized[key] = DEMO_HERO_SUMMARY[key];
    }
    return sanitized;
  }

  // ── Export via global ─────────────────────────────────────────────────
  global.DemoSanitize = Object.freeze({
    enabled,
    agentId,
    repoKey,
    metric,
    heroSummary,
    _pools: Object.freeze({
      DEMO_AGENT_ID_POOL: Object.freeze(DEMO_AGENT_ID_POOL.slice()),
      DEMO_REPO_KEY_POOL: Object.freeze(DEMO_REPO_KEY_POOL.slice()),
      DEMO_HERO_SUMMARY,
    }),
  });
})(typeof window !== 'undefined' ? window : globalThis);

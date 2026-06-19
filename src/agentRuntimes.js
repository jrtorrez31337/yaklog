// Per-agent runtime registry (hand-curated fallback).
//
// Frontend prefers OTel-derived runtime when an agent emits Plexus telemetry
// (`service_name='claude-code'` → claude_code, `service_name='gemini-cli'` →
// gemini). For agents that don't emit Plexus telemetry (Codex agents like
// techmark, or any agent pre-Path-A onboarding) we fall back to this map.
//
// Default: 'claude_code' (covers the whole CC cluster without explicit entry).
// Add an entry here ONLY when an agent's runtime is not claude_code AND it
// doesn't emit OTel with a derivable service_name.

const REGISTRY = new Map([
  ['gemini-agent', 'gemini'],
  // techmark was Codex; switched to Claude Code per Jon-direct 2026-05-26.
  // No entry needed; default covers it.
  ['aieng3-agent', 'codex'],   // Codex; currently paused (funding) per Jon-direct 2026-05-27 — will return
  // Ptah — custom Rust(Tauri)+TS BDI agent per ADR-0032 Phase 0-Ptah sister-cycle
  // (Jon-direct ratify 2026-06-19 #9640 routing; parch CONCUR sister-cycle (b) +
  // 'ptah' enum value #9643). Runs on Win11 VM 110 (ptah-win11; host dude).
  // Cross-runtime cohort-coverage validation per Ptah PRIMARY pivot #9560.
  ['ptah-agent', 'ptah'],
]);

const DEFAULT_RUNTIME = 'claude_code';

const VALID_RUNTIMES = new Set(['claude_code', 'gemini', 'codex', 'ptah']);

// Phase 0 Item C (ADR-0032 cross-runtime telemetry parity) — author_email
// reverse-index for outputAttributionParser fallback. Per /srv/git/ptah.git
// empirical: Codex (aieng3-agent@swarm.local + aieng3-agent@devel) and
// Gemini (gemini-agent@devel) commit as DIRECT authors, NOT via
// Co-Authored-By trailer. Without this fallback those commits NULL-fallback
// at attribution-tier — breaks ADR-0032 brand-spine claim per
// feedback_substrate_check_before_routing_claims.
//
// Map<email, agent_id> — explicit; do not auto-derive from REGISTRY
// because canonical commit emails vary by host (e.g., aieng3-agent@swarm.local
// vs aieng3-agent@devel for the same agent). When a new agent's commit email
// appears in output-strand, add an entry here.
const EMAIL_TO_AGENT_ID = new Map([
  // Codex (aieng3-agent)
  ['aieng3-agent@swarm.local', 'aieng3-agent'],
  ['aieng3-agent@devel',       'aieng3-agent'],
  ['aieng3@swarm.local',       'aieng3-agent'],
  // Gemini
  ['gemini-agent@devel',       'gemini-agent'],
  // Ptah — preemptive; once Ptah commits start landing in cluster repos
  ['ptah-agent@devel',         'ptah-agent'],
  ['ptah-agent@ptah-win11',    'ptah-agent'],
]);

function runtimeOf(agentId) {
  return REGISTRY.get(agentId) || DEFAULT_RUNTIME;
}

// Phase 0 Item C: reverse-index lookup. Returns null when email is not
// a known runtime-canonical-author email (parser falls through to next
// attribution_method in chain).
function agentIdByEmail(email) {
  if (!email || typeof email !== 'string') return null;
  return EMAIL_TO_AGENT_ID.get(email.toLowerCase()) || null;
}

module.exports = {
  runtimeOf,
  agentIdByEmail,
  REGISTRY,
  EMAIL_TO_AGENT_ID,
  DEFAULT_RUNTIME,
  VALID_RUNTIMES,
};

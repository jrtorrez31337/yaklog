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

function runtimeOf(agentId) {
  return REGISTRY.get(agentId) || DEFAULT_RUNTIME;
}

module.exports = {
  runtimeOf,
  REGISTRY,
  DEFAULT_RUNTIME,
  VALID_RUNTIMES,
};

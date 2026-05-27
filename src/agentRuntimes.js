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
]);

const DEFAULT_RUNTIME = 'claude_code';

const VALID_RUNTIMES = new Set(['claude_code', 'gemini', 'codex']);

function runtimeOf(agentId) {
  return REGISTRY.get(agentId) || DEFAULT_RUNTIME;
}

module.exports = {
  runtimeOf,
  REGISTRY,
  DEFAULT_RUNTIME,
  VALID_RUNTIMES,
};

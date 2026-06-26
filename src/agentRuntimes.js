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

// Phase 0 Item C + Jon-direct empirical-expansion 2026-06-20 — author_email
// reverse-index for outputAttributionParser fallback + Co-Authored-By
// specific-agent resolver.
//
// Empirical anchor: walker first-fire 2026-06-20 against /srv/git/*.git
// 533 commits surfaced ~20 distinct agent emails. Without registry entries
// these collapse to 'claude-code' generic runtime label (Co-Authored-By path)
// or null_fallback (direct-author path). Per Jon-direct: "we should be able
// to map specific agents via bare-git data" — this registry is the substrate
// for per-agent attribution.
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
  // Ptah
  ['ptah-agent@devel',         'ptah-agent'],
  ['ptah-agent@ptah-win11',    'ptah-agent'],
  // ── CC agents (Jon-direct empirical-expansion 2026-06-20) ─────────────
  // yaklog-dev (this agent)
  ['yaklog-dev-agent@devel',   'yaklog-dev-agent'],
  ['yaklog-dev@devel.local',   'yaklog-dev-agent'],
  ['yaklog-dev@subnet345.com', 'yaklog-dev-agent'],
  ['yaklog-dev@devel',         'yaklog-dev-agent'],
  // s345-aieng (Anthropic Ptah primary; in-place rename from `aieng-agent` per
  // Jon-direct #7894 dispatch 2026-06-06; historical aieng-* author-emails
  // are substantively the SAME entity, now canonically s345-aieng-agent.
  // YAKLOG_ALIASES at /home/jon/agents/s345-aieng/.config/yaklog/...env
  // preserves `aieng-renamed` audit-trail per migration canon.)
  ['s345-aieng-agent@subnet345.com', 's345-aieng-agent'],
  ['s345-aieng@devel',         's345-aieng-agent'],
  ['aieng-agent@subnet345.com',     's345-aieng-agent'],  // historical-alias post-rename
  ['aieng-agent@traptop10k.local',  's345-aieng-agent'],  // historical-alias post-rename
  ['aieng@devel',                   's345-aieng-agent'],  // historical-alias post-rename
  // ssw-devops
  ['ssw-devops@devel',         'ssw-devops-agent'],
  ['ssw-devops-agent@devel',   'ssw-devops-agent'],
  // s345 (brand-spine + scope-strand)
  ['s345-agent@traptop10k.local', 's345-agent'],
  ['s345-agent@devel',           's345-agent'],
  // gfxartist
  ['gfxartist-agent@ssw-cluster',  'gfxartist-agent'],
  ['gfxartist-agent@ssw.cluster',  'gfxartist-agent'],
  ['gfxartist-agent@ssw.internal', 'gfxartist-agent'],
  ['gfxartist@devel',              'gfxartist-agent'],
  // parch (governance)
  ['parch@devel',              'parch-agent'],
  ['parch-agent@devel',        'parch-agent'],
  ['parch-agent@traptop10k',   'parch-agent'],
  // writer-agent
  ['writer-agent@subnet345.com', 'writer-agent'],
  ['writer-agent@devel',         'writer-agent'],
  // secops
  ['secops-agent@devel',       'secops-agent'],
  // auth-agent
  ['auth-agent@devel',         'auth-agent'],
  // ── Second-pass empirical 2026-06-20 (post first walker fire) ──────────
  // pveadmin (Ptah host substrate provisioning)
  ['pveadmin-agent@devel',     'pveadmin-agent'],
  // smm-agent
  ['smm-agent@devel',          'smm-agent'],
  // maker-agent (rotated tokens; multi-host)
  ['maker-agent@traptop10k',   'maker-agent'],
  ['maker-agent@devel',        'maker-agent'],
  // additional ssw-devops + secops hostname variants
  ['ssw-devops@subnet345.com', 'ssw-devops-agent'],
  ['secops-agent@swarm.internal', 'secops-agent'],
  // aieng without -agent suffix (legacy short-stem author identity; post-rename
  // per Jon-direct #7894 2026-06-06 redirects to current canonical identity).
  ['aieng@subnet345.com',      's345-aieng-agent'],
  // Jon-direct (intentional non-attribution — author=Jon but no agent context)
  // Mapped to NULL pseudo-agent NOT included here; null_fallback is honest.
]);

function runtimeOf(agentId) {
  return REGISTRY.get(agentId) || DEFAULT_RUNTIME;
}

// Per-agent identity canon (#10831 ratify) — canonical commit email format
// is `<agent-id>@internal.subnet345.com` for every agent on the cluster.
// The `internal.subnet345.com` domain is a sentinel (no DNS; no mail);
// the prefix IS the agent_id. Resolved here by prefix-extraction so
// agentIdByEmail can match without per-agent EMAIL_TO_AGENT_ID entries.
//
// Cluster agent_id naming convention (matches /register validation):
// lowercase letters / digits / hyphens / underscores; first char must be
// a letter. Anchored regex enforces this.
const CANONICAL_IDENTITY_EMAIL_RE = /^([a-z][a-z0-9_-]{0,63})@internal\.subnet345\.com$/;

// Phase 0 Item C: reverse-index lookup. Returns null when email is not
// a known runtime-canonical-author email (parser falls through to next
// attribution_method in chain).
//
// Resolution order:
//   1. EMAIL_TO_AGENT_ID exact lookup (host-specific variants;
//      historical-alias preservation per #7894 rename)
//   2. Canonical per-agent identity pattern (#10831 ratify):
//      `<agent-id>@internal.subnet345.com` → prefix as agent_id
function agentIdByEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const lower = email.toLowerCase();
  const exact = EMAIL_TO_AGENT_ID.get(lower);
  if (exact) return exact;
  const m = lower.match(CANONICAL_IDENTITY_EMAIL_RE);
  if (m) return m[1];
  return null;
}

// Jon-direct empirical-expansion 2026-06-20 — name-pattern resolver for
// Co-Authored-By trailer's display-name portion. When trailer carries
// `Co-Authored-By: writer-agent <noreply@anthropic.com>` the email is generic
// CC but the name carries the agent_id. Same shape applies to all agent
// trailers with `<name>-agent` convention.
//
// Returns agent_id if name matches a known agent_id (REGISTRY OR canonical
// `<name>-agent` cluster-naming-shape); null otherwise (parser falls through
// to runtime-class resolution). Conservative — does NOT reconstruct from
// short-stems to avoid catching generic vendor-display-names like 'Gemini'
// or 'Codex' that should fall through to runtime-class resolution.
function agentIdByName(name) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim().toLowerCase();
  // Direct match against REGISTRY (e.g., 'gemini-agent', 'aieng3-agent', 'ptah-agent')
  if (REGISTRY.has(trimmed)) return trimmed;
  // Pattern: `<stem>-agent` shape (cluster naming convention).
  // Catches 'writer-agent', 'parch-agent', 'gfxartist-agent', etc.
  // when the Co-Authored-By trailer carries the agent_id as display name.
  if (/^[a-z][a-z0-9_-]*-agent$/.test(trimmed)) return trimmed;
  return null;
}

module.exports = {
  runtimeOf,
  agentIdByEmail,
  agentIdByName,
  REGISTRY,
  EMAIL_TO_AGENT_ID,
  DEFAULT_RUNTIME,
  VALID_RUNTIMES,
};

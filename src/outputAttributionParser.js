// CP13.2 / ADR-0032 Agent-attribution parser canon
//
// Parses agent attribution from commit metadata. Shared by both output
// walkers (bare-git + GitHub). Returns:
//   { agent_attribution, attribution_method, runtime_class }
//
// attribution_method values:
//   'co_authored_by' | 'author_email_direct' | 'body_pattern' | 'null_fallback'
// runtime_class values: 'claude-code' | 'codex' | 'gemini-cli' | 'ptah' | null
//
// Parser ordering (first match wins):
//   1. Co-Authored-By trailer parse (most reliable; LLM-emitted)
//   2. author_email direct lookup (Phase 0 Item C; empirical anchor:
//      Codex+Gemini commit as DIRECT authors not via Co-Authored-By trailer
//      per /srv/git/ptah.git probe — aieng3-agent@swarm.local +
//      gemini-agent@devel). Resolves via agentRuntimes.agentIdByEmail()
//      reverse-index.
//   3. Agent-name pattern in body (cross-ref to presence.agent_id registry)
//   4. NULL fallback (honest "human-direct or unattributed")
//
// Per ADR-0032 substrate-by-construction discipline carried from
// ADR-0030: surface gaps rather than impute. `attribution_method` column
// classifies the resolution path so /api/v1/output/coverage-gap can
// distinguish null-fallback from parser misclassification.

'use strict';

const { agentIdByEmail, agentIdByName, runtimeOf } = require('./agentRuntimes');

// Co-Authored-By trailer canonical shape:
//   Co-Authored-By: <Display Name> <email@example.com>
// Match case-insensitive; capture name + email separately.
const CO_AUTHORED_BY_RE = /^Co-Authored-By:\s*(.+?)\s*<(.+?)>\s*$/gim;

// Runtime-class email-domain to canonical runtime_class enum per CP14.1.
const RUNTIME_CLASS_BY_EMAIL_DOMAIN = {
  'anthropic.com': 'claude-code',
  'openai.com': 'codex',
  'google.com': 'gemini-cli',
};

// Runtime-class hints in the display-name portion of Co-Authored-By.
// First match wins; preserves explicit runtime intent even if email-domain
// is generic.
const RUNTIME_CLASS_BY_NAME_PATTERN = [
  [/claude\s*(opus|sonnet|haiku|code)/i, 'claude-code'],
  [/\bcodex\b/i, 'codex'],
  [/gemini/i, 'gemini-cli'],
];

// Body-pattern agent-name match. Matches lines like:
//   "Authored-By: parch"
//   "By: yaklog-dev-agent"
const AUTHORED_BY_RE = /^(?:authored[\s_-]+by|by)\s*:\s*([a-z][a-z0-9_-]*)/im;

function parseCoAuthoredBy(commitMessage) {
  if (!commitMessage || typeof commitMessage !== 'string') return null;
  // Reset regex state (g flag persists across calls).
  CO_AUTHORED_BY_RE.lastIndex = 0;
  const matches = [...commitMessage.matchAll(CO_AUTHORED_BY_RE)];
  if (matches.length === 0) return null;

  // Prefer the LAST Co-Authored-By trailer (convention: trailers at bottom
  // are most authoritative). Walk in reverse.
  //
  // Jon-direct empirical-expansion 2026-06-20: resolve SPECIFIC agent_id
  // from email/name BEFORE collapsing to runtime class. Order:
  //   1. EMAIL_TO_AGENT_ID reverse-index (most specific; e.g.,
  //      'writer-agent@example.com' → 'writer-agent' agent_id)
  //   2. Name-pattern resolver (handles `<name>-agent` shape; covers the
  //      case where trailer is `Co-Authored-By: writer-agent <noreply@anthropic.com>`
  //      — email is generic CC but name carries agent_id)
  //   3. Fall through to runtime-class resolution (legacy path; preserves
  //      coverage for generic CC trailers like 'Claude Opus 4.7
  //      <noreply@anthropic.com>' where no specific agent_id exists)
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const [, name, email] = matches[i];

    // Step 1: specific agent_id via email reverse-index
    const agentFromEmail = agentIdByEmail(email);
    if (agentFromEmail) {
      return {
        agent_attribution: agentFromEmail,
        attribution_method: 'co_authored_by',
        runtime_class: runtimeOf(agentFromEmail),
      };
    }

    // Step 2: specific agent_id via name-pattern (`<stem>-agent` shape)
    const agentFromName = agentIdByName(name);
    if (agentFromName) {
      return {
        agent_attribution: agentFromName,
        attribution_method: 'co_authored_by',
        runtime_class: runtimeOf(agentFromName),
      };
    }

    // Step 3: fall through to runtime-class only (generic CC trailers)
    const domain = email.split('@')[1]?.toLowerCase();
    let runtimeClass = RUNTIME_CLASS_BY_EMAIL_DOMAIN[domain] || null;
    if (!runtimeClass) {
      for (const [pattern, cls] of RUNTIME_CLASS_BY_NAME_PATTERN) {
        if (pattern.test(name)) { runtimeClass = cls; break; }
      }
    }
    if (runtimeClass) {
      return {
        agent_attribution: runtimeClass,
        attribution_method: 'co_authored_by',
        runtime_class: runtimeClass,
      };
    }
  }
  return null;
}

function parseBodyPattern(commitMessage, knownAgentIds) {
  if (!commitMessage || typeof commitMessage !== 'string') return null;
  const matchResult = commitMessage.match(AUTHORED_BY_RE);
  if (!matchResult) return null;
  const candidate = matchResult[1].toLowerCase();
  // Normalize: cluster convention uses {agent}-agent canonical IDs but
  // commit-body may abbreviate. Resolve via registry if provided.
  let resolved = null;
  if (knownAgentIds instanceof Set) {
    if (knownAgentIds.has(candidate)) {
      resolved = candidate;
    } else if (knownAgentIds.has(`${candidate}-agent`)) {
      resolved = `${candidate}-agent`;
    }
  } else {
    // No registry provided; accept the raw candidate without resolution.
    resolved = candidate;
  }
  if (!resolved) return null;
  return {
    agent_attribution: resolved,
    attribution_method: 'body_pattern',
    runtime_class: null,
  };
}

// Phase 0 Item C — author_email direct lookup.
// Codex (aieng3-agent@swarm.local + aieng3-agent@devel) and Gemini
// (gemini-agent@devel) commit as direct authors per empirical anchor in
// /srv/git/ptah.git. agentIdByEmail returns agent_id; runtimeOf resolves
// agent_id → runtime_class via the canonical REGISTRY map.
function parseAuthorEmail(authorEmail) {
  if (!authorEmail) return null;
  const agentId = agentIdByEmail(authorEmail);
  if (!agentId) return null;
  return {
    agent_attribution: agentId,
    attribution_method: 'author_email_direct',
    runtime_class: runtimeOf(agentId),
  };
}

/**
 * Parse agent attribution from commit metadata.
 *
 * @param {string} commitMessage - full commit message (subject + body)
 * @param {Set<string>} [knownAgentIds] - optional registry of known
 *   agent_ids for body-pattern resolution. Falsy = accept raw candidate.
 * @param {string} [authorEmail] - optional commit author email (Phase 0
 *   Item C); resolves direct-author Codex/Gemini commits that don't use
 *   Co-Authored-By trailer.
 * @returns {{ agent_attribution: string|null, attribution_method: string, runtime_class: string|null }}
 */
function parseAttribution(commitMessage, knownAgentIds = null, authorEmail = null) {
  return parseCoAuthoredBy(commitMessage)
    || parseAuthorEmail(authorEmail)
    || parseBodyPattern(commitMessage, knownAgentIds)
    || {
      agent_attribution: null,
      attribution_method: 'null_fallback',
      runtime_class: null,
    };
}

module.exports = {
  parseAttribution,
  parseCoAuthoredBy,
  parseAuthorEmail,
  parseBodyPattern,
};

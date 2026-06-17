// CP13.2 / ADR-0032 Agent-attribution parser canon
//
// Parses agent attribution from commit metadata. Shared by both output
// walkers (bare-git + GitHub). Returns:
//   { agent_attribution, attribution_method, runtime_class }
//
// attribution_method values: 'co_authored_by' | 'body_pattern' | 'null_fallback'
// runtime_class values: 'claude-code' | 'codex' | 'gemini-cli' | null
//
// Parser ordering (first match wins):
//   1. Co-Authored-By trailer parse (most reliable; LLM-emitted)
//   2. Agent-name pattern in body (cross-ref to presence.agent_id registry)
//   3. NULL fallback (honest "human-direct or unattributed")
//
// Per ADR-0032 substrate-by-construction discipline carried from
// ADR-0030: surface gaps rather than impute. `attribution_method` column
// classifies the resolution path so /api/v1/output/coverage-gap can
// distinguish null-fallback from parser misclassification.

'use strict';

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
  // are most authoritative). If no runtime-class resolves, fall through.
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const [, name, email] = matches[i];
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

/**
 * Parse agent attribution from a commit message.
 *
 * @param {string} commitMessage - full commit message (subject + body)
 * @param {Set<string>} [knownAgentIds] - optional registry of known
 *   agent_ids for body-pattern resolution. Falsy = accept raw candidate.
 * @returns {{ agent_attribution: string|null, attribution_method: string, runtime_class: string|null }}
 */
function parseAttribution(commitMessage, knownAgentIds = null) {
  return parseCoAuthoredBy(commitMessage)
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
  parseBodyPattern,
};

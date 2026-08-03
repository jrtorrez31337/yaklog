// CP13.2 / ADR-0032 §Agent-attribution parser tests.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAttribution,
  parseCoAuthoredBy,
  parseBodyPattern,
} = require('../src/outputAttributionParser');

// ── Co-Authored-By trailer parsing ────────────────────────────────────────

test('parseCoAuthoredBy returns claude-code for anthropic.com domain', () => {
  const msg = `Feature: add X\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n`;
  const r = parseCoAuthoredBy(msg);
  assert.equal(r.runtime_class, 'claude-code');
  assert.equal(r.attribution_method, 'co_authored_by');
  assert.equal(r.agent_attribution, 'claude-code');
});

test('parseCoAuthoredBy returns codex for openai.com domain', () => {
  const msg = `Fix\n\nCo-Authored-By: Codex <noreply@openai.com>`;
  const r = parseCoAuthoredBy(msg);
  assert.equal(r.runtime_class, 'codex');
});

test('parseCoAuthoredBy returns gemini-cli for google.com domain', () => {
  const msg = `Refactor\n\nCo-Authored-By: Gemini <noreply@google.com>`;
  const r = parseCoAuthoredBy(msg);
  assert.equal(r.runtime_class, 'gemini-cli');
});

test('parseCoAuthoredBy resolves runtime by display-name pattern when domain is generic', () => {
  const msg = `Build\n\nCo-Authored-By: Claude Code <noreply@github.com>`;
  const r = parseCoAuthoredBy(msg);
  assert.equal(r.runtime_class, 'claude-code');
});

test('parseCoAuthoredBy prefers last trailer when multiple present (most authoritative position)', () => {
  const msg = `Wip\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\nCo-Authored-By: Codex <noreply@openai.com>\n`;
  const r = parseCoAuthoredBy(msg);
  assert.equal(r.runtime_class, 'codex');
});

test('parseCoAuthoredBy returns null when no trailer present', () => {
  assert.equal(parseCoAuthoredBy('Just a commit\n\nNo trailers here.'), null);
});

test('parseCoAuthoredBy returns null when trailer has unrecognized runtime', () => {
  const msg = `Wip\n\nCo-Authored-By: Bob Builder <bob@example.com>`;
  assert.equal(parseCoAuthoredBy(msg), null);
});

test('parseCoAuthoredBy is case-insensitive on trailer label', () => {
  const msg = `Wip\n\nco-authored-by: Claude Opus <noreply@anthropic.com>`;
  const r = parseCoAuthoredBy(msg);
  assert.equal(r.runtime_class, 'claude-code');
});

test('parseCoAuthoredBy handles null + non-string inputs', () => {
  assert.equal(parseCoAuthoredBy(null), null);
  assert.equal(parseCoAuthoredBy(undefined), null);
  assert.equal(parseCoAuthoredBy(42), null);
});

// ── Body-pattern parsing (Authored-By: agent-name) ────────────────────────

test('parseBodyPattern matches "Authored-By: parch" line', () => {
  const msg = `Some commit\n\nAuthored-By: parch\n\nMore detail`;
  const r = parseBodyPattern(msg);
  assert.equal(r.agent_attribution, 'parch');
  assert.equal(r.attribution_method, 'body_pattern');
  assert.equal(r.runtime_class, null);
});

test('parseBodyPattern matches "By: yaklog-dev-agent" line', () => {
  const msg = `Wip\n\nBy: yaklog-dev-agent`;
  const r = parseBodyPattern(msg);
  assert.equal(r.agent_attribution, 'yaklog-dev-agent');
});

test('parseBodyPattern resolves bare-name to {name}-agent via registry', () => {
  const msg = `Wip\n\nAuthored-By: bizmodel`;
  const registry = new Set(['bizmodel-agent', 'parch-agent']);
  const r = parseBodyPattern(msg, registry);
  assert.equal(r.agent_attribution, 'bizmodel-agent');
});

test('parseBodyPattern returns null when no Authored-By/By line', () => {
  const msg = `Just a commit referencing @parch but no authorship line`;
  assert.equal(parseBodyPattern(msg), null);
});

test('parseBodyPattern returns null when registry rejects candidate', () => {
  const msg = `Wip\n\nAuthored-By: nonexistent`;
  const registry = new Set(['parch-agent', 'yaklog-dev-agent']);
  assert.equal(parseBodyPattern(msg, registry), null);
});

test('parseBodyPattern accepts raw candidate when no registry provided (backward-compat)', () => {
  const msg = `Wip\n\nAuthored-By: anyagent`;
  const r = parseBodyPattern(msg, null);
  assert.equal(r.agent_attribution, 'anyagent');
});

// ── Composite parseAttribution: priority + NULL fallback ──────────────────

test('parseAttribution prefers Co-Authored-By over body-pattern', () => {
  const msg = `Wip\n\nAuthored-By: parch\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>`;
  const r = parseAttribution(msg);
  assert.equal(r.attribution_method, 'co_authored_by');
  assert.equal(r.runtime_class, 'claude-code');
});

test('parseAttribution falls through to body-pattern when no Co-Authored-By', () => {
  const msg = `Wip\n\nAuthored-By: parch`;
  const r = parseAttribution(msg);
  assert.equal(r.attribution_method, 'body_pattern');
  assert.equal(r.agent_attribution, 'parch');
});

test('parseAttribution falls through to null_fallback (substrate-honesty per ADR-0030)', () => {
  const msg = `Just a commit with no attribution markers`;
  const r = parseAttribution(msg);
  assert.equal(r.agent_attribution, null);
  assert.equal(r.attribution_method, 'null_fallback');
  assert.equal(r.runtime_class, null);
});

test('parseAttribution handles empty + null + undefined inputs honestly', () => {
  for (const input of ['', null, undefined]) {
    const r = parseAttribution(input);
    assert.equal(r.attribution_method, 'null_fallback');
    assert.equal(r.agent_attribution, null);
  }
});

// ── Phase 0 Item C: author_email_direct fallback ───────────────────────────
// Empirical anchor: /srv/git/ptah.git commits show Codex + Gemini agents
// committing as DIRECT authors (NOT via Co-Authored-By trailer). Per ADR-0032
// Phase 0 PLAN section 2.3, parser falls back to email lookup when trailer
// is absent. Eliminates null_fallback for these agents' commits — load-bearing
// for ADR-0032 brand-spine "audit-by-construction across all runtimes" claim.

const { parseAuthorEmail } = require('../src/outputAttributionParser');

test('parseAuthorEmail: Codex direct-author email → aieng3-agent + runtime=codex', () => {
  const r = parseAuthorEmail('aieng3-agent@yaklog-host');
  assert.equal(r.agent_attribution, 'aieng3-agent');
  assert.equal(r.attribution_method, 'author_email_direct');
  assert.equal(r.runtime_class, 'codex');
});

test('parseAuthorEmail: Gemini direct-author email → gemini-agent + runtime=gemini', () => {
  const r = parseAuthorEmail('gemini-agent@yaklog-host');
  assert.equal(r.agent_attribution, 'gemini-agent');
  assert.equal(r.attribution_method, 'author_email_direct');
  assert.equal(r.runtime_class, 'gemini');
});

test('parseAuthorEmail: unknown email → null (falls through)', () => {
  assert.equal(parseAuthorEmail('random-human@example.com'), null);
  assert.equal(parseAuthorEmail(null), null);
  assert.equal(parseAuthorEmail(''), null);
});

test('parseAttribution: Co-Authored-By trailer takes precedence over author_email', () => {
  const msg = `Subject\n\nBody\n\nCo-Authored-By: Claude Opus 4 <noreply@anthropic.com>`;
  const r = parseAttribution(msg, null, 'aieng3-agent@yaklog-host');
  // Trailer wins; author_email NOT consulted
  assert.equal(r.attribution_method, 'co_authored_by');
  assert.equal(r.runtime_class, 'claude-code');
});

test('parseAttribution: Codex direct-commit (no trailer) → author_email_direct path resolves', () => {
  const msg = `Subject\n\nBody with no trailer`;
  const r = parseAttribution(msg, null, 'aieng3-agent@yaklog-host');
  assert.equal(r.attribution_method, 'author_email_direct');
  assert.equal(r.agent_attribution, 'aieng3-agent');
  assert.equal(r.runtime_class, 'codex');
});

test('parseAttribution: backward-compat — calling without authorEmail still works', () => {
  const msg = `Subject\n\nBody`;
  const r = parseAttribution(msg);
  assert.equal(r.attribution_method, 'null_fallback');
});

// ── Jon-direct empirical-expansion 2026-06-20: specific agent_id resolution
// from Co-Authored-By trailer (replaces collapse-to-runtime behavior). ──────

test('parseCoAuthoredBy: agent-explicit email resolves to specific agent_id (not runtime-class collapse)', () => {
  // writer-agent@example.com is in EMAIL_TO_AGENT_ID per cluster registry
  const msg = `Subject\n\nCo-Authored-By: writer-agent <writer-agent@example.com>`;
  const r = parseCoAuthoredBy(msg);
  assert.equal(r.agent_attribution, 'writer-agent', 'should resolve to specific agent_id not "claude-code"');
  assert.equal(r.attribution_method, 'co_authored_by');
  assert.equal(r.runtime_class, 'claude_code');
});

test('parseCoAuthoredBy: <stem>-agent name pattern resolves even when email is generic CC', () => {
  // Empirical pattern from cluster: `Co-Authored-By: writer-agent <noreply@anthropic.com>`
  // email collapses to claude-code-runtime; name carries the agent_id
  const msg = `Subject\n\nCo-Authored-By: parch-agent <noreply@anthropic.com>`;
  const r = parseCoAuthoredBy(msg);
  assert.equal(r.agent_attribution, 'parch-agent');
  assert.equal(r.runtime_class, 'claude_code');
});

test('parseCoAuthoredBy: generic CC trailer still resolves to claude-code runtime (legacy path preserved)', () => {
  // Vendor-name display + generic email → no specific agent_id available;
  // falls through to runtime-class resolution
  const msg = `Subject\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`;
  const r = parseCoAuthoredBy(msg);
  assert.equal(r.agent_attribution, 'claude-code', 'no specific agent → runtime-class');
  assert.equal(r.runtime_class, 'claude-code');
});

test('parseCoAuthoredBy: codex direct-author email resolves to aieng3-agent (not generic codex)', () => {
  const msg = `Subject\n\nCo-Authored-By: aieng3-agent <aieng3-agent@yaklog-host>`;
  const r = parseCoAuthoredBy(msg);
  assert.equal(r.agent_attribution, 'aieng3-agent');
  assert.equal(r.runtime_class, 'codex');
});

// ── Per-agent identity canon (#10831 ratify) — pattern-resolution path ─────
// Cluster-canon commit email format: `<agent-id>@internal.example.com`.
// agentIdByEmail resolves by prefix-extraction so each new agent doesn't
// need an EMAIL_TO_AGENT_ID entry. Empirical anchor: yaklog-dev-agent's
// recent commits (Wave 6 docs + Phase 1a-c audit-rollup ships) carry this
// email format; pre-fix they landed as null_fallback; post-fix they
// resolve via author_email_direct.

const { agentIdByEmail, runtimeOf } = require('../src/agentRuntimes');

test('agentIdByEmail: canonical identity pattern resolves prefix as agent_id', () => {
  assert.equal(agentIdByEmail('yaklog-dev-agent@internal.example.com'), 'yaklog-dev-agent');
  assert.equal(agentIdByEmail('admin-agent@internal.example.com'), 'admin-agent');
  assert.equal(agentIdByEmail('ssw-devops@internal.example.com'), 'ssw-devops');
  assert.equal(agentIdByEmail('parch-agent@internal.example.com'), 'parch-agent');
  assert.equal(agentIdByEmail('aieng3-agent@internal.example.com'), 'aieng3-agent');
});

test('agentIdByEmail: case-insensitive on canonical pattern', () => {
  assert.equal(agentIdByEmail('Yaklog-Dev-Agent@internal.example.com'), 'yaklog-dev-agent');
});

test('agentIdByEmail: invalid prefix chars in canonical pattern → null', () => {
  assert.equal(agentIdByEmail('Spaces Here@internal.example.com'), null);
  assert.equal(agentIdByEmail('@internal.example.com'), null);
  assert.equal(agentIdByEmail('1starts-with-digit@internal.example.com'), null);
});

test('agentIdByEmail: EMAIL_TO_AGENT_ID exact-lookup precedence preserved (historical hostname variant)', () => {
  // yaklog-dev-agent@yaklog-host is in EMAIL_TO_AGENT_ID — exact takes precedence
  // over the new pattern (which doesn't match @yaklog-host anyway)
  assert.equal(agentIdByEmail('yaklog-dev-agent@yaklog-host'), 'yaklog-dev-agent');
});

test('agentIdByEmail: non-canonical domain → null (no over-match)', () => {
  assert.equal(agentIdByEmail('random-agent@example.com'), null);
  assert.equal(agentIdByEmail('admin@gmail.com'), null);
});

test('parseAttribution: canonical-identity author_email resolves to author_email_direct', () => {
  // Empirical: yaklog-dev-agent's own commits — author=`yaklog-dev-agent@internal.example.com`
  // with NO Co-Authored-By trailer. Pre-fix: null_fallback. Post-fix: author_email_direct.
  const msg = `feat(audit-rollup): Phase 1a — schema + helpers\n\nPer PLAN-CP16...`;
  const r = parseAttribution(msg, null, 'yaklog-dev-agent@internal.example.com');
  assert.equal(r.attribution_method, 'author_email_direct');
  assert.equal(r.agent_attribution, 'yaklog-dev-agent');
});

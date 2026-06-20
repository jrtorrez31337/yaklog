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
  const r = parseAuthorEmail('aieng3-agent@swarm.local');
  assert.equal(r.agent_attribution, 'aieng3-agent');
  assert.equal(r.attribution_method, 'author_email_direct');
  assert.equal(r.runtime_class, 'codex');
});

test('parseAuthorEmail: Gemini direct-author email → gemini-agent + runtime=gemini', () => {
  const r = parseAuthorEmail('gemini-agent@devel');
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
  const r = parseAttribution(msg, null, 'aieng3-agent@swarm.local');
  // Trailer wins; author_email NOT consulted
  assert.equal(r.attribution_method, 'co_authored_by');
  assert.equal(r.runtime_class, 'claude-code');
});

test('parseAttribution: Codex direct-commit (no trailer) → author_email_direct path resolves', () => {
  const msg = `Subject\n\nBody with no trailer`;
  const r = parseAttribution(msg, null, 'aieng3-agent@swarm.local');
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
  // writer-agent@subnet345.com is in EMAIL_TO_AGENT_ID per cluster registry
  const msg = `Subject\n\nCo-Authored-By: writer-agent <writer-agent@subnet345.com>`;
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
  const msg = `Subject\n\nCo-Authored-By: aieng3-agent <aieng3-agent@swarm.local>`;
  const r = parseCoAuthoredBy(msg);
  assert.equal(r.agent_attribution, 'aieng3-agent');
  assert.equal(r.runtime_class, 'codex');
});

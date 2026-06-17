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

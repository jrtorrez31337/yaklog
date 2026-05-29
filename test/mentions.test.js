const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMentions } = require('../src/mentions');

test('empty body returns empty array', () => {
  assert.deepEqual(parseMentions(''), []);
  assert.deepEqual(parseMentions(null), []);
  assert.deepEqual(parseMentions(undefined), []);
});

test('single mention', () => {
  assert.deepEqual(parseMentions('hello @alice world'), ['alice']);
});

test('multiple unique mentions preserve first-seen order', () => {
  assert.deepEqual(parseMentions('@bob see @alice and @charlie'), ['bob', 'alice', 'charlie']);
});

test('duplicate mentions are deduped', () => {
  assert.deepEqual(parseMentions('@alice @bob @alice'), ['alice', 'bob']);
});

test('identifiers allow alphanumerics, underscore, hyphen', () => {
  assert.deepEqual(parseMentions('@agent-1 @agent_2 @Agent3'), ['agent-1', 'agent_2', 'Agent3']);
});

test('identifier max length 64 chars', () => {
  const max = 'a'.repeat(64);
  const over = 'a'.repeat(65);
  assert.deepEqual(parseMentions(`@${max}`), [max]);
  assert.deepEqual(parseMentions(`@${over}`), [max]);
});

test('no mentions returns empty', () => {
  assert.deepEqual(parseMentions('just some text'), []);
});

// v0.5.9.5 (#6983 cluster correction): `@` only counts as a mention when
// preceded by a non-word char (or start-of-string). Prevents scp paths,
// emails, git refs, and user@host prose from polluting the mentions array.
test('embedded @ in scp path is NOT a mention (bizmodel@devel:/path)', () => {
  assert.deepEqual(parseMentions('see bizmodel@devel:/home/bizmodel/path'), []);
});

test('email user@domain.com is NOT a mention (was the documented false-positive pre-v0.5.9.5)', () => {
  assert.deepEqual(parseMentions('contact user@example.com'), []);
});

test('git refs like git@1ca662a are NOT mentions', () => {
  assert.deepEqual(parseMentions('cherry-pick git@1ca662a please'), []);
});

test('user@host prose is NOT a mention (jon@traptop10k, gemini@devel)', () => {
  assert.deepEqual(parseMentions('routed via jon@traptop10k and gemini@devel'), []);
});

test('punctuation-prefixed mention DOES match: (@parch-agent) and ,@admin', () => {
  assert.deepEqual(parseMentions('reviewed by (@parch-agent),@admin and others'), ['parch-agent', 'admin']);
});

test('newline-prefixed mention matches', () => {
  assert.deepEqual(parseMentions('header\n@parch-agent re #1234'), ['parch-agent']);
});

test('mixed embedded + real mentions: only the real ones', () => {
  const body = '@parch-agent reviewed bizmodel@devel:/path with help from admin@traptop10k cc @s345-agent';
  assert.deepEqual(parseMentions(body), ['parch-agent', 's345-agent']);
});

test('start-of-string mention matches', () => {
  assert.deepEqual(parseMentions('@everyone heads up'), ['everyone']);
});

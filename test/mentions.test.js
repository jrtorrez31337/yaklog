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
test('embedded @ in scp path is NOT a mention (user@myserver:/path)', () => {
  assert.deepEqual(parseMentions('see user@myserver:/home/user/path'), []);
});

test('email user@domain.com is NOT a mention (was the documented false-positive pre-v0.5.9.5)', () => {
  assert.deepEqual(parseMentions('contact user@example.com'), []);
});

test('git refs like git@1ca662a are NOT mentions', () => {
  assert.deepEqual(parseMentions('cherry-pick git@1ca662a please'), []);
});

test('user@host prose is NOT a mention (user@myhost, bot@myserver)', () => {
  assert.deepEqual(parseMentions('routed via user@myhost and bot@myserver'), []);
});

test('punctuation-prefixed mention DOES match: (@reviewer-agent) and ,@admin', () => {
  assert.deepEqual(parseMentions('reviewed by (@reviewer-agent),@admin and others'), ['reviewer-agent', 'admin']);
});

test('newline-prefixed mention matches', () => {
  assert.deepEqual(parseMentions('header\n@reviewer-agent re #1234'), ['reviewer-agent']);
});

test('mixed embedded + real mentions: only the real ones', () => {
  const body = '@reviewer-agent reviewed user@myserver:/path with help from ops@myhost cc @data-agent';
  assert.deepEqual(parseMentions(body), ['reviewer-agent', 'data-agent']);
});

test('start-of-string mention matches', () => {
  assert.deepEqual(parseMentions('@everyone heads up'), ['everyone']);
});

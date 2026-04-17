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

test('emails produce false-positive match of local-part (documented)', () => {
  assert.deepEqual(parseMentions('contact user@example.com'), ['example']);
});

test('no mentions returns empty', () => {
  assert.deepEqual(parseMentions('just some text'), []);
});

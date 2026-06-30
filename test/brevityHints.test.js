// Task #242 / PLAN-COMMS-BREVITY-SUBSTRATE tests per parch #11140 Q1-Q5 RATIFY.
//
// Per-detector unit coverage + empty-warnings backward-compat + sample-text-only-in-response

const test = require('node:test');
const assert = require('node:assert/strict');

const { lint, WATCHWORDS, THRESHOLDS } = require('../src/middleware/brevityHints');

test('lint: empty/falsy body returns empty array (backward-compat sentinel)', () => {
  assert.deepEqual(lint(''), []);
  assert.deepEqual(lint(null), []);
  assert.deepEqual(lint(undefined), []);
  assert.deepEqual(lint(42), []);
});

test('lint: clean body returns empty array (no detector fires)', () => {
  const body = 'parch arbitration ratified Q1-Q5. Standing on Gate (1) secops.';
  assert.deepEqual(lint(body), []);
});

test('stacked-modifier-chain: detects 4+ hyphenated tokens', () => {
  const body = 'this is substantively-canonical-arbitration-tier-discipline shape';
  const warnings = lint(body);
  const w = warnings.find((x) => x.kind === 'stacked-modifier-chain');
  assert.ok(w, 'detector fired');
  assert.equal(w.count, 1);
  assert.ok(w.sample.startsWith('substantively-canonical-arbitration-tier'));
});

test('stacked-modifier-chain: 3 segments does NOT fire (threshold is 4)', () => {
  const body = 'three-hyphen-token here';
  const warnings = lint(body);
  assert.equal(warnings.find((x) => x.kind === 'stacked-modifier-chain'), undefined);
});

test('stacked-modifier-chain: counts multiple matches', () => {
  const body = 'one-two-three-four and another-five-six-seven phrase';
  const warnings = lint(body);
  const w = warnings.find((x) => x.kind === 'stacked-modifier-chain');
  assert.equal(w.count, 2);
});

test('word-repetition: fires when watchword appears >8 times', () => {
  const body = 'substantive '.repeat(9).trim();
  const warnings = lint(body);
  const w = warnings.find((x) => x.kind === 'word-repetition');
  assert.ok(w, 'detector fired');
  assert.equal(w.count, 9);
  assert.equal(w.sample, 'substantive');
});

test('word-repetition: exactly 8 does NOT fire (threshold is >8)', () => {
  const body = 'substrate '.repeat(8).trim();
  const warnings = lint(body);
  assert.equal(warnings.find((x) => x.kind === 'word-repetition'), undefined);
});

test('word-repetition: picks the most-repeated watchword when multiple appear', () => {
  const body = 'substrate '.repeat(3) + 'substantive '.repeat(10);
  const warnings = lint(body);
  const w = warnings.find((x) => x.kind === 'word-repetition');
  assert.equal(w.sample, 'substantive');
  assert.equal(w.count, 10);
});

test('word-repetition: case-insensitive on watchword match', () => {
  const body = 'Substantive '.repeat(5) + 'SUBSTANTIVE '.repeat(5);
  const warnings = lint(body);
  const w = warnings.find((x) => x.kind === 'word-repetition');
  assert.equal(w.count, 10);
});

test('body-length: fires when body > 8000 chars', () => {
  const body = 'a'.repeat(8001);
  const warnings = lint(body);
  const w = warnings.find((x) => x.kind === 'body-length');
  assert.ok(w, 'detector fired');
  assert.equal(w.count, 8001);
  assert.match(w.sample, /8001 chars/);
});

test('body-length: exactly 8000 does NOT fire (threshold is >8000)', () => {
  const body = 'a'.repeat(8000);
  const warnings = lint(body);
  assert.equal(warnings.find((x) => x.kind === 'body-length'), undefined);
});

test('sentence-density: fires when avg words/sentence > 50', () => {
  // 2 sentences, each ~60 words → avg ~60
  const sixtyWordSentence = Array(60).fill('word').join(' ') + '.';
  const body = sixtyWordSentence + ' ' + sixtyWordSentence;
  const warnings = lint(body);
  const w = warnings.find((x) => x.kind === 'sentence-density');
  assert.ok(w, 'detector fired');
  assert.ok(w.count >= 50);
});

test('sentence-density: short sentences do NOT fire', () => {
  const body = 'Short. Sentences. Here. Are. Fine.';
  const warnings = lint(body);
  assert.equal(warnings.find((x) => x.kind === 'sentence-density'), undefined);
});

test('sentence-density: handles body with no sentence-terminator', () => {
  // No `.` or `!` or `?` — should not crash, should not fire
  const body = 'just one line no terminator';
  const warnings = lint(body);
  assert.equal(warnings.find((x) => x.kind === 'sentence-density'), undefined);
});

test('multi-detector: all 4 detectors fire on pathological body (techmark #10649 shape)', () => {
  // Constructed to trigger all 4 simultaneously
  const chain = 'substantively-substantive-at-substrate-tier ';
  const body = chain.repeat(50) + // chain detector + watchword detector via 'substantive'
    'Now '.repeat(2000) +  // pad up beyond 8000 chars
    Array(80).fill('word').join(' ') + '.'; // sentence-density
  const warnings = lint(body);
  const kinds = warnings.map((w) => w.kind).sort();
  assert.ok(kinds.includes('stacked-modifier-chain'));
  assert.ok(kinds.includes('word-repetition'));
  assert.ok(kinds.includes('body-length'));
  assert.ok(kinds.includes('sentence-density'));
});

test('warning sample: capped at 80 chars (no body content leakage in sample)', () => {
  const longChain = 'a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x-y-z-aa-bb-cc-dd-ee-ff-gg-hh-ii-jj-kk-ll';
  const body = `prefix ${longChain} suffix`;
  const warnings = lint(body);
  const w = warnings.find((x) => x.kind === 'stacked-modifier-chain');
  assert.ok(w.sample.length <= THRESHOLDS.sample_max_chars);
});

test('WATCHWORDS export: matches Q2 RATIFY hardcoded set', () => {
  assert.deepEqual([...WATCHWORDS].sort(), ['substantive', 'substantively', 'substrate']);
});

test('THRESHOLDS export: matches Q1 RATIFY values', () => {
  assert.equal(THRESHOLDS.chain_segments, 4);
  assert.equal(THRESHOLDS.watchword_count, 8);
  assert.equal(THRESHOLDS.body_length, 8000);
  assert.equal(THRESHOLDS.sentence_density_words, 50);
});

// CP16 / Task #242: server-side soft-warn for brevity-canon violations
// (PLAN-COMMS-BREVITY-SUBSTRATE / parch #11140 Q1-Q5 RATIFY).
//
// Pure-function linter. Input: message body string. Output: array of warning
// objects { kind, count, sample } — one per detector that fires.
//
// Per parch Q5 ratify: dashboard surface deferred to post-empirical-data
// separate PLAN. This module is empirical-feedback infrastructure only;
// callers attach warnings to POST /messages response + emit Prom counter.
//
// Per parch canon #10668 + Non-goal in PLAN: NEVER hard-blocks. Soft-warn
// for self-discipline empirical-feedback.
//
// Detector thresholds per Q1 RATIFY (conservative; tune from empirical):
//   - stacked-modifier-chain: 4+ hyphenated tokens (catches `substantively-X-at-Y-canonical-tier`)
//   - word-repetition: single watchword >8× in single body (anchored to #10649)
//   - body-length: >8000 chars (~equal to techmark #10649 size)
//   - sentence-density: avg words/sentence >50 (run-on padding)
//
// Watchwords per Q2 RATIFY: hardcoded initial; extensibility hook via
// WATCHWORDS export (future config-extensible if cluster patterns shift).

'use strict';

// Stacked-modifier-chain: 4+ hyphenated word tokens like `substantively-X-at-Y-tier`.
// Anchor with \b on both ends; allow underscore/digit inside tokens.
const STACKED_MODIFIER_RE = /\b[A-Za-z_]\w*(?:-[A-Za-z_]\w*){3,}\b/g;

// Watchwords per #10649 evidence anchor. Hardcoded per Q2 RATIFY (extensibility
// hook exported below so future canon shifts don't require code rewrite —
// callers OR a future PLAN can extend the set without changing the detector).
const WATCHWORDS = ['substantive', 'substantively', 'substrate'];

const THRESHOLD_CHAIN_SEGMENTS = 4;
const THRESHOLD_WATCHWORD_COUNT = 8;
const THRESHOLD_BODY_LENGTH = 8000;
const THRESHOLD_SENTENCE_DENSITY_WORDS = 50;
const SAMPLE_MAX_CHARS = 80;

function _detectStackedModifierChain(body) {
  const matches = body.match(STACKED_MODIFIER_RE) || [];
  if (matches.length === 0) return null;
  return {
    kind: 'stacked-modifier-chain',
    count: matches.length,
    sample: matches[0].slice(0, SAMPLE_MAX_CHARS),
  };
}

function _detectWordRepetition(body) {
  const lower = body.toLowerCase();
  let topWord = null;
  let topCount = 0;
  for (const word of WATCHWORDS) {
    // Word-boundary count; case-insensitive via pre-lowered body
    const re = new RegExp(`\\b${word}\\b`, 'g');
    const count = (lower.match(re) || []).length;
    if (count > topCount) {
      topCount = count;
      topWord = word;
    }
  }
  if (topCount <= THRESHOLD_WATCHWORD_COUNT) return null;
  return {
    kind: 'word-repetition',
    count: topCount,
    sample: topWord,
  };
}

function _detectBodyLength(body) {
  if (body.length <= THRESHOLD_BODY_LENGTH) return null;
  return {
    kind: 'body-length',
    count: body.length,
    sample: `${body.length} chars (threshold ${THRESHOLD_BODY_LENGTH})`,
  };
}

function _detectSentenceDensity(body) {
  // Split on sentence-terminators (. ! ?). Crude but good enough for soft-warn.
  // Skip if body has no sentence-terminator (single-line / table-only bodies).
  const sentences = body.split(/[.!?]+\s+|[.!?]+$/).filter((s) => s.trim().length > 0);
  if (sentences.length === 0) return null;
  const totalWords = sentences.reduce((acc, s) => acc + s.trim().split(/\s+/).length, 0);
  const avgWords = totalWords / sentences.length;
  if (avgWords <= THRESHOLD_SENTENCE_DENSITY_WORDS) return null;
  return {
    kind: 'sentence-density',
    count: Math.round(avgWords),
    sample: `avg ${Math.round(avgWords)} words/sentence (threshold ${THRESHOLD_SENTENCE_DENSITY_WORDS})`,
  };
}

/**
 * Lint a message body for brevity-canon violations.
 * @param {string} body - the message body to check
 * @returns {Array<{kind:string, count:number, sample:string}>}
 *   Array of warning objects (one per detector that fires). Empty array
 *   when body is clean OR when body is falsy/non-string.
 */
function lint(body) {
  if (!body || typeof body !== 'string') return [];
  const warnings = [];
  for (const detector of [_detectStackedModifierChain, _detectWordRepetition, _detectBodyLength, _detectSentenceDensity]) {
    const warning = detector(body);
    if (warning) warnings.push(warning);
  }
  return warnings;
}

module.exports = {
  lint,
  // Exported for test parity + future extensibility per Q2 hook
  WATCHWORDS,
  THRESHOLDS: {
    chain_segments: THRESHOLD_CHAIN_SEGMENTS,
    watchword_count: THRESHOLD_WATCHWORD_COUNT,
    body_length: THRESHOLD_BODY_LENGTH,
    sentence_density_words: THRESHOLD_SENTENCE_DENSITY_WORDS,
    sample_max_chars: SAMPLE_MAX_CHARS,
  },
};

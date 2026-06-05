// CP12.2 Phase 1 (2026-06-04): sandboxed policy-DSL evaluator.
// Per ratified ADR-0030 v1.1 + secops Refinement 1 (mandatory pre-ship):
//   - purely functional: no fs, no net, no spawn, no eval/Function/vm
//   - bounded eval: per-rule timeoutMs (default 100ms) + memoryCapBytes heuristic
//   - eval failure (timeout / parse / out-of-bounds) → matched:false + error set
//
// Grammar:
//   predicate  := expression
//   expression := orExpr
//   orExpr     := andExpr ('or' andExpr)*
//   andExpr    := notExpr ('and' notExpr)*
//   notExpr    := 'not' notExpr | atom
//   atom       := '(' expression ')' | comparison
//   comparison := path operator literal
//   path       := IDENT ('.' IDENT)*
//   operator   := '==' | '!=' | 'matches' | 'contains' | 'startsWith' | 'endsWith'
//               | '>=' | '<=' | '>' | '<'
//   literal    := STRING | NUMBER | BOOLEAN | REGEX
//
// Hard constraints:
//   - No eval/Function/vm; real recursive-descent parser.
//   - Recursion depth bounded at MAX_DEPTH=64.
//   - Regex pattern length capped at 200; reject nested-quantifier shape.
//   - Prohibited identifiers rejected at validate AND at evaluate.
//   - Deadline check before each comparison + during regex execution short-circuit.

'use strict';

const DEFAULT_TIMEOUT_MS = 100;
const DEFAULT_MEMORY_CAP_BYTES = 1024 * 1024; // 1MB
const MAX_DEPTH = 64;
const MAX_REGEX_LEN = 200;
const MAX_CAPTURE_LEN = 4096;
const MAX_DSL_LEN = 8192;

const PROHIBITED_TOKENS = new Set([
  'eval', 'Function', 'process', 'require', '__proto__',
  'constructor', 'prototype', 'global', 'globalThis', 'module',
  'exports', 'Buffer', 'setTimeout', 'setInterval', 'fetch',
  'import', 'this',
]);

const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false']);
const WORD_OPERATORS = new Set(['matches', 'contains', 'startsWith', 'endsWith']);

// ─── tokenizer ──────────────────────────────────────────────────────────────

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }

    if (c === '(' || c === ')') {
      tokens.push({ type: c === '(' ? 'lparen' : 'rparen', value: c, pos: i });
      i += 1;
      continue;
    }

    // multi-char operators: == != >= <=
    if (c === '=' && src[i + 1] === '=') {
      tokens.push({ type: 'op', value: '==', pos: i });
      i += 2;
      continue;
    }
    if (c === '!' && src[i + 1] === '=') {
      tokens.push({ type: 'op', value: '!=', pos: i });
      i += 2;
      continue;
    }
    if (c === '>' && src[i + 1] === '=') {
      tokens.push({ type: 'op', value: '>=', pos: i });
      i += 2;
      continue;
    }
    if (c === '<' && src[i + 1] === '=') {
      tokens.push({ type: 'op', value: '<=', pos: i });
      i += 2;
      continue;
    }
    if (c === '>' || c === '<') {
      tokens.push({ type: 'op', value: c, pos: i });
      i += 1;
      continue;
    }

    // string literal: double-quoted (with \" \\ escapes) or single-quoted
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let value = '';
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < n) {
          const esc = src[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === '\\') value += '\\';
          else if (esc === quote) value += quote;
          else value += esc;
          j += 2;
        } else {
          value += src[j];
          j += 1;
        }
      }
      if (j >= n) throw new Error(`unterminated string literal at pos ${i}`);
      tokens.push({ type: 'string', value, pos: i });
      i = j + 1;
      continue;
    }

    // regex literal: /pattern/flags
    if (c === '/') {
      let j = i + 1;
      let pattern = '';
      while (j < n && src[j] !== '/') {
        if (src[j] === '\\' && j + 1 < n) {
          pattern += src[j] + src[j + 1];
          j += 2;
        } else {
          pattern += src[j];
          j += 1;
        }
      }
      if (j >= n) throw new Error(`unterminated regex literal at pos ${i}`);
      let k = j + 1;
      let flags = '';
      while (k < n && /[gimsuy]/.test(src[k])) {
        flags += src[k];
        k += 1;
      }
      tokens.push({ type: 'regex', value: { pattern, flags }, pos: i });
      i = k;
      continue;
    }

    // number literal: int, float, negative
    if ((c >= '0' && c <= '9') || (c === '-' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      if (c === '-') j += 1;
      while (j < n && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) {
        j += 1;
      }
      const numStr = src.slice(i, j);
      const num = Number(numStr);
      if (Number.isNaN(num)) throw new Error(`invalid number ${numStr} at pos ${i}`);
      tokens.push({ type: 'number', value: num, pos: i });
      i = j;
      continue;
    }

    // identifier / keyword / word-operator
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_.]/.test(src[j])) {
        j += 1;
      }
      const word = src.slice(i, j);
      if (word === 'and' || word === 'or' || word === 'not') {
        tokens.push({ type: 'logical', value: word, pos: i });
      } else if (word === 'true' || word === 'false') {
        tokens.push({ type: 'boolean', value: word === 'true', pos: i });
      } else if (WORD_OPERATORS.has(word)) {
        tokens.push({ type: 'op', value: word, pos: i });
      } else {
        tokens.push({ type: 'ident', value: word, pos: i });
      }
      i = j;
      continue;
    }

    throw new Error(`unexpected character '${c}' at pos ${i}`);
  }

  tokens.push({ type: 'eof', pos: n });
  return tokens;
}

// ─── parser (recursive descent) ─────────────────────────────────────────────

function parse(src) {
  if (typeof src !== 'string') throw new Error('predicate must be a string');
  if (src.length > MAX_DSL_LEN) throw new Error(`predicate too long (${src.length} > ${MAX_DSL_LEN})`);

  const tokens = tokenize(src);
  let pos = 0;
  let depth = 0;

  function peek() { return tokens[pos]; }
  function consume() { return tokens[pos++]; }
  function expect(type, value) {
    const tok = tokens[pos];
    if (tok.type !== type || (value !== undefined && tok.value !== value)) {
      throw new Error(`expected ${value || type}, got ${tok.type}:${JSON.stringify(tok.value)} at pos ${tok.pos}`);
    }
    return consume();
  }

  function enter() {
    depth += 1;
    if (depth > MAX_DEPTH) throw new Error(`expression depth exceeds ${MAX_DEPTH}`);
  }
  function leave() { depth -= 1; }

  function parseExpression() {
    enter();
    const node = parseOr();
    leave();
    return node;
  }

  function parseOr() {
    let left = parseAnd();
    while (peek().type === 'logical' && peek().value === 'or') {
      consume();
      const right = parseAnd();
      left = { kind: 'logical', op: 'or', left, right };
    }
    return left;
  }

  function parseAnd() {
    let left = parseNot();
    while (peek().type === 'logical' && peek().value === 'and') {
      consume();
      const right = parseNot();
      left = { kind: 'logical', op: 'and', left, right };
    }
    return left;
  }

  function parseNot() {
    if (peek().type === 'logical' && peek().value === 'not') {
      consume();
      enter();
      const inner = parseNot();
      leave();
      return { kind: 'not', inner };
    }
    return parseAtom();
  }

  function parseAtom() {
    const tok = peek();
    if (tok.type === 'lparen') {
      consume();
      enter();
      const inner = parseExpression();
      leave();
      expect('rparen');
      return inner;
    }
    return parseComparison();
  }

  function parseComparison() {
    const pathTok = expect('ident');
    const segments = pathTok.value.split('.');
    for (const seg of segments) {
      if (PROHIBITED_TOKENS.has(seg)) {
        throw new Error(`prohibited identifier '${seg}'`);
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(seg)) {
        throw new Error(`invalid path segment '${seg}'`);
      }
    }

    const opTok = peek();
    if (opTok.type !== 'op') {
      throw new Error(`expected operator after path '${pathTok.value}' at pos ${opTok.pos}`);
    }
    consume();

    const litTok = peek();
    let literal;
    if (litTok.type === 'string' || litTok.type === 'number' || litTok.type === 'boolean') {
      literal = { kind: 'literal', valueType: litTok.type, value: litTok.value };
      consume();
    } else if (litTok.type === 'regex') {
      const { pattern, flags } = litTok.value;
      if (pattern.length > MAX_REGEX_LEN) {
        throw new Error(`regex pattern too long (${pattern.length} > ${MAX_REGEX_LEN})`);
      }
      // reject nested-quantifier catastrophic-backtrack vectors
      if (/\([^)]*[+*][^)]*\)[+*]/.test(pattern)) {
        throw new Error(`regex contains nested quantifier (catastrophic-backtrack risk)`);
      }
      // reject sequential-overlapping quantifiers like /a*a*a*/ (3+ consecutive
      // single-char-quantifier pairs) — exponential-backtrack ReDoS vector
      // that single sync regex.test() can't be interrupted from. JS regex
      // engine is non-interruptible mid-call, so reject-at-parse is the only
      // reliable defense.
      if (/(?:[A-Za-z0-9_][*+]){3,}/.test(pattern)) {
        throw new Error(`regex contains sequential-overlapping quantifiers (catastrophic-backtrack risk)`);
      }
      let compiled;
      try {
        compiled = new RegExp(pattern, flags || '');
      } catch (e) {
        throw new Error(`invalid regex /${pattern}/${flags}: ${e.message}`);
      }
      literal = { kind: 'literal', valueType: 'regex', value: compiled, pattern };
      consume();
    } else {
      throw new Error(`expected literal after operator at pos ${litTok.pos}`);
    }

    if (literal.valueType === 'regex' && opTok.value !== 'matches') {
      throw new Error(`regex literal only valid with 'matches' operator`);
    }
    if (opTok.value === 'matches' && literal.valueType !== 'regex') {
      throw new Error(`'matches' requires a regex literal`);
    }

    return {
      kind: 'comparison',
      path: segments,
      op: opTok.value,
      literal,
    };
  }

  const root = parseExpression();
  if (peek().type !== 'eof') {
    throw new Error(`unexpected token after expression at pos ${peek().pos}`);
  }
  return root;
}

// ─── validate (parse-time) ─────────────────────────────────────────────────

function validate(predicateDsl) {
  const errors = [];
  try {
    if (typeof predicateDsl !== 'string') {
      errors.push('predicate must be a string');
      return { ok: false, errors };
    }
    // pre-scan for prohibited tokens (substring check catches sneak attempts in strings/regex too)
    for (const tok of PROHIBITED_TOKENS) {
      const re = new RegExp(`\\b${tok}\\b`);
      if (re.test(predicateDsl)) {
        errors.push(`prohibited token '${tok}'`);
      }
    }
    if (errors.length) return { ok: false, errors };

    parse(predicateDsl);
    return { ok: true, errors: [] };
  } catch (e) {
    errors.push(e.message);
    return { ok: false, errors };
  }
}

// ─── evaluator ─────────────────────────────────────────────────────────────

function resolvePath(obj, segments) {
  let cur = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    // strict own-property only — blocks __proto__ / constructor / prototype walking
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function checkDeadline(deadline) {
  if (Date.now() > deadline) {
    const err = new Error('timeout');
    err.code = 'timeout';
    throw err;
  }
}

function approximateSize(value, depth = 0) {
  if (depth > 8) return 0;
  if (value === null || value === undefined) return 4;
  if (typeof value === 'boolean') return 4;
  if (typeof value === 'number') return 8;
  if (typeof value === 'string') return value.length * 2;
  if (Array.isArray(value)) {
    let sum = 16;
    for (let i = 0; i < value.length && i < 1000; i += 1) {
      sum += approximateSize(value[i], depth + 1);
      if (sum > DEFAULT_MEMORY_CAP_BYTES * 2) return sum;
    }
    return sum;
  }
  if (typeof value === 'object') {
    let sum = 16;
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length && i < 1000; i += 1) {
      sum += keys[i].length * 2;
      sum += approximateSize(value[keys[i]], depth + 1);
      if (sum > DEFAULT_MEMORY_CAP_BYTES * 2) return sum;
    }
    return sum;
  }
  return 16;
}

function evalNode(node, obj, deadline) {
  checkDeadline(deadline);
  if (node.kind === 'logical') {
    if (node.op === 'and') {
      const l = evalNode(node.left, obj, deadline);
      if (!l) return false;
      return evalNode(node.right, obj, deadline);
    }
    // or
    const l = evalNode(node.left, obj, deadline);
    if (l) return true;
    return evalNode(node.right, obj, deadline);
  }
  if (node.kind === 'not') {
    return !evalNode(node.inner, obj, deadline);
  }
  if (node.kind === 'comparison') {
    return evalComparison(node, obj, deadline);
  }
  throw new Error(`unknown node kind ${node.kind}`);
}

function evalComparison(node, obj, deadline) {
  const lhs = resolvePath(obj, node.path);
  const lit = node.literal;
  const op = node.op;

  switch (op) {
    case '==':
      return lhs === lit.value;
    case '!=':
      return lhs !== lit.value;
    case '>':
      return typeof lhs === 'number' && lhs > lit.value;
    case '<':
      return typeof lhs === 'number' && lhs < lit.value;
    case '>=':
      return typeof lhs === 'number' && lhs >= lit.value;
    case '<=':
      return typeof lhs === 'number' && lhs <= lit.value;
    case 'contains':
      if (typeof lhs === 'string') return lhs.includes(String(lit.value));
      if (Array.isArray(lhs)) return lhs.includes(lit.value);
      return false;
    case 'startsWith':
      return typeof lhs === 'string' && lhs.startsWith(String(lit.value));
    case 'endsWith':
      return typeof lhs === 'string' && lhs.endsWith(String(lit.value));
    case 'matches': {
      if (typeof lhs !== 'string') return false;
      // bound captured-string length for memory safety
      const subject = lhs.length > MAX_CAPTURE_LEN ? lhs.slice(0, MAX_CAPTURE_LEN) : lhs;
      checkDeadline(deadline);
      const result = lit.value.test(subject);
      checkDeadline(deadline);
      return result;
    }
    default:
      throw new Error(`unknown operator ${op}`);
  }
}

function evaluate(predicateDsl, auditObject, opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const memoryCapBytes = opts.memoryCapBytes || DEFAULT_MEMORY_CAP_BYTES;

  // memory cap on input audit object (heuristic)
  try {
    const sz = approximateSize(auditObject);
    if (sz > memoryCapBytes) {
      return { matched: false, error: 'memory-cap' };
    }
  } catch {
    return { matched: false, error: 'memory-cap' };
  }

  let ast;
  try {
    ast = parse(predicateDsl);
  } catch (e) {
    return { matched: false, error: `parse: ${e.message}` };
  }

  const deadline = Date.now() + timeoutMs;
  try {
    const matched = !!evalNode(ast, auditObject || {}, deadline);
    return { matched, detail: { evaluatedAt: new Date().toISOString() } };
  } catch (e) {
    if (e.code === 'timeout') {
      return { matched: false, error: 'timeout' };
    }
    return { matched: false, error: `eval: ${e.message}` };
  }
}

module.exports = {
  validate,
  evaluate,
  // exported for tests:
  _parse: parse,
  _tokenize: tokenize,
  PROHIBITED_TOKENS,
  MAX_DEPTH,
  MAX_REGEX_LEN,
};

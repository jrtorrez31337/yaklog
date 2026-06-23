// Concurrency-limit middleware tests per cascade-prevention #10535
// substrate-design Option (b). Direct middleware unit tests with mocked
// req/res — supertest's lazy-fire doesn't model concurrent in-flight cleanly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createConcurrencyLimiter } = require('../src/middleware/concurrencyLimit');

function mockReqRes() {
  const req = {};
  const res = new EventEmitter();
  res.statusCode = 200;
  res._json = null;
  res._headers = {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res._json = b; res.emit('finish'); return res; };
  res.setHeader = (k, v) => { res._headers[k.toLowerCase()] = v; };
  return { req, res };
}

test('limiter: accepts ≤ maxInFlight; rejects > maxInFlight with 429 + Retry-After', () => {
  const limiter = createConcurrencyLimiter({ maxInFlight: 2, retryAfterS: 7, name: 'test1' });
  const { req: r1, res: s1 } = mockReqRes();
  const { req: r2, res: s2 } = mockReqRes();
  const { req: r3, res: s3 } = mockReqRes();
  let n1 = 0, n2 = 0, n3 = 0;
  limiter(r1, s1, () => { n1 += 1; });  // accepted
  limiter(r2, s2, () => { n2 += 1; });  // accepted
  limiter(r3, s3, () => { n3 += 1; });  // rejected (over cap)
  assert.equal(n1, 1, 'first accepted');
  assert.equal(n2, 1, 'second accepted');
  assert.equal(n3, 0, 'third rejected (no next() call)');
  assert.equal(s3.statusCode, 429);
  assert.equal(s3._json.error, 'TooManyConcurrentRequests');
  assert.equal(s3._json.retry_after_seconds, 7);
  assert.equal(s3._headers['retry-after'], '7');
  assert.equal(limiter.stats().inFlight, 2);
  assert.equal(limiter.stats().totalAccepted, 2);
  assert.equal(limiter.stats().totalRejected, 1);
});

test('limiter: inFlight decrements on res finish', () => {
  const limiter = createConcurrencyLimiter({ maxInFlight: 1, name: 'test2' });
  const { req: r1, res: s1 } = mockReqRes();
  limiter(r1, s1, () => {});
  assert.equal(limiter.stats().inFlight, 1);
  s1.emit('finish');  // release
  assert.equal(limiter.stats().inFlight, 0, 'inFlight back to 0 after finish');
  // Now next request should be accepted
  const { req: r2, res: s2 } = mockReqRes();
  let n2 = 0;
  limiter(r2, s2, () => { n2 += 1; });
  assert.equal(n2, 1, 'subsequent accepted');
});

test('limiter: inFlight decrements on res close (client disconnect)', () => {
  const limiter = createConcurrencyLimiter({ maxInFlight: 1, name: 'test3' });
  const { req: r1, res: s1 } = mockReqRes();
  limiter(r1, s1, () => {});
  assert.equal(limiter.stats().inFlight, 1);
  s1.emit('close');
  assert.equal(limiter.stats().inFlight, 0);
});

test('limiter: double-release safe (finish then close should not double-decrement)', () => {
  const limiter = createConcurrencyLimiter({ maxInFlight: 2, name: 'test4' });
  const { req: r1, res: s1 } = mockReqRes();
  limiter(r1, s1, () => {});
  s1.emit('finish');
  assert.equal(limiter.stats().inFlight, 0);
  s1.emit('close');  // second release; should be no-op
  assert.equal(limiter.stats().inFlight, 0, 'no double-decrement');
});

test('limiter: rejection response identifies route_family + message includes name', () => {
  const limiter = createConcurrencyLimiter({ maxInFlight: 1, name: 'audit-policy' });
  const { req: r1, res: s1 } = mockReqRes();
  limiter(r1, s1, () => {});
  const { req: r2, res: s2 } = mockReqRes();
  limiter(r2, s2, () => {});
  assert.equal(s2._json.route_family, 'audit-policy');
  assert.match(s2._json.message, /audit-policy/);
});

test('limiter: stats() snapshot is immutable view', () => {
  const limiter = createConcurrencyLimiter({ maxInFlight: 3, name: 'test5' });
  limiter._resetForTest();
  const s1 = limiter.stats();
  const { req, res } = mockReqRes();
  limiter(req, res, () => {});
  const s2 = limiter.stats();
  assert.equal(s1.inFlight, 0, 'snapshot reflects pre-call state');
  assert.equal(s2.inFlight, 1, 'new snapshot reflects post-call state');
});

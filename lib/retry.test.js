// Guards the retry added after run #35563917437, where blankenfelde
// screenshotted fine and then died on "The operation was aborted due to
// timeout" 30s later with no second attempt. The point of these tests is the
// SPLIT: a timeout or a 5xx is the platform having a bad moment and is worth
// another go; a 401 or a 413 is us being wrong and must fail on the spot.
const test = require('node:test');
const assert = require('node:assert');
const { isTransient, withRetry } = require('../run.js');

const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
const timeoutErr = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

test('isTransient', async (t) => {
  await t.test('a fetch timeout is transient -- this is the observed failure', () => {
    assert.equal(isTransient(timeoutErr()), true);
  });

  await t.test('an abort is transient', () => {
    assert.equal(isTransient(Object.assign(new Error('aborted'), { name: 'AbortError' })), true);
  });

  await t.test('undici connection failure is transient', () => {
    assert.equal(isTransient(new TypeError('fetch failed')), true);
  });

  await t.test('5xx and 429 are transient', () => {
    for (const s of [500, 502, 503, 504, 429]) {
      assert.equal(isTransient(httpErr(s)), true, `HTTP ${s} should retry`);
    }
  });

  await t.test('4xx is NOT transient -- retrying a bad token just delays the real error', () => {
    for (const s of [400, 401, 403, 404, 413, 422]) {
      assert.equal(isTransient(httpErr(s)), false, `HTTP ${s} must not retry`);
    }
  });

  await t.test('a byte-mismatch error is not transient at this layer', () => {
    assert.equal(isTransient(new Error('read-back bytes differ from uploaded bytes')), false);
  });
});

test('withRetry', async (t) => {
  await t.test('returns the first success without retrying', async () => {
    let calls = 0;
    const out = await withRetry('x', async () => { calls++; return 'ok'; }, { attempts: 3, backoffMs: 1 });
    assert.equal(out, 'ok');
    assert.equal(calls, 1);
  });

  await t.test('recovers from a timeout on a later attempt', async () => {
    let calls = 0;
    const out = await withRetry('x', async () => {
      calls++;
      if (calls < 3) throw timeoutErr();
      return 'ok';
    }, { attempts: 3, backoffMs: 1 });
    assert.equal(out, 'ok');
    assert.equal(calls, 3);
  });

  await t.test('gives up after the budget and rethrows the last error', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry('x', async () => { calls++; throw timeoutErr(); }, { attempts: 3, backoffMs: 1 }),
      /aborted due to timeout/);
    assert.equal(calls, 3);
  });

  await t.test('does not retry a non-transient error', async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry('x', async () => { calls++; throw httpErr(401); }, { attempts: 3, backoffMs: 1 }),
      /HTTP 401/);
    assert.equal(calls, 1, 'a 401 must be attempted exactly once');
  });
});

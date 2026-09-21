import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson, retrying, createLimiter, HttpError, isRetryable } from '../../lib/http.js';

// A scripted fetch: each call takes the next step. A step is a Response-like object, or an Error to throw.
function scriptedFetch(steps) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  impl.calls = calls;
  return impl;
}
const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const status = (code, headers = {}) => ({ ok: false, status: code, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => ({}) });
const noSleep = () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  sleep.sleeps = sleeps;
  return sleep;
};

test('fetchJson returns the parsed body on a first-try success, with no waiting', async () => {
  const sleep = noSleep();
  const fetchImpl = scriptedFetch([ok({ a: 1 })]);
  assert.deepEqual(await fetchJson('https://x/y', { fetchImpl, sleep }), { a: 1 });
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(sleep.sleeps, []);
});

// Regression for "Not available" on Brazil/Russia: Wikimedia answers 429 (and, without CORS headers on
// that response, the browser reports a bare network error) when it is busy. One attempt used to be final.
test('a 429 is retried, then succeeds', async () => {
  const sleep = noSleep();
  const fetchImpl = scriptedFetch([status(429), ok({ done: true })]);
  assert.deepEqual(await fetchJson('https://x/y', { fetchImpl, sleep }), { done: true });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(sleep.sleeps.length, 1);
});

test('server errors and network failures are retried too', async () => {
  for (const failure of [status(500), status(502), status(503), status(504), new TypeError('Failed to fetch')]) {
    const fetchImpl = scriptedFetch([failure, ok({ n: 1 })]);
    assert.deepEqual(await fetchJson('https://x/y', { fetchImpl, sleep: noSleep() }), { n: 1 }, String(failure.status ?? failure.message));
  }
});

test('a request that hangs is aborted at the timeout and retried', async () => {
  let calls = 0;
  const fetchImpl = (url, { signal }) => {
    calls++;
    if (calls === 1) return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    return Promise.resolve(ok({ recovered: true }));
  };
  assert.deepEqual(await fetchJson('https://x/y', { fetchImpl, sleep: noSleep(), timeoutMs: 20 }), { recovered: true });
  assert.equal(calls, 2);
});

test('client errors (404, 400, 403) are NOT retried: they will not get better', async () => {
  for (const code of [400, 403, 404]) {
    const fetchImpl = scriptedFetch([status(code), ok({ never: true })]);
    await assert.rejects(fetchJson('https://x/y', { fetchImpl, sleep: noSleep() }), (error) => error instanceof HttpError && error.status === code);
    assert.equal(fetchImpl.calls.length, 1, `HTTP ${code}`);
  }
});

test('it gives up after the configured retries and throws the last error', async () => {
  const fetchImpl = scriptedFetch([status(503)]);
  await assert.rejects(fetchJson('https://x/y', { fetchImpl, sleep: noSleep(), retries: 2 }), (error) => error instanceof HttpError && error.status === 503);
  assert.equal(fetchImpl.calls.length, 3); // first try + 2 retries
});

test('backoff grows between attempts', async () => {
  const sleep = noSleep();
  await assert.rejects(fetchJson('https://x/y', { fetchImpl: scriptedFetch([status(503)]), sleep, retries: 3, baseDelayMs: 100 }));
  assert.equal(sleep.sleeps.length, 3);
  assert.ok(sleep.sleeps[0] < sleep.sleeps[1] && sleep.sleeps[1] < sleep.sleeps[2], `delays ${sleep.sleeps}`);
});

test('a Retry-After header sets the wait exactly, without jitter', async () => {
  const sleep = noSleep();
  await fetchJson('https://x/y', { fetchImpl: scriptedFetch([status(429, { 'retry-after': '2' }), ok({})]), sleep });
  assert.equal(sleep.sleeps[0], 2000);
});

// Found by review: a 429 asking for 10 minutes was retried after 5 s anyway — hitting a server that had
// just said it is still throttling us, and every parallel request did the same.
test('a Retry-After longer than a page can wait for means give up now: no wait, no further attempt', async () => {
  const sleep = noSleep();
  const fetchImpl = scriptedFetch([status(429, { 'retry-after': '600' }), ok({ never: true })]);
  await assert.rejects(fetchJson('https://x/y', { fetchImpl, sleep }), (error) => error instanceof HttpError && error.status === 429);
  assert.equal(fetchImpl.calls.length, 1);
  assert.deepEqual(sleep.sleeps, []);
  const atTheCap = noSleep();
  await fetchJson('https://x/y', { fetchImpl: scriptedFetch([status(429, { 'retry-after': '5' }), ok({})]), sleep: atTheCap });
  assert.deepEqual(atTheCap.sleeps, [5000], 'up to the cap is honoured');
});

// Found by review: 43 parallel requests all retried at exactly +0.4 s and +1.2 s — a synchronized wave
// aimed at a server that had just said it was busy.
test('backoff is jittered by up to ±25%, so parallel retries do not arrive in lockstep', async () => {
  const delayFor = async (random) => {
    const sleep = noSleep();
    await fetchJson('https://x/y', { fetchImpl: scriptedFetch([status(503), ok({})]), sleep, baseDelayMs: 400, random });
    return sleep.sleeps[0];
  };
  assert.equal(await delayFor(() => 0), 300);
  assert.equal(await delayFor(() => 0.5), 400);
  assert.equal(await delayFor(() => 1), 500);
  const real = new Set();
  for (let i = 0; i < 12; i++) real.add(await delayFor(Math.random));
  assert.ok(real.size > 1, 'the default source of randomness actually varies the delay');
});

test('isRetryable: transient statuses, network errors and aborts yes; everything else no', () => {
  assert.equal(isRetryable(new HttpError(429, 'u')), true);
  assert.equal(isRetryable(new HttpError(503, 'u')), true);
  assert.equal(isRetryable(new HttpError(404, 'u')), false);
  assert.equal(isRetryable(new TypeError('Failed to fetch')), true);
  assert.equal(isRetryable(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isRetryable(new RangeError('bug')), false);
});

test('retrying() retries any operation on errors its predicate accepts, and only those', async () => {
  let attempts = 0;
  const result = await retrying(async () => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error('busy'), { transient: true });
    return 'finally';
  }, { retries: 3, sleep: noSleep(), isRetryable: (e) => e.transient });
  assert.equal(result, 'finally');
  assert.equal(attempts, 3);

  let tries = 0;
  await assert.rejects(retrying(async () => { tries++; throw new Error('permanent'); }, { retries: 3, sleep: noSleep(), isRetryable: () => false }));
  assert.equal(tries, 1);
});

// ---- createLimiter: at most N requests to one host at a time ---------------------------------------------

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('createLimiter never runs more than the limit at once, and runs everything', async () => {
  const limit = createLimiter(3);
  let running = 0;
  let peak = 0;
  const done = [];
  await Promise.all(Array.from({ length: 12 }, (_, i) => limit(async () => {
    running++;
    peak = Math.max(peak, running);
    await tick();
    running--;
    done.push(i);
    return i;
  })));
  assert.equal(peak, 3);
  assert.equal(done.length, 12);
});

test('createLimiter starts queued work in the order it was asked for, and returns each result', async () => {
  const limit = createLimiter(1);
  const started = [];
  const results = await Promise.all([1, 2, 3, 4].map((n) => limit(async () => { started.push(n); await tick(); return n * 10; })));
  assert.deepEqual(started, [1, 2, 3, 4]);
  assert.deepEqual(results, [10, 20, 30, 40]);
});

test('createLimiter frees the slot when a task fails, and passes the failure on', async () => {
  const limit = createLimiter(1);
  await assert.rejects(limit(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await limit(async () => 'still works'), 'still works');
  await assert.rejects(limit(() => { throw new Error('sync boom'); }), /sync boom/);
  assert.equal(await limit(async () => 'and again'), 'and again');
});

test('createLimiter never exceeds the limit when a newcomer arrives just as a slot is released', async () => {
  const limit = createLimiter(1);
  let running = 0;
  let peak = 0;
  const task = async () => { running++; peak = Math.max(peak, running); await tick(); running--; };
  const first = limit(task);
  const queued = limit(task);
  await first; // the slot is handed to `queued`; a caller arriving right now must queue behind it
  const late = limit(task);
  await Promise.all([queued, late]);
  assert.equal(peak, 1);
});

// The limiter holds a slot per ATTEMPT, not per request: the timeout must start when the request is
// actually sent (a request waiting its turn was burning its budget), and a request sleeping through its
// backoff must not keep others out.
test('fetchJson: the timeout clock starts when the request is sent, not while it waits for a slot', async () => {
  const limit = createLimiter(1);
  const slowFirst = (url, { signal }) => new Promise((resolve) => setTimeout(() => resolve(ok({ n: 1 })), 80));
  const seenAborted = [];
  const promptSecond = async (url, { signal }) => { seenAborted.push(signal.aborted); return ok({ n: 2 }); };
  const [a, b] = await Promise.all([
    fetchJson('https://x/1', { fetchImpl: slowFirst, sleep: noSleep(), limit, timeoutMs: 500 }),
    fetchJson('https://x/2', { fetchImpl: promptSecond, sleep: noSleep(), limit, timeoutMs: 40 }), // shorter than the first request's 80 ms
  ]);
  assert.deepEqual([a, b], [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(seenAborted, [false]);
});

test('fetchJson: a request waiting out its backoff does not hold a slot', async () => {
  const limit = createLimiter(1);
  const events = [];
  let releaseBackoff;
  const sleep = () => new Promise((resolve) => { releaseBackoff = resolve; }); // the first request's backoff never ends by itself
  const failsOnce = scriptedFetch([status(503), ok({ retried: true })]);
  const first = fetchJson('https://x/1', { fetchImpl: failsOnce, sleep, limit });
  await tick();
  const second = await fetchJson('https://x/2', { fetchImpl: async () => { events.push('second ran while first was backing off'); return ok({ second: true }); }, sleep: noSleep(), limit });
  assert.deepEqual(second, { second: true });
  assert.equal(events.length, 1);
  releaseBackoff();
  assert.deepEqual(await first, { retried: true });
});

// Mutation testing by review: linear instead of exponential backoff left every test green (delays merely had to
// grow), and an unusable Retry-After (NaN, negative, an HTTP date) must never read as "retry at once".
test('backoff doubles each time: 1x, 2x, 4x the base delay (at the middle of the jitter)', async () => {
  const sleep = noSleep();
  await assert.rejects(fetchJson('https://x/y', { fetchImpl: scriptedFetch([status(503)]), sleep, retries: 3, baseDelayMs: 100, random: () => 0.5 }));
  assert.deepEqual(sleep.sleeps, [100, 200, 400]);
});

test('a Retry-After that is not a usable number of seconds falls back to the normal backoff', async () => {
  for (const value of ['soon', '-5', 'Wed, 21 Oct 2026 07:28:00 GMT', '', 'NaN']) {
    const sleep = noSleep();
    await fetchJson('https://x/y', { fetchImpl: scriptedFetch([status(429, { 'retry-after': value }), ok({})]), sleep, baseDelayMs: 400, random: () => 0.5 });
    assert.deepEqual(sleep.sleeps, [400], `Retry-After: "${value}"`);
  }
});

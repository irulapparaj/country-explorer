import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMediaWikiGet, MediaWikiApiError } from '../../lib/mediaWikiApi.js';
import { HttpError } from '../../lib/http.js';

// MediaWiki's Action API (Wikidata, Commons and Wikipedia all speak it) reports being busy, and some other
// failures, as HTTP 200 with an {error: {code, info}} body. A caller that reads only the body it expects takes
// that for "nothing there" — and, remembered, it stays "nothing there" for the whole visit. Found by review at
// two call sites (Commons file info, Wikipedia search) that had not been given the treatment the Wikidata one had.

// A fake fetchJson that answers from a script, recording every request with its options. No network, no timers.
function scripted(steps) {
  const calls = [];
  const fetchJson = async (url, options) => {
    calls.push({ url, options });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  fetchJson.calls = calls;
  return fetchJson;
}
const noSleep = async () => {};
const apiError = (code) => ({ error: { code, info: 'try later' } });

test('a good body comes back as it is, from ONE transport attempt (retrying is done here, not below)', async () => {
  const fetchJson = scripted([{ query: { ok: true } }]);
  const limit = (task) => task();
  const get = createMediaWikiGet({ fetchJson, sleep: noSleep, limit });
  assert.deepEqual(await get('https://x/api', { timeoutMs: 1234 }), { query: { ok: true } });
  assert.equal(fetchJson.calls.length, 1);
  assert.deepEqual(fetchJson.calls[0].options, { timeoutMs: 1234, retries: 0, sleep: noSleep, limit });
});

test('the busy-server codes (maxlag, ratelimited, readonly, internal_api_error_*) are retried until the server recovers', async () => {
  for (const code of ['maxlag', 'ratelimited', 'readonly', 'internal_api_error_DBQueryError']) {
    const fetchJson = scripted([apiError(code), apiError(code), { query: { recovered: code } }]);
    const body = await createMediaWikiGet({ fetchJson, sleep: noSleep })('https://x/api');
    assert.deepEqual(body, { query: { recovered: code } }, code);
    assert.equal(fetchJson.calls.length, 3, code);
  }
});

test('any other error code is permanent: thrown at once, with its code, and never repeated', async () => {
  const fetchJson = scripted([apiError('badvalue')]);
  await assert.rejects(createMediaWikiGet({ fetchJson, sleep: noSleep })('https://x/api'), (error) => error instanceof MediaWikiApiError && error.code === 'badvalue' && /badvalue/.test(error.message));
  assert.equal(fetchJson.calls.length, 1);
});

test('a server that stays busy is given up on after the retry budget (3 tries by default, 2 with retries: 1)', async () => {
  const stuck = scripted([apiError('maxlag')]);
  await assert.rejects(createMediaWikiGet({ fetchJson: stuck, sleep: noSleep })('https://x/api'), MediaWikiApiError);
  assert.equal(stuck.calls.length, 3);
  const fewer = scripted([apiError('maxlag')]);
  await assert.rejects(createMediaWikiGet({ fetchJson: fewer, sleep: noSleep })('https://x/api', { retries: 1 }), MediaWikiApiError);
  assert.equal(fewer.calls.length, 2);
});

test('network failures and 429/5xx are retried as well; a 404 is not', async () => {
  for (const failure of [new TypeError('Failed to fetch'), new HttpError(429, 'u'), new HttpError(503, 'u')]) {
    const fetchJson = scripted([failure, { query: {} }]);
    assert.deepEqual(await createMediaWikiGet({ fetchJson, sleep: noSleep })('https://x/api'), { query: {} });
    assert.equal(fetchJson.calls.length, 2);
  }
  const missing = scripted([new HttpError(404, 'u'), { query: {} }]);
  await assert.rejects(createMediaWikiGet({ fetchJson: missing, sleep: noSleep })('https://x/api'), HttpError);
  assert.equal(missing.calls.length, 1);
});

test('an empty or non-object body is handed back untouched for the caller to judge (this layer only knows {error})', async () => {
  for (const body of [{}, [], null]) {
    assert.deepEqual(await createMediaWikiGet({ fetchJson: scripted([body]), sleep: noSleep })('https://x/api'), body);
  }
});

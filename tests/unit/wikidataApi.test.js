import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWikidataApi } from '../../lib/wikidataClient.js';
import { HttpError } from '../../lib/http.js';

// A fake `fetchJson`: routes by URL, records every request, and can be told to fail. No network, no timers.
function fakeTransport(handlers) {
  const requests = [];
  const fetchJson = async (url) => {
    requests.push(url);
    const parsed = new URL(url, 'https://app.test/');
    for (const [matches, respond] of handlers) {
      if (matches(parsed)) return respond(parsed, requests.length);
    }
    throw new Error(`unexpected request: ${url}`);
  };
  return { fetchJson, requests, sleep: async () => {} };
}
const action = (name) => (u) => u.searchParams.get('action') === name;
const bundledIdsRequest = (u) => u.pathname.endsWith('wikidata-ids.json');
const entities = (map) => ({ entities: map });

// ---- transient API errors ---------------------------------------------------------------------------------

// The Action API reports being busy as HTTP 200 with an {error} body, which a plain "res.ok" check misses.
test('a transient API error (maxlag, ratelimited) is retried; a permanent one is not', async () => {
  let attempts = 0;
  const transport = fakeTransport([[action('wbgetclaims'), () => (++attempts < 3 ? { error: { code: 'maxlag', info: 'busy' } } : { claims: { P625: [] } })]]);
  const api = createWikidataApi(transport);
  assert.deepEqual(await api.getClaims('Q649', 'P625'), { claims: { P625: [] } });
  assert.equal(attempts, 3);

  const permanent = fakeTransport([[action('wbgetclaims'), () => ({ error: { code: 'no-such-entity', info: 'nope' } })]]);
  await assert.rejects(createWikidataApi(permanent).getClaims('Q0', 'P625'), /no-such-entity/);
  assert.equal(permanent.requests.length, 1, 'a permanent error is not worth repeating');
});

test('network-level failures and HTTP 429 are retried too, and give up after the retry budget', async () => {
  const transport = fakeTransport([[action('wbgetclaims'), () => { throw new HttpError(429, 'u'); }]]);
  await assert.rejects(createWikidataApi(transport).getClaims('Q1', 'P625'), /429/);
  assert.equal(transport.requests.length, 3); // first try + 2 retries
});

// ---- entity + claims ---------------------------------------------------------------------------------------

test('getEntity asks for the claims of one item and returns that item', async () => {
  const transport = fakeTransport([[action('wbgetentities'), () => entities({ Q155: { id: 'Q155', claims: { P36: [] } } })]]);
  const entity = await createWikidataApi(transport).getEntity('Q155');
  assert.equal(entity.id, 'Q155');
  const url = new URL(transport.requests[0]);
  assert.equal(url.searchParams.get('ids'), 'Q155');
  assert.equal(url.searchParams.get('props'), 'claims');
  assert.equal(url.searchParams.get('origin'), '*');
});

test('getEntity returns null for an item the API does not know', async () => {
  const transport = fakeTransport([[action('wbgetentities'), () => entities({})]]);
  assert.equal(await createWikidataApi(transport).getEntity('Q1'), null);
});

// ---- labels: batching and a shared cache --------------------------------------------------------------------

const labelResponder = (u) => entities(Object.fromEntries(u.searchParams.get('ids').split('|').map((id) => [id, { id, labels: { en: { value: `label of ${id}` } } }])));

test('labels are fetched in batches of 50, and a repeat request costs nothing', async () => {
  const transport = fakeTransport([[action('wbgetentities'), labelResponder]]);
  const api = createWikidataApi(transport);
  const ids = Array.from({ length: 120 }, (_, i) => `Q${i + 1}`);
  const labels = await api.getLabels(ids);
  assert.equal(transport.requests.length, 3); // 50 + 50 + 20
  assert.equal(labels.get('Q120'), 'label of Q120');
  await api.getLabels(ids.slice(0, 40));
  assert.equal(transport.requests.length, 3, 'already-known labels are reused');
});

test('only the labels not yet known are requested', async () => {
  const transport = fakeTransport([[action('wbgetentities'), labelResponder]]);
  const api = createWikidataApi(transport);
  await api.getLabels(['Q1', 'Q2']);
  await api.getLabels(['Q2', 'Q3']);
  assert.equal(new URL(transport.requests[1]).searchParams.get('ids'), 'Q3');
});

test('an id asked for twice at once is requested once', async () => {
  const transport = fakeTransport([[action('wbgetentities'), labelResponder]]);
  const api = createWikidataApi(transport);
  await Promise.all([api.getLabels(['Q1', 'Q2']), api.getLabels(['Q2', 'Q3'])]);
  const asked = transport.requests.flatMap((url) => new URL(url).searchParams.get('ids').split('|'));
  assert.equal(asked.filter((id) => id === 'Q2').length, 1);
});

test('a label falls back to the English Wikipedia title, and is null when neither exists', async () => {
  const transport = fakeTransport([[action('wbgetentities'), () => entities({ Q1: { id: 'Q1', labels: {}, sitelinks: { enwiki: { title: 'Euro (currency)' } } }, Q2: { id: 'Q2', labels: {} } })]]);
  const labels = await createWikidataApi(transport).getLabels(['Q1', 'Q2']);
  assert.equal(labels.get('Q1'), 'Euro (currency)');
  assert.equal(labels.get('Q2'), null);
});

// A failed label batch must not poison the cache: the next read has to ask again.
test('a failed label request is not remembered', async () => {
  let fail = true;
  const transport = fakeTransport([[action('wbgetentities'), (u) => { if (fail) throw new HttpError(503, 'u'); return labelResponder(u); }]]);
  const api = createWikidataApi(transport);
  await assert.rejects(api.getLabels(['Q1']), /503/);
  fail = false;
  assert.equal((await api.getLabels(['Q1'])).get('Q1'), 'label of Q1');
});

// Found by review: an id missing from a 200 response was cached as "no label" for the whole session.
test('an id the API silently left out of its answer is an error, not a permanent "no label"', async () => {
  let drop = true;
  const transport = fakeTransport([[action('wbgetentities'), (u) => { const all = labelResponder(u); if (drop) delete all.entities.Q2; return all; }]]);
  const api = createWikidataApi(transport);
  await assert.rejects(api.getLabels(['Q1', 'Q2']), /Q2/);
  drop = false;
  assert.equal((await api.getLabels(['Q2'])).get('Q2'), 'label of Q2');
});

// ---- ISO code -> item ------------------------------------------------------------------------------------------

test('resolveQid uses the bundled table and never searches for a code it contains', async () => {
  const transport = fakeTransport([[bundledIdsRequest, () => ({ BRA: 'Q155' })]]);
  assert.equal(await createWikidataApi(transport).resolveQid('BRA'), 'Q155');
  assert.equal(transport.requests.length, 1);
});

test('resolveQid falls back to searching Wikidata for a code that is not in the table', async () => {
  const transport = fakeTransport([
    [bundledIdsRequest, () => ({ BRA: 'Q155' })],
    [action('query'), () => ({ query: { search: [{ title: 'Q999' }, { title: 'Q1000' }] } })],
  ]);
  assert.equal(await createWikidataApi(transport).resolveQid('ZZZ'), 'Q999');
  const search = new URL(transport.requests.at(-1));
  assert.equal(search.searchParams.get('srsearch'), 'haswbstatement:P298=ZZZ');
});

test('the search uses Wikidata\'s own code for Kosovo (XKS), not ours (XKX)', async () => {
  const transport = fakeTransport([[bundledIdsRequest, () => ({})], [action('query'), () => ({ query: { search: [{ title: 'Q1246' }] } })]]);
  await createWikidataApi(transport).resolveQid('XKX');
  assert.equal(new URL(transport.requests.at(-1)).searchParams.get('srsearch'), 'haswbstatement:P298=XKS');
});

test('resolveQid is null when nothing matches', async () => {
  const transport = fakeTransport([[bundledIdsRequest, () => ({})], [action('query'), () => ({ query: { search: [] } })]]);
  assert.equal(await createWikidataApi(transport).resolveQid('ZZZ'), null);
});

// Found by review: one transient failure loading the table used to be remembered as "{}" for the session.
test('a failure to load the bundled table is not remembered: the next lookup tries the file again', async () => {
  let loads = 0;
  const transport = fakeTransport([
    [bundledIdsRequest, () => { loads++; if (loads === 1) throw new HttpError(503, 'u'); return { BRA: 'Q155' }; }],
    [action('query'), () => ({ query: { search: [{ title: 'Q155' }] } })],
  ]);
  const api = createWikidataApi({ ...transport, bundledIdsRetries: 0 });
  assert.equal(await api.resolveQid('BRA'), 'Q155'); // via search this time
  assert.equal(await api.resolveQid('BRA'), 'Q155'); // via the file
  assert.equal(loads, 2);
});

// ---- Commons (the anthem recording) --------------------------------------------------------------------------------

const commonsPage = (info) => ({ query: { pages: { 1: { imageinfo: [info] } } } });
const commons = (u) => u.hostname === 'commons.wikimedia.org';

test('file info gives the ogg URL, a derived mp3 URL, and the license without HTML', async () => {
  const transport = fakeTransport([[commons, () => commonsPage({
    url: 'https://upload.wikimedia.org/wikipedia/commons/f/fc/Russian_Anthem_chorus.ogg?utm_source=commons',
    extmetadata: { LicenseShortName: { value: 'CC BY 4.0' }, Credit: { value: '<a href="x">Own work</a> by <b>Someone</b>' } },
  })]]);
  const info = await createWikidataApi(transport).getCommonsFileInfo('Russian Anthem chorus.ogg');
  assert.equal(info.oggUrl, 'https://upload.wikimedia.org/wikipedia/commons/f/fc/Russian_Anthem_chorus.ogg');
  assert.equal(info.mp3Url, 'https://upload.wikimedia.org/wikipedia/commons/transcoded/f/fc/Russian_Anthem_chorus.ogg/Russian_Anthem_chorus.ogg.mp3');
  assert.deepEqual(info.license, { shortName: 'CC BY 4.0', credit: 'Own work by Someone' });
  assert.equal(new URL(transport.requests[0]).searchParams.get('titles'), 'File:Russian Anthem chorus.ogg');
});

test('a file Commons has no info for gives null, not an error', async () => {
  const transport = fakeTransport([[commons, () => ({ query: { pages: { '-1': { missing: '' } } } })]]);
  assert.equal(await createWikidataApi(transport).getCommonsFileInfo('Nope.ogg'), null);
});

// Found by review: Commons answered {error: ...} with HTTP 200 and that was read as "no info for this file" —
// the anthem came back without its MP3 (Safari's only playable source), was reported complete, and was remembered.
test('a Commons busy-error (HTTP 200 with an error body) is retried once, then read normally', async () => {
  let attempts = 0;
  const transport = fakeTransport([[commons, () => (++attempts < 2 ? { error: { code: 'internal_api_error_DBQueryError', info: 'busy' } } : commonsPage({ url: 'https://upload.wikimedia.org/wikipedia/commons/f/fc/A.ogg' }))]]);
  const info = await createWikidataApi(transport).getCommonsFileInfo('A.ogg');
  assert.equal(info.oggUrl, 'https://upload.wikimedia.org/wikipedia/commons/f/fc/A.ogg');
  assert.equal(attempts, 2);
});

test('a Commons error that will not go away FAILS the lookup; it is not "no info"', async () => {
  const stuck = fakeTransport([[commons, () => ({ error: { code: 'maxlag', info: 'busy' } })]]);
  await assert.rejects(createWikidataApi(stuck).getCommonsFileInfo('A.ogg'), /maxlag/);
  assert.equal(stuck.requests.length, 2, 'one try and one retry: this is the anthem\'s optional last step');
  const permanent = fakeTransport([[commons, () => ({ error: { code: 'badtitle', info: 'no' } })]]);
  await assert.rejects(createWikidataApi(permanent).getCommonsFileInfo('A.ogg'), /badtitle/);
});

test('a Commons answer with no query result at all is a failure, while a query that finds no such file is null', async () => {
  for (const body of [{}, { batchcomplete: '' }, { query: {} }]) {
    await assert.rejects(createWikidataApi(fakeTransport([[commons, () => body]])).getCommonsFileInfo('A.ogg'), /no query result/i, JSON.stringify(body));
  }
  assert.equal(await createWikidataApi(fakeTransport([[commons, () => ({ query: { pages: { '-1': { missing: '' } } } })]])).getCommonsFileInfo('Nope.ogg'), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMajorCitiesDynamic, fetchTouristAttractions, fetchReligions } from '../../lib/wikidataClient.js';

// The Query Service extras (cities, attractions, religion) are best-effort BY DESIGN: the panel's own facts
// never depend on them, and each has a local-file fallback. These tests pin how rows are read and that any
// failure degrades to the fallback signal ([] / null) rather than an exception.

const binding = (fields) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { value: String(value) }]));
const answer = (bindings) => ({ ok: true, status: 200, json: async () => ({ results: { bindings } }) });

const realFetch = globalThis.fetch; // captured once, so every restore below puts back the real one

// Runs `body` with global fetch replaced, recording the URLs asked for.
async function withFetch(t, impl, body) {
  const urls = [];
  globalThis.fetch = async (url, options) => { urls.push(String(url)); return impl(url, options); };
  t.after(() => { globalThis.fetch = realFetch; });
  return { result: await body(), urls };
}

test('cities: name + coordinates are read, and rows missing either are dropped', async (t) => {
  const rows = [
    binding({ placeLabel: 'Mumbai', lat: 19.07, lon: 72.87 }),
    binding({ placeLabel: 'No coordinates' }),
    binding({ lat: 1, lon: 2 }),
    binding({ placeLabel: 'Delhi', lat: 28.61, lon: 77.2 }),
  ];
  const { result } = await withFetch(t, async () => answer(rows), () => fetchMajorCitiesDynamic('IND'));
  assert.deepEqual(result, [{ name: 'Mumbai', coord: { lat: 19.07, lng: 72.87 } }, { name: 'Delhi', coord: { lat: 28.61, lng: 77.2 } }]);
});

test('attractions read the same way', async (t) => {
  const { result } = await withFetch(t, async () => answer([binding({ placeLabel: 'Taj Mahal', lat: 27.17, lon: 78.04 })]), () => fetchTouristAttractions('IND'));
  assert.deepEqual(result, [{ name: 'Taj Mahal', coord: { lat: 27.17, lng: 78.04 }, wikiUrl: null, wikiTitle: null, imageUrl: null }]);
});

test('Kosovo is asked for by the code Wikidata carries (XKS), not ours (XKX)', async (t) => {
  const { urls } = await withFetch(t, async () => answer([]), () => fetchMajorCitiesDynamic('XKX'));
  assert.match(decodeURIComponent(urls[0]), /wdt:P298 "XKS"/);
  assert.doesNotMatch(decodeURIComponent(urls[0]), /"XKX"/);
});

test('a refused, failed or unreachable Query Service degrades to "no dynamic result" (the local fallback), never an exception — but the failure is MARKED', async (t) => {
  for (const impl of [async () => ({ ok: false, status: 429, json: async () => ({}) }), async () => { throw new TypeError('Failed to fetch'); }, async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } })]) {
    const cities = await withFetch(t, impl, () => fetchMajorCitiesDynamic('IND'));
    const attractions = await withFetch(t, impl, () => fetchTouristAttractions('IND'));
    const religions = await withFetch(t, impl, () => fetchReligions('IND'));
    for (const { result } of [cities, attractions, religions]) {
      assert.deepEqual([...result], [], 'nothing to show, exactly as before');
      assert.deepEqual(result.incompleteParts, ['query service'], 'but it FAILED, which is not the same as "there are none": the data service must not remember it');
      assert.equal(Object.keys(result).includes('incompleteParts'), false);
    }
  }
});

test('a Query Service that answers with no rows is a genuine "none", and is NOT marked', async (t) => {
  const { result } = await withFetch(t, async () => answer([]), () => fetchMajorCitiesDynamic('IND'));
  assert.deepEqual(result, []);
  assert.equal(result.incompleteParts, undefined);
});

test('religions: shares become percentages, largest first; those without a share go last', async (t) => {
  const rows = [
    binding({ relLabel: 'Islam', pct: 0.25 }),
    binding({ relLabel: 'Jainism' }),
    binding({ relLabel: 'Hinduism', pct: 0.5 }),
    binding({ pct: 0.9 }),
  ];
  const { result } = await withFetch(t, async () => answer(rows), () => fetchReligions('IND'));
  assert.deepEqual(result, [
    { religion: 'Hinduism', percent: 50 },
    { religion: 'Islam', percent: 25 },
    { religion: 'Jainism', percent: null },
  ]);
});

test('religions: no rows at all means "Wikidata has none" (null, so the local file is used)', async (t) => {
  const { result } = await withFetch(t, async () => answer([]), () => fetchReligions('FRA'));
  assert.equal(result, null);
});

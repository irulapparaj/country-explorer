import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSearchIndex, getEntryByIso3, getEntryByIsoNumeric, peekEntryByIso3 } from '../../lib/searchIndex.js';

const respond = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
const BRAZIL = { iso3: 'BRA', isoNumeric: '076', names: { common: 'Brazil', official: 'Federative Republic of Brazil' } };

// Found by review: a failed index download stayed cached as a rejected promise, so the map's own Retry
// button — which starts by loading the index — could never succeed until the page was reloaded.
test('a failed index load is not remembered: the next attempt fetches again and recovers', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return calls === 1 ? respond({}, 404) : respond([BRAZIL]); };

  await assert.rejects(loadSearchIndex(), /404/);
  assert.equal(peekEntryByIso3('BRA'), null, 'nothing is pretended to be loaded');

  assert.equal((await loadSearchIndex()).length, 1);
  assert.equal(calls, 2);
  assert.equal((await getEntryByIso3('bra')).names.common, 'Brazil');
  assert.equal((await getEntryByIsoNumeric('076')).iso3, 'BRA');
  assert.equal(peekEntryByIso3('BRA').names.common, 'Brazil');

  await loadSearchIndex();
  assert.equal(calls, 2, 'and once loaded it is kept');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, countryHash, isRouteHash, startRouter, MAP_HASH } from '../../lib/router.js';

test('parseHash treats an empty or root hash as the map view', () => {
  assert.deepEqual(parseHash(''), { view: 'map' });
  assert.deepEqual(parseHash('#/'), { view: 'map' });
  assert.deepEqual(parseHash(undefined), { view: 'map' });
});

test('parseHash extracts an uppercased ISO3 for a country route', () => {
  assert.deepEqual(parseHash('#/country/IND'), { view: 'country', iso3: 'IND' });
  assert.deepEqual(parseHash('#/country/ind'), { view: 'country', iso3: 'IND' });
});

test('parseHash tolerates a trailing slash', () => {
  assert.deepEqual(parseHash('#/country/FRA/'), { view: 'country', iso3: 'FRA' });
});

test('parseHash falls back to the map view for anything else unrecognized', () => {
  assert.deepEqual(parseHash('#/country/'), { view: 'map' });
  assert.deepEqual(parseHash('#/country/TOOLONG'), { view: 'map' });
  assert.deepEqual(parseHash('#/settings'), { view: 'map' });
});

test('countryHash builds and uppercases the country route', () => {
  assert.equal(countryHash('ind'), '#/country/IND');
  assert.equal(countryHash('FRA'), '#/country/FRA');
});

test('MAP_HASH is the root route', () => {
  assert.equal(MAP_HASH, '#/');
});

// ---- in-page links are not routes ------------------------------------------------------------------------
//
// Found by review (and confirmed in a real browser): the country page's section links (href="#geography") and
// the skip link (href="#main-content") changed the hash to something that is not `#/country/XXX`, which the
// router took for "the map view" — so clicking a section jumped you OUT of the country page.

test('only #/… (and the empty hash) is a route; anything else is an in-page anchor', () => {
  for (const hash of ['', '#', '#/', '#/country/FRA', '#/country/fra/', '#/settings']) assert.equal(isRouteHash(hash), true, hash);
  for (const hash of ['#geography', '#main-content', '#facts', '#a/b']) assert.equal(isRouteHash(hash), false, hash);
  assert.equal(isRouteHash(undefined), true);
});

// A stand-in for the browser: `window.location.hash` plus the listeners registered on it.
function withFakeWindow(t, initialHash) {
  const realWindow = globalThis.window;
  const listeners = [];
  globalThis.window = { location: { hash: initialHash }, addEventListener: (type, listener) => { if (type === 'hashchange') listeners.push(listener); } };
  t.after(() => { globalThis.window = realWindow; });
  return { changeHashTo(hash) { globalThis.window.location.hash = hash; for (const listener of listeners) listener(); } };
}

function startRecordingRouter(initialHash, t) {
  const browser = withFakeWindow(t, initialHash);
  const seen = [];
  startRouter({ onMapView: () => seen.push('map'), onCountryView: (iso3) => seen.push(`country:${iso3}`) });
  return { ...browser, seen };
}

test('following a section link on the country page keeps you on the country page', (t) => {
  const { changeHashTo, seen } = startRecordingRouter('#/country/FRA', t);
  changeHashTo('#geography');
  changeHashTo('#population');
  changeHashTo('#main-content'); // the skip link
  assert.deepEqual(seen, ['country:FRA'], 'only the initial route was acted on');
});

test('real routes still switch views, before and after an in-page anchor', (t) => {
  const { changeHashTo, seen } = startRecordingRouter('#/', t);
  changeHashTo('#/country/IND');
  changeHashTo('#facts');
  changeHashTo('#/country/IND'); // Back from the anchor
  changeHashTo('#/');
  assert.deepEqual(seen, ['map', 'country:IND', 'country:IND', 'map']);
});

test('a page LOADED on an in-page anchor (a stale or shared link) starts on the map, as any unknown hash does', (t) => {
  const { seen } = startRecordingRouter('#geography', t);
  assert.deepEqual(seen, ['map']);
});

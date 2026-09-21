const COUNTRY_HASH = /^#\/country\/([A-Za-z]{3})\/?$/;
export const MAP_HASH = '#/';

export function countryHash(iso3) {
  return `#/country/${iso3.toUpperCase()}`;
}

export function parseHash(hash) {
  const match = (hash || MAP_HASH).match(COUNTRY_HASH);
  return match ? { view: 'country', iso3: match[1].toUpperCase() } : { view: 'map' };
}

/**
 * Only `#/…` (or no hash at all) is a route. Anything else — `#geography` on the country page, `#main-content`
 * on the skip link — is an in-page anchor: the browser scrolls to it, and it must not change the view (it used
 * to be taken for "the map view", so following a section link threw you out of the country page).
 */
export function isRouteHash(hash) {
  return !hash || hash === '#' || hash.startsWith('#/');
}

export function startRouter({ onMapView, onCountryView }) {
  function resolve() {
    const route = parseHash(window.location.hash);
    if (route.view === 'country') onCountryView(route.iso3);
    else onMapView();
  }

  // A change to an in-page anchor is left alone. (A page LOADED on one — a stale or shared link — has no route to
  // show and starts on the map, as any unknown hash does.)
  window.addEventListener('hashchange', () => {
    if (isRouteHash(window.location.hash)) resolve();
  });
  resolve();
}

export function navigate(hash) {
  if (window.location.hash === hash) return;
  window.location.hash = hash;
}

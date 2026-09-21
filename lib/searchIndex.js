// Loads the bundled data/search-index.json once and keeps it around: every ISO 3166-1
// country/territory plus Kosovo, with names/aliases/codes/coordinates pulled live from
// Wikidata at authoring time (see data/search-index.json's own provenance — it is not
// hand-typed). This module owns the raw lookup; the fuzzy-matching UI (Fuse.js) is
// layered on top in components/search.

import { fetchJson } from './http.js';

let entriesPromise = null;
let byIso3 = null;
let byIsoNumeric = null;

export function loadSearchIndex() {
  if (!entriesPromise) {
    const attempt = fetchJson('data/search-index.json', { timeoutMs: 10_000, retries: 1 }).then((entries) => {
      byIso3 = new Map(entries.map((e) => [e.iso3, e]));
      byIsoNumeric = new Map(entries.filter((e) => e.isoNumeric).map((e) => [e.isoNumeric, e]));
      return entries;
    });
    entriesPromise = attempt;
    // A failed load is not remembered: the map's Retry button (and the next lookup) must be able to try again.
    attempt.catch(() => { if (entriesPromise === attempt) entriesPromise = null; });
  }
  return entriesPromise;
}

/** Synchronous lookup for callers that cannot await (rendering a heading right now). Returns
 *  null until the index has loaded — which it always has by the time the map is usable. */
export function peekEntryByIso3(iso3) {
  return byIso3?.get(String(iso3).toUpperCase()) ?? null;
}

export async function getEntryByIso3(iso3) {
  if (!byIso3) await loadSearchIndex();
  return byIso3.get(iso3.toUpperCase()) || null;
}

// The world-atlas TopoJSON's only per-feature identifier is a numeric ISO 3166-1 code
// (e.g. "250" for France) with no embedded alpha-3/name field to parse — joining
// through this table, rather than through any name or alpha-3 string baked into the
// map data itself, is what keeps the France/Norway "-99" ISO_A3 bug (present in the
// raw Natural Earth shapefile this topology derives from) from ever reaching this app.
export async function getEntryByIsoNumeric(isoNumeric) {
  if (!byIsoNumeric) await loadSearchIndex();
  return byIsoNumeric.get(String(isoNumeric)) || null;
}

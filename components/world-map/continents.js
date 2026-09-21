// The seven continents: names, where their names are drawn on the map, and how Wikidata's
// messier continent data (data/continents.json is built from it — see
// scripts/build-continents.mjs) is reduced to exactly one continent per country.

export const CONTINENTS = Object.freeze(['Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'Oceania', 'South America']);

/** Where each continent's name is drawn, as [lng, lat]. Fixed cartographic anchors chosen
 *  to sit over the middle of each landmass, the same way ocean names have to be placed. */
export const CONTINENT_LABELS = Object.freeze([
  { name: 'North America', lng: -102, lat: 47 },
  { name: 'South America', lng: -60, lat: -13 },
  { name: 'Europe', lng: 15, lat: 51 },
  { name: 'Africa', lng: 20, lat: 5 },
  { name: 'Asia', lng: 90, lat: 47 },
  { name: 'Oceania', lng: 135, lat: -25 },
  { name: 'Antarctica', lng: 40, lat: -79 },
]);

export function continentSlug(name) {
  return name.toLowerCase().replace(/\s+/g, '-');
}

// Wikidata sometimes files a country under a sub-region instead of the continent proper.
const LABEL_ALIASES = { 'Insular Oceania': 'Oceania', 'Australia (continent)': 'Oceania' };

/** @returns {string | null} one of CONTINENTS, or null for labels we do not draw (e.g. "Eurasia") */
export function normalizeContinentLabel(label) {
  if (CONTINENTS.includes(label)) return label;
  return LABEL_ALIASES[label] ?? null;
}

// For the few countries Wikidata lists on more than one continent, the one holding most of
// the country's area (Russia is ~77% Asia; Turkey ~97% Asia; Kazakhstan ~88% Asia).
export const PRIMARY_CONTINENT_OVERRIDES = Object.freeze({
  RUS: 'Asia',
  KAZ: 'Asia',
  TUR: 'Asia',
  UMI: 'Oceania', // US Minor Outlying Islands: nearly all Pacific
  ATF: 'Antarctica', // French Southern and Antarctic Lands
});

/**
 * @param {string} iso3
 * @param {string[]} labels Wikidata continent (P30) labels for the country
 * @returns {string | null}
 */
export function pickPrimaryContinent(iso3, labels) {
  const candidates = [...new Set(labels.map(normalizeContinentLabel).filter(Boolean))].sort();
  if (candidates.length === 0) return null;
  const override = PRIMARY_CONTINENT_OVERRIDES[iso3];
  return override && candidates.includes(override) ? override : candidates[0];
}

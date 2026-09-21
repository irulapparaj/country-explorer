// Dev-time script (not part of the running app): rebuilds data/continents.json from live
// Wikidata, the same way data/search-index.json was authored. Run with:
//   node scripts/build-continents.mjs
//
// Each search-index entry's continent comes from Wikidata's "continent" property (P30),
// looked up by ISO alpha-3 (P298). Wikidata lists a handful of countries on several
// continents; components/world-map/continents.js decides which single one to use.
// Åland and Kosovo have no P30 statement on Wikidata, so they are supplied below.

import fs from 'node:fs';
import { pickPrimaryContinent } from '../components/world-map/continents.js';

const SUPPLEMENTS = { ALA: 'Europe', XKX: 'Europe' };
const QUERY = `SELECT ?iso3 ?continentLabel WHERE {
  ?c wdt:P298 ?iso3 . ?c wdt:P30 ?continent .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;

const url = `https://query.wikidata.org/sparql?query=${encodeURIComponent(QUERY)}&format=json`;
const response = await fetch(url, { headers: { 'User-Agent': 'CountryExplorer/0.1 (build-continents script)' } });
if (!response.ok) throw new Error(`Wikidata query failed: ${response.status}`);
const { results } = await response.json();

const labelsByIso3 = new Map();
for (const row of results.bindings) {
  const iso3 = row.iso3.value;
  labelsByIso3.set(iso3, [...(labelsByIso3.get(iso3) ?? []), row.continentLabel.value]);
}

const indexPath = new URL('../data/search-index.json', import.meta.url);
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const continents = {};
const unresolved = [];
for (const { iso3 } of [...index].sort((a, b) => a.iso3.localeCompare(b.iso3))) {
  const continent = pickPrimaryContinent(iso3, labelsByIso3.get(iso3) ?? []) ?? SUPPLEMENTS[iso3];
  if (continent) continents[iso3] = continent;
  else unresolved.push(iso3);
}

fs.writeFileSync(new URL('../data/continents.json', import.meta.url), `${JSON.stringify(continents, null, 2)}\n`);
console.log(`Wrote ${Object.keys(continents).length} countries.`);
if (unresolved.length) console.warn(`No continent for: ${unresolved.join(', ')}`);

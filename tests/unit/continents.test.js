import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CONTINENTS,
  CONTINENT_LABELS,
  normalizeContinentLabel,
  pickPrimaryContinent,
  continentSlug,
} from '../../components/world-map/continents.js';

const read = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));

test('there are exactly the seven continents, alphabetically', () => {
  assert.deepEqual(CONTINENTS, ['Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'Oceania', 'South America']);
});

test('continentSlug makes stable CSS-safe ids', () => {
  assert.equal(continentSlug('North America'), 'north-america');
  assert.equal(continentSlug('Asia'), 'asia');
});

test('Wikidata continent labels are folded into the seven continents', () => {
  assert.equal(normalizeContinentLabel('Europe'), 'Europe');
  assert.equal(normalizeContinentLabel('Insular Oceania'), 'Oceania');
  assert.equal(normalizeContinentLabel('Australia (continent)'), 'Oceania');
  assert.equal(normalizeContinentLabel('Eurasia'), null, 'a supercontinent is not one of our seven');
  assert.equal(normalizeContinentLabel('Atlantis'), null);
});

test('transcontinental countries take the continent that holds most of their area', () => {
  assert.equal(pickPrimaryContinent('RUS', ['Asia', 'Eurasia', 'Europe']), 'Asia');
  assert.equal(pickPrimaryContinent('TUR', ['Europe', 'Asia']), 'Asia');
  assert.equal(pickPrimaryContinent('KAZ', ['Asia', 'Europe']), 'Asia');
  assert.equal(pickPrimaryContinent('UMI', ['Insular Oceania', 'North America']), 'Oceania');
  assert.equal(pickPrimaryContinent('ATF', ['Africa', 'Antarctica']), 'Antarctica');
});

test('an unambiguous country simply keeps its continent, and no data yields null', () => {
  assert.equal(pickPrimaryContinent('FRA', ['Europe']), 'Europe');
  assert.equal(pickPrimaryContinent('KIR', ['Insular Oceania', 'Oceania']), 'Oceania');
  assert.equal(pickPrimaryContinent('XXX', []), null);
  assert.equal(pickPrimaryContinent('XXX', ['Eurasia']), null);
});

test('every continent has one name-label anchor inside valid lon/lat ranges', () => {
  assert.deepEqual(CONTINENT_LABELS.map((l) => l.name).sort(), [...CONTINENTS].sort());
  for (const { lng, lat } of CONTINENT_LABELS) {
    assert.ok(lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90);
  }
});

// Data completeness: the geographic-region map colors every drawn country from
// data/continents.json, so a search-index entry without a continent would be a hole.
test('data/continents.json gives every search-index entry a valid continent', () => {
  const continents = read('../../data/continents.json');
  const index = read('../../data/search-index.json');
  const missing = index.filter((e) => !continents[e.iso3]).map((e) => e.iso3);
  assert.deepEqual(missing, []);
  for (const [iso3, name] of Object.entries(continents)) {
    assert.ok(CONTINENTS.includes(name), `${iso3} has unknown continent "${name}"`);
  }
});

test('data/continents.json gets the well-known countries right', () => {
  const c = read('../../data/continents.json');
  const expected = {
    FRA: 'Europe', DEU: 'Europe', GBR: 'Europe', RUS: 'Asia', TUR: 'Asia', KAZ: 'Asia',
    IND: 'Asia', CHN: 'Asia', JPN: 'Asia', USA: 'North America', CAN: 'North America',
    MEX: 'North America', BRA: 'South America', ARG: 'South America', NGA: 'Africa',
    EGY: 'Africa', ZAF: 'Africa', AUS: 'Oceania', NZL: 'Oceania', ATA: 'Antarctica',
  };
  for (const [iso3, name] of Object.entries(expected)) assert.equal(c[iso3], name, iso3);
});

// Antarctica is now drawn. world-atlas identifies it only by numeric id "010", so the
// search index must carry that numeric code or the shape can never join to its entry.
test('the search index maps numeric code 010 to Antarctica so the drawn shape is selectable', () => {
  const index = read('../../data/search-index.json');
  const ata = index.find((e) => e.iso3 === 'ATA');
  assert.equal(ata?.isoNumeric, '010');
  assert.equal(index.filter((e) => e.isoNumeric === '010').length, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const ids = read('../../data/wikidata-ids.json');
const index = read('../../data/search-index.json');

// The panel and page read every fact off the country's Wikidata item, so a wrong item here means wrong
// facts for that country — silently. The table is generated (scripts/build-wikidata-ids.mjs) and these
// tests pin what a machine could get wrong.

test('every search-index country has a Wikidata item id, and it is well-formed', () => {
  const missing = index.filter((entry) => !ids[entry.iso3]).map((entry) => entry.iso3);
  assert.deepEqual(missing, []);
  for (const [iso3, qid] of Object.entries(ids)) assert.match(qid, /^Q\d+$/, iso3);
});

test('no two countries share an item, except the two Kosovo codes', () => {
  const byQid = new Map();
  for (const [iso3, qid] of Object.entries(ids)) byQid.set(qid, [...(byQid.get(qid) ?? []), iso3]);
  const shared = [...byQid.values()].filter((codes) => codes.length > 1);
  assert.deepEqual(shared, [['XKS', 'XKX']]);
});

// Where several Wikidata items carry one ISO code, the wrong pick gives wrong facts. Found by review:
// the Netherlands resolved to the KINGDOM of the Netherlands (2013 population, only "Dutch", time zones
// as "Atlantic Time Zone / Europe/Amsterdam" rather than UTC offsets, Caribbean continents/currencies).
test('countries whose ISO code is carried by more than one item resolve to the country itself', () => {
  assert.equal(ids.NLD, 'Q55', 'Netherlands, not the Kingdom of the Netherlands (Q29999)');
  assert.equal(ids.DNK, 'Q35', 'Denmark, not the Kingdom of Denmark (Q756617)');
  assert.equal(ids.ATA, 'Q51', 'Antarctica');
  assert.equal(ids.ESH, 'Q6250', 'Western Sahara, not the Sahrawi Arab Democratic Republic (Q40362)');
  assert.equal(ids.PSE, 'Q219060', 'State of Palestine, not the Palestinian territories (Q407199)');
});

test('the best-known countries map to their well-known items', () => {
  const expected = { BRA: 'Q155', RUS: 'Q159', USA: 'Q30', IND: 'Q668', FRA: 'Q142', DEU: 'Q183', CHN: 'Q148', JPN: 'Q17', GBR: 'Q145', VAT: 'Q237', AUS: 'Q408', NGA: 'Q1033' };
  for (const [iso3, qid] of Object.entries(expected)) assert.equal(ids[iso3], qid, iso3);
});

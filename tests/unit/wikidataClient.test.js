import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLanguages, commonsFilePath } from '../../lib/wikidataClient.js';

// Regression coverage for a real bug found during development: India's P2936
// ("languages spoken/written/signed") lists 300+ regional languages, which would
// swamp the official-language field if unioned in unconditionally.
test('mergeLanguages keeps the official list when the union would add too much', () => {
  const official = ['Hindi', 'English'];
  const hugeSpokenList = Array.from({ length: 300 }, (_, i) => `Language ${i}`);
  assert.deepEqual(mergeLanguages(official, hugeSpokenList), official);
});

// Regression coverage for the USA case: P37 (official language) lists the territorial
// co-official languages but omits English (no de jure federal status); P2936 adds
// exactly English, a small enough delta to top up rather than discard.
test('mergeLanguages tops up the official list with a small number of extra spoken languages', () => {
  const official = ['Hawaiian', 'Spanish', 'Samoan', 'Carolinian', 'Chamorro'];
  const spoken = [...official, 'English'];
  assert.deepEqual(mergeLanguages(official, spoken), [...official, 'English']);
});

test('mergeLanguages falls back to a capped spoken-language list when there is no official language at all', () => {
  const spoken = Array.from({ length: 20 }, (_, i) => `Language ${i}`);
  const result = mergeLanguages([], spoken);
  assert.equal(result.length, 15);
  assert.deepEqual(result, spoken.slice(0, 15));
});

test('commonsFilePath builds an https Special:FilePath URL, encoding spaces and unicode in the file name', () => {
  assert.equal(commonsFilePath('Flag of Brazil.svg'), 'https://commons.wikimedia.org/wiki/Special:FilePath/Flag%20of%20Brazil.svg');
  assert.equal(commonsFilePath("Flag of Côte d'Ivoire.svg"), "https://commons.wikimedia.org/wiki/Special:FilePath/Flag%20of%20C%C3%B4te%20d'Ivoire.svg");
  assert.equal(commonsFilePath(null), null);
});

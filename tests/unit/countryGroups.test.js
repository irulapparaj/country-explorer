import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupShapesByCountry } from '../../components/world-map/countryGroups.js';

const australia = { iso3: 'AUS', area: 7_706_009, name: 'Australia' };
const ashmore = { iso3: 'AUS', area: 3, name: 'Ashmore and Cartier Is.' };

// Regression: the map used to keep the LAST shape per ISO code. In the real topology
// Ashmore and Cartier Islands comes after Australia, so selecting Australia zoomed to a
// 3 km2 speck in the Timor Sea. The result must not depend on the order shapes appear in.
test('the largest shape is the country, whichever order the shapes come in', () => {
  for (const shapes of [[australia, ashmore], [ashmore, australia]]) {
    const { primaryByIso3 } = groupShapesByCountry(shapes);
    assert.equal(primaryByIso3.get('AUS'), australia);
  }
});

test('every shape carrying the code is kept as a part, primary included, in input order', () => {
  const { partsByIso3 } = groupShapesByCountry([australia, ashmore]);
  assert.deepEqual(partsByIso3.get('AUS'), [australia, ashmore]);
});

test('ordinary one-shape countries get themselves as primary and only part', () => {
  const france = { iso3: 'FRA', area: 640_000 };
  const { primaryByIso3, partsByIso3 } = groupShapesByCountry([france, australia, ashmore]);
  assert.equal(primaryByIso3.get('FRA'), france);
  assert.deepEqual(partsByIso3.get('FRA'), [france]);
});

test('shapes with no ISO code (disputed areas) belong to no group', () => {
  const { primaryByIso3, partsByIso3 } = groupShapesByCountry([{ iso3: null, area: 5 }, australia]);
  assert.deepEqual([...primaryByIso3.keys()], ['AUS']);
  assert.deepEqual([...partsByIso3.keys()], ['AUS']);
});

test('on an exact tie the first shape wins (stable)', () => {
  const a = { iso3: 'XXX', area: 10 };
  const b = { iso3: 'XXX', area: 10 };
  assert.equal(groupShapesByCountry([a, b]).primaryByIso3.get('XXX'), a);
});

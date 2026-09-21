import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legendForMode } from '../../components/world-map/legendSpecs.js';
import { ELEVATION_BANDS } from '../../components/world-map/elevation.js';
import { CONTINENTS } from '../../components/world-map/continents.js';

const allItems = (legend) => legend.groups.flatMap((group) => group.items);

test('the political map needs no key', () => {
  assert.equal(legendForMode('political'), null);
  assert.equal(legendForMode('nonsense'), null);
});

test('the geographic map key names all seven continents, each with its own swatch class', () => {
  const legend = legendForMode('geographic');
  assert.deepEqual(allItems(legend).map((i) => i.label), CONTINENTS);
  assert.equal(new Set(allItems(legend).map((i) => i.swatchClass)).size, 7);
  assert.equal(allItems(legend)[4].swatchClass, 'continent-north-america');
});

// Item 10: "the elevation map has to have a key to show which colors mean which elevation".
test('the elevation key has a row for every band, in the exact colors the map paints', () => {
  const legend = legendForMode('elevation');
  const items = allItems(legend);
  assert.equal(items.length, ELEVATION_BANDS.length);
  for (const band of ELEVATION_BANDS) {
    const item = items.find((i) => i.label === band.label);
    assert.ok(item, `no legend row for "${band.label}"`);
    assert.equal(item.color, band.color, `${band.label}: legend swatch color must equal the painted color`);
  }
});

test('the elevation key separates land elevation from ocean depth and credits its data source', () => {
  const legend = legendForMode('elevation');
  assert.deepEqual(legend.groups.map((g) => g.heading), ['Land elevation', 'Ocean depth']);
  assert.match(legend.title, /elevation/i);
  assert.match(legend.ariaLabel, /elevation/i);
  assert.match(legend.note, /terrain tiles/i);
});

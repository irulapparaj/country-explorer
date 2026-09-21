import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAP_MODES, LABEL_MODES, DEFAULT_OPTIONS, normalizeOptions } from '../../components/world-map/mapModes.js';

test('the three map styles are political (default, as before), geographic, elevation', () => {
  assert.deepEqual(MAP_MODES.map((m) => m.id), ['political', 'geographic', 'elevation']);
  assert.equal(DEFAULT_OPTIONS.mapMode, 'political');
});

test('the label choices are major countries (default, as before), all countries, continents only', () => {
  assert.deepEqual(LABEL_MODES.map((m) => m.id), ['major', 'all', 'continents']);
  assert.equal(DEFAULT_OPTIONS.labelMode, 'major');
});

test('grid/coordinates and ocean names default to on, since the map was missing them', () => {
  assert.equal(DEFAULT_OPTIONS.showGrid, true);
  assert.equal(DEFAULT_OPTIONS.showWaterNames, true);
});

test('normalizeOptions fills in defaults and rejects unknown values', () => {
  assert.deepEqual(normalizeOptions({}), DEFAULT_OPTIONS);
  assert.deepEqual(normalizeOptions(undefined), DEFAULT_OPTIONS);
  assert.equal(normalizeOptions({ mapMode: 'satellite' }).mapMode, 'political');
  assert.equal(normalizeOptions({ labelMode: 'nope' }).labelMode, 'major');
  assert.equal(normalizeOptions({ showGrid: 'yes' }).showGrid, true);
});

test('normalizeOptions keeps valid choices and layers them over the previous options without mutating', () => {
  const prev = normalizeOptions({ mapMode: 'elevation', showGrid: false });
  const next = normalizeOptions({ labelMode: 'continents' }, prev);
  assert.deepEqual(next, { mapMode: 'elevation', labelMode: 'continents', showGrid: false, showWaterNames: true });
  assert.equal(prev.labelMode, 'major');
  assert.ok(Object.isFrozen(next));
});

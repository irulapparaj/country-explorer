import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeLabels, visibleAtZoom } from '../../components/world-map/labelPlacement.js';

test('placeLabels keeps a label that fits inside its own country bounds', () => {
  const result = placeLabels([
    { id: 'A', anchor: [50, 50], width: 20, height: 10, countryScreenBounds: [[0, 0], [100, 100]] },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'A');
});

test('placeLabels drops a label that would spill outside its own country bounds', () => {
  const result = placeLabels([
    { id: 'A', anchor: [5, 5], width: 40, height: 10, countryScreenBounds: [[0, 0], [10, 10]] },
  ]);
  assert.equal(result.length, 0);
});

test('placeLabels drops a lower-priority label that would overlap an already-placed one', () => {
  const result = placeLabels([
    { id: 'big-country', anchor: [50, 50], width: 30, height: 10, countryScreenBounds: [[0, 0], [200, 200]] },
    { id: 'overlapping-neighbor', anchor: [55, 52], width: 30, height: 10, countryScreenBounds: [[0, 0], [200, 200]] },
    { id: 'far-away', anchor: [150, 150], width: 30, height: 10, countryScreenBounds: [[0, 0], [200, 200]] },
  ]);
  const ids = result.map((r) => r.id);
  assert.deepEqual(ids, ['big-country', 'far-away']); // order matters: first-come wins on overlap
});

test('placeLabels allows a label with no bounds constraint through (e.g. an off-map marker)', () => {
  const result = placeLabels([{ id: 'A', anchor: [0, 0], width: 10, height: 10 }]);
  assert.equal(result.length, 1);
});

test('visibleAtZoom shows the top-ranked countries even at the starting zoom level', () => {
  assert.equal(visibleAtZoom(0, 1), true);
  assert.equal(visibleAtZoom(29, 1), true);
  assert.equal(visibleAtZoom(30, 1), false);
});

test('visibleAtZoom reveals mid- and low-ranked countries only once zoomed in enough', () => {
  assert.equal(visibleAtZoom(50, 1), false);
  assert.equal(visibleAtZoom(50, 2.2), true);
  assert.equal(visibleAtZoom(200, 2.2), false);
  assert.equal(visibleAtZoom(200, 4), true);
});

// "Show all countries vs. major countries": the scope decides which countries are even
// offered as label candidates; the fit-inside-own-bounds and no-overlap rules still apply.
test("visibleAtZoom in 'all' scope offers every country at any zoom (fit rules still gate what is drawn)", () => {
  assert.equal(visibleAtZoom(0, 1, 'all'), true);
  assert.equal(visibleAtZoom(200, 1, 'all'), true);
  assert.equal(visibleAtZoom(239, 1, 'all'), true);
});

test("visibleAtZoom defaults to the 'major' progressive reveal, unchanged", () => {
  assert.equal(visibleAtZoom(50, 1), false);
  assert.equal(visibleAtZoom(50, 1, 'major'), false);
  assert.equal(visibleAtZoom(50, 2.2, 'major'), true);
});

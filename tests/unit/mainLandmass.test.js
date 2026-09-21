import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toSinglePolygonFeatures,
  getMainLandmass,
  getDisplayBounds,
  projectedRingBounds,
  MIN_TERRITORY_SHARE,
} from '../../components/world-map/mainLandmass.js';

// Fake geo helpers standing in for d3.geoArea/geoBounds/geoCentroid — plain planar
// shoelace-formula math, not spherical, but that's irrelevant here: these tests only
// need to rank "which polygon is bigger", not compute geographically correct areas.
function ring(feature) {
  return feature.geometry.coordinates[0];
}
function planarArea(feature) {
  const pts = ring(feature);
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    sum += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  }
  return Math.abs(sum / 2);
}
function planarBounds(feature) {
  const pts = ring(feature);
  const lngs = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
}
function planarCentroid(feature) {
  const pts = ring(feature);
  const n = pts.length;
  return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
}
const geo = { geoArea: planarArea, geoBounds: planarBounds, geoCentroid: planarCentroid };

const bigSquare = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] } };
const tinySquare = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[50, 50], [51, 50], [51, 51], [50, 51], [50, 50]]] } };

test('toSinglePolygonFeatures returns a single-element array for a plain Polygon', () => {
  const result = toSinglePolygonFeatures(bigSquare);
  assert.equal(result.length, 1);
  assert.equal(result[0], bigSquare);
});

test('toSinglePolygonFeatures splits a MultiPolygon into one feature per polygon, preserving id', () => {
  const multi = {
    type: 'Feature',
    id: 'FRA',
    geometry: { type: 'MultiPolygon', coordinates: [bigSquare.geometry.coordinates, tinySquare.geometry.coordinates] },
  };
  const result = toSinglePolygonFeatures(multi);
  assert.equal(result.length, 2);
  assert.ok(result.every((f) => f.id === 'FRA' && f.geometry.type === 'Polygon'));
});

test('toSinglePolygonFeatures returns an empty array for unsupported geometry types', () => {
  assert.deepEqual(toSinglePolygonFeatures({ geometry: { type: 'Point', coordinates: [0, 0] } }), []);
  assert.deepEqual(toSinglePolygonFeatures({}), []);
  assert.deepEqual(toSinglePolygonFeatures(null), []);
});

// This is the direct regression test for the spec's named acceptance case: "Selecting
// France zooms to mainland France... not out to French Guiana."
test('getMainLandmass picks the largest polygon out of a France-like MultiPolygon (mainland vs. a tiny remote territory)', () => {
  const franceLike = {
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: [bigSquare.geometry.coordinates, tinySquare.geometry.coordinates] },
  };
  const result = getMainLandmass(franceLike, geo);
  assert.deepEqual(result.bounds, planarBounds(bigSquare));
  assert.deepEqual(result.centroid, planarCentroid(bigSquare));
});

test('getMainLandmass works the same for a plain single Polygon (no remote territories)', () => {
  const result = getMainLandmass(bigSquare, geo);
  assert.deepEqual(result.bounds, planarBounds(bigSquare));
});

test('getMainLandmass returns null for a feature with no usable geometry', () => {
  assert.equal(getMainLandmass({}, geo), null);
});

// ---------------------------------------------------------------------------------------
// getDisplayBounds — "zoom to the whole country, including overseas territories".
// Regression for: selecting France zoomed to mainland only (French Guiana was off-screen),
// the USA showed neither Alaska nor Hawaii. The rule must ALSO stay safe for the cases that
// originally made the app use "largest polygon only": Russia/Fiji/New Zealand have pieces
// on the far side of the ±180° antimeridian, which sit at the opposite edge of a
// non-wrapping map and would otherwise stretch the bounds across the whole world.
// ---------------------------------------------------------------------------------------
const MAP_WIDTH = 360; // fake projection: x = longitude, so the "map" is 360 wide
const project = ([lng, lat]) => [lng, -lat];
const displayGeo = { geoArea: planarArea, geoCentroid: planarCentroid, project, maxSeparationX: MAP_WIDTH / 2 };

function square(x, y, size) {
  return [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]];
}
function multi(...squares) {
  return { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: squares } };
}

// The threshold decides which overseas pieces are worth zooming out for. It is only
// meaningful as a boundary: a piece just above it must count, one just below must not.
test('a territory just above MIN_TERRITORY_SHARE is included, one just below it is not', () => {
  const mainSize = 1000; // area 1e6
  const total = mainSize * mainSize;
  const sizeForShare = (share) => Math.sqrt((share * total) / (1 - share)); // square whose area is `share` of the total
  const far = (size) => multi(square(0, 0, mainSize), square(2000, 0, size));
  const just = (factor) => getDisplayBounds(far(sizeForShare(MIN_TERRITORY_SHARE * factor)), { ...displayGeo, maxSeparationX: 1e9 }).polygonCount;
  assert.equal(just(1.5), 2, 'a bit above the threshold counts');
  assert.equal(just(0.5), 1, 'a bit below the threshold does not');
});

// The REAL structure of Russia in world-atlas: ONE ring whose points run across the +/-180
// antimeridian (longitudes -180..-170 and 100..180 in the same ring). Excluding whole polygons
// by centroid cannot help — the far-side points belong to the same polygon — so the ring's own
// points must be filtered. Before the fix Russia's bounds spanned 762 of 960 map units instead
// of 326, so selecting it did not zoom at all and the Far East stayed under the side panel.
function crossingRing() {
  const ring = [];
  for (let lng = 100; lng <= 180; lng += 4) ring.push([lng, 60]);
  for (let lng = -180; lng <= -170; lng += 4) ring.push([lng, 60]);
  ring.push([100, 50]);
  ring.push(ring[0]);
  return ring;
}

test('projectedRingBounds ignores ring points on the far side of the antimeridian from the anchor', () => {
  const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [crossingRing()] } };
  const naive = projectedRingBounds(feature, project);
  assert.equal(naive[0][0], -180, 'without a filter the far-side points stretch the box across the map');
  const filtered = projectedRingBounds(feature, project, { anchorX: 140, maxSeparationX: MAP_WIDTH / 2 });
  assert.equal(filtered[0][0], 100);
  assert.equal(filtered[1][0], 180);
});

test('getDisplayBounds handles a single ring that crosses the antimeridian (Russia)', () => {
  const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [crossingRing()] } };
  const { bounds } = getDisplayBounds(feature, displayGeo);
  assert.ok(bounds[0][0] >= 100, `bounds must start at the main body (x0=${bounds[0][0]}), not at the far edge`);
  assert.equal(bounds[1][0], 180);
  assert.ok(bounds[1][0] - bounds[0][0] < MAP_WIDTH / 2);
});

// Antarctica's polygon in the topology: the exterior ring is the (zero-height) pole line and
// the real coastline is the interior ring, so the first ring alone gives degenerate bounds.
test('bounds take every ring of a polygon (Antarctica: pole-line exterior ring, coastline hole)', () => {
  const poleLine = [[-180, -89.99], [0, -89.99], [180, -89.99], [-180, -89.99]];
  const coast = [[-180, -70], [-180, -80], [180, -80], [180, -70], [-180, -70]];
  const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [poleLine, coast] } };
  const [[, y0], [, y1]] = projectedRingBounds(feature, project);
  assert.ok(y1 - y0 > 5, `bounds must have real height, got ${y1 - y0}`);
});

test('projectedRingBounds takes min/max of the projected exterior ring and skips unprojectable points', () => {
  const feature = { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(10, 20, 5) } };
  assert.deepEqual(projectedRingBounds(feature, project), [[10, -25], [15, -20]]);
  const partial = (p) => (p[0] === 10 ? null : project(p));
  assert.deepEqual(projectedRingBounds(feature, partial), [[15, -25], [15, -20]]);
});

test('a plain single-polygon country: display bounds are just its own bounds', () => {
  const result = getDisplayBounds(bigSquare, displayGeo);
  const plusZero = (bounds) => bounds.map((point) => point.map((v) => v + 0)); // -0 -> 0 (fake project flips y)
  assert.deepEqual(plusZero(result.bounds), [[0, -10], [10, 0]]);
  assert.equal(result.polygonCount, 1);
});

test('France-like: a large overseas territory (French Guiana) is included in the zoom bounds', () => {
  const france = multi(square(0, 0, 10), square(-54, 3, 2)); // 100 + 4 -> the 4 is ~3.8% of the total
  const { bounds, polygonCount } = getDisplayBounds(france, displayGeo);
  assert.equal(polygonCount, 2);
  assert.equal(bounds[0][0], -54); // reaches the overseas polygon...
  assert.equal(bounds[1][0], 10); // ...and still the mainland
});

test('USA-like: two separated territories (Alaska, Hawaii) all appear in the bounds', () => {
  const usa = multi(square(-125, 25, 58), square(-168, 55, 27), square(-160, 19, 1.5));
  const { bounds } = getDisplayBounds(usa, displayGeo);
  assert.equal(bounds[0][0], -168);
  assert.equal(bounds[1][0], -67);
  assert.equal(bounds[0][1], -83); // northern-most edge of the big polygon (lat 83), in flipped-y projected space
  assert.equal(bounds[1][1], -19); // southern-most edge is Hawaii's bottom (lat 19)
});

test('a specks-of-land outlier (tiny remote islet) is ignored so it cannot blow up the zoom', () => {
  const norwayLike = multi(square(0, 0, 100), square(-3000 / 100, -50, 0.001)); // ~0.00001% of the area, far away
  const { bounds, polygonCount } = getDisplayBounds(norwayLike, displayGeo);
  assert.equal(polygonCount, 1);
  assert.equal(bounds[0][0], 0);
});

test('a polygon on the far side of the antimeridian (New Zealand + Chatham Islands) is excluded', () => {
  // Mainland at lng 170..178; a sizable island group at -178..-176 is ~350 map-units away,
  // i.e. the opposite edge of a non-wrapping map, even though it is 6 degrees away on Earth.
  const nzLike = multi(square(170, -45, 8), square(-178, -44, 2));
  const { bounds, polygonCount } = getDisplayBounds(nzLike, displayGeo);
  assert.equal(polygonCount, 1);
  assert.ok(bounds[0][0] >= 170, `bounds must not stretch to the far edge, got x0=${bounds[0][0]}`);
});

test('a piece right next to the antimeridian but on the SAME side as the mainland is kept', () => {
  const rusLike = multi(square(100, 50, 70), square(178, 66, 2)); // both east of the map center
  const { polygonCount, bounds } = getDisplayBounds(rusLike, displayGeo);
  assert.equal(polygonCount, 2);
  assert.equal(bounds[1][0], 180);
});

test('a country with no usable geometry has no display bounds', () => {
  assert.equal(getDisplayBounds({}, displayGeo), null);
  assert.equal(getDisplayBounds({ geometry: { type: 'Point', coordinates: [0, 0] } }, displayGeo), null);
});

test('the largest polygon is always kept, even if it is tiny in absolute terms (Vatican-like)', () => {
  const tiny = { type: 'Feature', geometry: { type: 'Polygon', coordinates: square(12.4, 41.9, 0.01) } };
  const result = getDisplayBounds(tiny, displayGeo);
  assert.equal(result.polygonCount, 1);
  assert.ok(result.bounds[1][0] > result.bounds[0][0]);
});

// "Is there a dominant mainland?" decides whether the camera may center on it. France (a big
// mainland + small overseas pieces) has one; an archipelago (Indonesia, the Philippines) does not,
// and centering on its arbitrary "largest island" would skew the view.
test('getDisplayBounds reports how much of the country the largest polygon is (mainShare)', () => {
  const france = multi(square(0, 0, 10), square(-54, 3, 2)); // 100 + 4
  assert.ok(Math.abs(getDisplayBounds(france, displayGeo).mainShare - 100 / 104) < 1e-9);
  assert.equal(getDisplayBounds(bigSquare, displayGeo).mainShare, 1);
  const archipelago = multi(square(0, 0, 5), square(20, 0, 5), square(40, 0, 5), square(60, 0, 5)); // four equal islands
  assert.ok(Math.abs(getDisplayBounds(archipelago, displayGeo).mainShare - 0.25) < 1e-9);
});

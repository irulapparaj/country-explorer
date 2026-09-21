import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TERRARIUM_MIN_ZOOM,
  TERRARIUM_MAX_ZOOM,
  ELEVATION_BANDS,
  tileUrl,
  decodeTerrarium,
  bandIndexForElevation,
  landBandIndexForElevation,
  elevationLegend,
  mercatorTileCoord,
  tileZoomForScale,
  bilinearElevation,
  renderElevationRaster,
  createRowGeometry,
  createElevationSampler,
} from '../../components/world-map/elevation.js';

const near = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);

// Mapzen "Terrarium" encoding: metres = (R * 256 + G + B / 256) - 32768
function encodeTerrarium(metres) {
  const v = metres + 32768;
  return [Math.floor(v / 256), Math.floor(v) % 256, Math.floor((v - Math.floor(v)) * 256)];
}

test('tile URLs point at the public Terrarium tile set', () => {
  assert.equal(tileUrl(3, 4, 5), 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/3/4/5.png');
});

test('decodeTerrarium: sea level, a mountain, an ocean trench, and sub-metre precision', () => {
  assert.equal(decodeTerrarium(128, 0, 0), 0);
  near(decodeTerrarium(...encodeTerrarium(8849)), 8849, 1 / 256);
  near(decodeTerrarium(...encodeTerrarium(-10935)), -10935, 1 / 256);
  near(decodeTerrarium(128, 0, 128), 0.5);
  assert.equal(decodeTerrarium(0, 0, 0), -32768);
});

test('bands are contiguous, ordered, and cover every possible elevation exactly once', () => {
  assert.equal(ELEVATION_BANDS[0].min, -Infinity);
  assert.equal(ELEVATION_BANDS.at(-1).max, Infinity);
  for (let i = 1; i < ELEVATION_BANDS.length; i++) {
    assert.equal(ELEVATION_BANDS[i].min, ELEVATION_BANDS[i - 1].max, `gap/overlap before band ${i}`);
    assert.ok(ELEVATION_BANDS[i].min < ELEVATION_BANDS[i].max);
  }
});

test('every band has a unique id, a unique label and a valid hex color (the legend is generated from these)', () => {
  const ids = new Set(ELEVATION_BANDS.map((b) => b.id));
  const labels = new Set(ELEVATION_BANDS.map((b) => b.label));
  const colors = new Set(ELEVATION_BANDS.map((b) => b.color));
  assert.equal(ids.size, ELEVATION_BANDS.length);
  assert.equal(labels.size, ELEVATION_BANDS.length);
  assert.equal(colors.size, ELEVATION_BANDS.length, 'no two bands may share a color or the key is ambiguous');
  for (const band of ELEVATION_BANDS) assert.match(band.color, /^#[0-9a-f]{6}$/i);
});

test('bandIndexForElevation puts each boundary value in the higher band ([min, max))', () => {
  const idAt = (m) => ELEVATION_BANDS[bandIndexForElevation(m)].id;
  assert.notEqual(idAt(0), idAt(-0.5));
  assert.equal(ELEVATION_BANDS[bandIndexForElevation(0)].group, 'land');
  assert.equal(ELEVATION_BANDS[bandIndexForElevation(-0.5)].group, 'ocean');
  assert.notEqual(idAt(199.9), idAt(200));
  assert.equal(idAt(200), idAt(499));
  assert.notEqual(idAt(4999), idAt(5000));
  assert.equal(idAt(9000), idAt(100000));
  assert.equal(idAt(-11000), idAt(-4000.5));
});

test('landBandIndexForElevation never returns an ocean band (land below sea level, e.g. Dead Sea, stays lowland)', () => {
  for (const m of [-430, -86, -0.1, 0, 150, 5895]) {
    assert.equal(ELEVATION_BANDS[landBandIndexForElevation(m)].group, 'land', `${m} m`);
  }
  assert.equal(landBandIndexForElevation(-430), landBandIndexForElevation(0));
});

test('the legend lists land from highest to lowest and ocean from shallowest to deepest', () => {
  const { land, ocean } = elevationLegend();
  assert.ok(land.length >= 6 && ocean.length >= 2);
  assert.match(land[0].label, /5,000/);
  assert.match(land.at(-1).label, /^0/);
  assert.match(ocean[0].label, /^0/);
  for (const item of [...land, ...ocean]) {
    assert.ok(item.color && item.label);
  }
  assert.equal(land.length + ocean.length, ELEVATION_BANDS.length);
});

test('mercatorTileCoord: origin, the date-line edges, and the poles clamp instead of blowing up', () => {
  assert.deepEqual(mercatorTileCoord(0, 0, 1), { x: 1, y: 1 });
  near(mercatorTileCoord(-180, 0, 2).x, 0);
  near(mercatorTileCoord(180, 0, 2).x, 4);
  const north = mercatorTileCoord(0, 90, 3);
  const south = mercatorTileCoord(0, -90, 3);
  assert.ok(Number.isFinite(north.y) && Number.isFinite(south.y));
  near(north.y, 0, 1e-3);
  near(south.y, 8, 1e-3);
});

test('mercatorTileCoord matches the standard slippy-map tile for a known place (London at z=3 is tile 3/2)', () => {
  const { x, y } = mercatorTileCoord(-0.1276, 51.5072, 3);
  assert.equal(Math.floor(x), 3);
  assert.equal(Math.floor(y), 2);
});

test('tile zoom follows map zoom: one level deeper per doubling, clamped to the available range', () => {
  assert.equal(TERRARIUM_MIN_ZOOM, 2);
  assert.equal(TERRARIUM_MAX_ZOOM, 5);
  const zooms = [0.5, 1, 1.99, 2, 3.99, 4, 7.99, 8, 12].map(tileZoomForScale);
  assert.deepEqual(zooms, [2, 2, 2, 3, 3, 4, 4, 5, 5]);
});

test('bilinearElevation returns exact texel values at texel centers and blends between them', () => {
  const grid = Int16Array.from([0, 100, 200, 300]); // 2x2
  assert.equal(bilinearElevation(grid, 2, 0.5, 0.5), 0);
  assert.equal(bilinearElevation(grid, 2, 1.5, 0.5), 100);
  assert.equal(bilinearElevation(grid, 2, 1.0, 0.5), 50);
  assert.equal(bilinearElevation(grid, 2, 1.0, 1.0), 150);
  assert.equal(bilinearElevation(grid, 2, -5, -5), 0, 'clamps to the edge texel');
  assert.equal(bilinearElevation(grid, 2, 99, 99), 300);
});

// A tiny 4x2 raster with a fake geometry: row 0 is lat 10, row 1 is off-map (null);
// longitude = column index * 10 - 15, so columns are -15, -5, 5, 15.
test('renderElevationRaster paints hypsometric colors, ocean bathymetry, and transparency', () => {
  const rowGeometry = (cy) => (cy === 0 ? { lat: 10, lngAt: (cx) => cx * 10 - 15 } : null);
  const sample = (lng) => (lng < 0 ? -3000 : lng < 10 ? 250 : null); // ocean, land, land, no data
  const { all, land } = renderElevationRaster({ width: 4, height: 2, rowGeometry, sample });
  assert.equal(all.length, 4 * 2 * 4);
  const px = (buf, i) => Array.from(buf.slice(i * 4, i * 4 + 4));
  const hex = (band) => [1, 3, 5].map((o) => parseInt(band.color.slice(o, o + 2), 16));

  assert.deepEqual(px(all, 0).slice(0, 3), hex(ELEVATION_BANDS[bandIndexForElevation(-3000)]));
  assert.deepEqual(px(all, 2).slice(0, 3), hex(ELEVATION_BANDS[bandIndexForElevation(250)]));
  assert.equal(px(all, 0)[3], 255);
  assert.equal(px(all, 3)[3], 0, 'null sample is transparent');
  for (let i = 4; i < 8; i++) assert.equal(px(all, i)[3], 0, 'off-map row is transparent');

  // the land-only raster never paints ocean colors: -3000 m draws as the lowest land band
  assert.deepEqual(px(land, 0).slice(0, 3), hex(ELEVATION_BANDS[landBandIndexForElevation(0)]));
  assert.deepEqual(px(land, 2), px(all, 2));
});

// Fake pseudocylindrical projection: y = 250 - 2.5 * lat, x = 480 + 2 * lng. Its invert
// behaves like d3's iterative solvers do out of range: it does not fail, it returns a
// plausible-looking in-range latitude.
const fakeProjection = {
  project: ([lng, lat]) => [480 + 2 * lng, 250 - 2.5 * lat],
  invert: ([, y]) => (Math.abs((250 - y) / 2.5) > 90 ? [0, 33.3] : [0, (250 - y) / 2.5]),
};
const identityPixels = { ax: 1, bx: 0, ay: 1, by: 0, resolution: 1 };

test('createRowGeometry gives each in-range row its latitude and a longitude linear in x', () => {
  const rowAt = createRowGeometry(fakeProjection, identityPixels);
  const row = rowAt(249.5 - 2.5 * 30 + 0.5 - 0.5); // local y for lat 30 is 175
  assert.ok(Math.abs(row.lat - 30) < 0.2, `lat ${row.lat}`);
  near(row.lngAt(479.5), 0, 1e-9); // pixel center x=479.5 + 0.5 = 480 -> lng 0
  near(row.lngAt(579.5), 50, 1e-9); // +100px = +50 degrees at 2px/degree
});

// Regression: rows below the south pole were painted with garbage terrain (horizontal
// stripes) because invert() returns an in-range latitude for out-of-range y.
test('createRowGeometry rejects rows beyond either pole instead of trusting invert()', () => {
  const rowAt = createRowGeometry(fakeProjection, identityPixels);
  assert.equal(rowAt(250 + 2.5 * 90 + 5), null, 'below the south pole');
  assert.equal(rowAt(250 - 2.5 * 90 - 5), null, 'above the north pole');
  assert.equal(rowAt(-100), null);
  assert.equal(rowAt(5000), null);
});

test('createRowGeometry keeps the last real row before each pole', () => {
  const rowAt = createRowGeometry(fakeProjection, identityPixels);
  assert.ok(rowAt(250 + 2.5 * 89), 'row at 89 degrees south is on the map');
  assert.ok(rowAt(250 - 2.5 * 89), 'row at 89 degrees north is on the map');
});

test('createRowGeometry honours the canvas resolution (half-res draft frames map to the same places)', () => {
  const full = createRowGeometry(fakeProjection, identityPixels)(200);
  const half = createRowGeometry(fakeProjection, { ...identityPixels, resolution: 0.5 })(100 - 0.5); // pixel 99.5 of a half-res canvas = pixel 199 of the full-res one
  assert.ok(Math.abs(full.lat - half.lat) < 0.5);
});

// ---- createElevationSampler -------------------------------------------------------------

const flatTile = (metres) => new Int16Array(256 * 256).fill(metres);

test('sampler uses the detail tile when it is loaded', () => {
  const tiles = new Map([['4/8/8', flatTile(1234)], ['2/2/2', flatTile(10)]]);
  const sample = createElevationSampler((z, x, y) => tiles.get(`${z}/${x}/${y}`) ?? null, 4);
  assert.equal(sample(0.5, -0.5), 1234); // lng/lat just inside tile 4/8/8
});

test('sampler falls back to a coarser tile for detail that has not arrived yet (never blank)', () => {
  const tiles = new Map([['2/2/1', flatTile(77)]]); // the z=2 tile covering lng 10, lat 10
  const sample = createElevationSampler((z, x, y) => tiles.get(`${z}/${x}/${y}`) ?? null, 5);
  assert.equal(sample(10, 10), 77);
});

test('sampler returns null when not even the base tile is loaded', () => {
  const sample = createElevationSampler(() => null, 3);
  assert.equal(sample(10, 10), null);
});

test('sampler clamps at the date line and the poles instead of indexing past the tile grid', () => {
  const requested = [];
  const sample = createElevationSampler((z, x, y) => {
    requested.push([z, x, y]);
    assert.ok(x >= 0 && x < 2 ** z && y >= 0 && y < 2 ** z, `tile ${z}/${x}/${y} is out of range`);
    return flatTile(5);
  }, 3);
  for (const [lng, lat] of [[180, 0], [-180, 0], [0, 90], [0, -90], [180, 90], [-180, -90]]) {
    assert.equal(sample(lng, lat), 5, `${lng},${lat}`);
  }
  assert.ok(requested.length > 0);
});

// The raster loop asks for millions of samples along scanlines; consecutive pixels almost
// always fall in the same tile, so the tile lookup (a Map read) must not be repeated per pixel.
test('sampler looks a tile up once per run of pixels inside it, not once per pixel', () => {
  let lookups = 0;
  const sample = createElevationSampler(() => {
    lookups++;
    return flatTile(1);
  }, 3);
  for (let i = 0; i < 200; i++) sample(10 + i * 0.01, 40); // 2 degrees of longitude: one tile at z=3 (45 degrees wide)
  assert.ok(lookups <= 2, `expected at most 2 tile lookups, got ${lookups}`);
});

// Pure elevation logic: the color bands (which are also the map key), Terrarium tile
// decoding, slippy-map tile math, bilinear sampling and the raster painter. No DOM, no
// network — ElevationLayer.js owns fetching and canvas; everything decision-shaped that a
// bug could hide in lives here so it can be unit-tested.
//
// Data: Mapzen "Terrarium" terrain tiles (public AWS Open Data, CORS-enabled, no key).
// Each pixel encodes elevation in metres as (R * 256 + G + B / 256) - 32768, with ocean
// floor as negative values (land: SRTM/GMTED; ocean: ETOPO1).

export const TILE_SIZE = 256;
export const TERRARIUM_MIN_ZOOM = 2; // whole world = 16 tiles: the always-loaded base layer
export const TERRARIUM_MAX_ZOOM = 5;
const MAX_MERCATOR_LATITUDE = 85.0511287798;

export function tileUrl(z, x, y) {
  return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
}

export function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

// The bands are the single source of truth: the raster painter colors from them and the
// on-screen key is generated from them, so the key can never disagree with the map.
// Ascending, each band is [min, max). Land uses a conventional hypsometric tint (green
// lowlands through browns to snow); ocean depth is a light-to-dark blue.
export const ELEVATION_BANDS = Object.freeze([
  { id: 'ocean-deep', group: 'ocean', min: -Infinity, max: -4000, color: '#4d7bab', label: 'Deeper than 4,000 m' },
  { id: 'ocean-mid', group: 'ocean', min: -4000, max: -200, color: '#86b1d3', label: '200 – 4,000 m deep' },
  { id: 'ocean-shelf', group: 'ocean', min: -200, max: 0, color: '#b7d8ea', label: '0 – 200 m deep' },
  { id: 'land-0', group: 'land', min: 0, max: 200, color: '#76ad6e', label: '0 – 200 m' },
  { id: 'land-200', group: 'land', min: 200, max: 500, color: '#a9c979', label: '200 – 500 m' },
  { id: 'land-500', group: 'land', min: 500, max: 1000, color: '#dbd88a', label: '500 – 1,000 m' },
  { id: 'land-1000', group: 'land', min: 1000, max: 2000, color: '#e6bd7a', label: '1,000 – 2,000 m' },
  { id: 'land-2000', group: 'land', min: 2000, max: 3000, color: '#cd9660', label: '2,000 – 3,000 m' },
  { id: 'land-3000', group: 'land', min: 3000, max: 4000, color: '#a86f48', label: '3,000 – 4,000 m' },
  { id: 'land-4000', group: 'land', min: 4000, max: 5000, color: '#7c5238', label: '4,000 – 5,000 m' },
  { id: 'land-5000', group: 'land', min: 5000, max: Infinity, color: '#f3efe9', label: 'Above 5,000 m' },
]);

const BAND_RGB = ELEVATION_BANDS.map((band) => [1, 3, 5].map((offset) => parseInt(band.color.slice(offset, offset + 2), 16)));
const FIRST_LAND_BAND = ELEVATION_BANDS.findIndex((band) => band.group === 'land');

// Lookup table over whole metres so the per-pixel loop is one array read, not a band search.
const LUT_MIN = -11000;
const LUT_MAX = 9000;
const BAND_LUT = new Uint8Array(LUT_MAX - LUT_MIN + 1);
for (let metres = LUT_MIN; metres <= LUT_MAX; metres++) {
  BAND_LUT[metres - LUT_MIN] = ELEVATION_BANDS.findIndex((band) => metres >= band.min && metres < band.max);
}

/** Band for an elevation in metres. Floors first: band edges are whole metres, so
 *  floor(x) < edge exactly when x < edge, which preserves [min, max) for fractions. */
export function bandIndexForElevation(metres) {
  const whole = Math.floor(metres);
  return BAND_LUT[Math.min(LUT_MAX, Math.max(LUT_MIN, whole)) - LUT_MIN];
}

/** Like bandIndexForElevation but never an ocean band — for pixels inside a country's
 *  outline, where "below sea level" means a dry depression (Dead Sea), not open sea. */
export function landBandIndexForElevation(metres) {
  return Math.max(FIRST_LAND_BAND, bandIndexForElevation(metres));
}

/** Legend rows: land highest-first (like reading up a mountain), ocean shallowest-first. */
export function elevationLegend() {
  const toItem = ({ color, label, id }) => ({ id, color, label });
  return {
    land: ELEVATION_BANDS.filter((b) => b.group === 'land').reverse().map(toItem),
    ocean: ELEVATION_BANDS.filter((b) => b.group === 'ocean').reverse().map(toItem),
  };
}

/** Fractional slippy-map tile coordinates. Latitude is clamped to the Web-Mercator limit
 *  so the poles map to the tile edge instead of Infinity/NaN. */
export function mercatorTileCoord(lng, lat, zoom) {
  const n = 2 ** zoom;
  const clamped = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, lat));
  const rad = (clamped * Math.PI) / 180;
  return {
    x: ((lng + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  };
}

/** One tile level deeper per doubling of map zoom, within the range the app fetches. */
export function tileZoomForScale(scale) {
  const level = TERRARIUM_MIN_ZOOM + Math.floor(Math.log2(Math.max(scale, 1e-6)));
  return Math.min(TERRARIUM_MAX_ZOOM, Math.max(TERRARIUM_MIN_ZOOM, level));
}

/** Bilinear sample of a square elevation grid. (fx, fy) are in texel space with texel
 *  centers at integer + 0.5; coordinates outside the grid clamp to the edge texel. */
export function bilinearElevation(grid, size, fx, fy) {
  const gx = Math.min(size - 1, Math.max(0, fx - 0.5));
  const gy = Math.min(size - 1, Math.max(0, fy - 0.5));
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(x0 + 1, size - 1);
  const y1 = Math.min(y0 + 1, size - 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const top = grid[y0 * size + x0] * (1 - tx) + grid[y0 * size + x1] * tx;
  const bottom = grid[y1 * size + x0] * (1 - tx) + grid[y1 * size + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * Elevation lookup at a longitude/latitude, preferring tiles at `zoom` and falling back
 * to progressively coarser ones (down to the always-loaded base level) for any tile that
 * has not arrived yet — so the map is never blank while detail tiles stream in.
 * @param {(z: number, x: number, y: number) => Int16Array | null} getTile
 * @returns {(lng: number, lat: number) => number | null}
 */
export function createElevationSampler(getTile, zoom) {
  let cachedLat = NaN;
  let rowY = 0;
  // Consecutive pixels on a scanline almost always land in the same tile, so remember the
  // last lookup per zoom level and skip the (string-keyed) tile store when it still applies.
  const lastLookup = new Map(); // z -> {tx, ty, tile}
  const lookup = (z, tx, ty) => {
    const last = lastLookup.get(z);
    if (last && last.tx === tx && last.ty === ty) return last.tile;
    const tile = getTile(z, tx, ty);
    lastLookup.set(z, { tx, ty, tile });
    return tile;
  };
  return (lng, lat) => {
    if (lat !== cachedLat) {
      cachedLat = lat;
      rowY = mercatorTileCoord(0, lat, zoom).y; // depends on latitude only; rows are scanned in order
    }
    const x = ((lng + 180) / 360) * 2 ** zoom;
    for (let z = zoom; z >= TERRARIUM_MIN_ZOOM; z--) {
      const shrink = 2 ** (zoom - z);
      const fx = x / shrink;
      const fy = rowY / shrink;
      const last = 2 ** z - 1;
      const tx = Math.min(last, Math.floor(fx));
      const ty = Math.min(last, Math.floor(fy));
      const tile = lookup(z, tx, ty);
      if (tile) return bilinearElevation(tile, TILE_SIZE, (fx - tx) * TILE_SIZE, (fy - ty) * TILE_SIZE);
    }
    return null;
  };
}

/**
 * Maps canvas rows to latitudes (and columns to longitudes) for a pseudocylindrical
 * projection such as Natural Earth, whose parallels are straight horizontal lines: each
 * row has ONE latitude, and longitude is linear in x along it.
 *
 * Rows beyond the poles must be rejected explicitly. `projection.invert` is an iterative
 * solver that does not fail cleanly out of range — it returns arbitrary in-range
 * latitudes — so without this check, rows below the south pole were painted with
 * garbage terrain as horizontal stripes.
 * @param {{project: (lngLat: [number, number]) => [number, number], invert: (xy: [number, number]) => [number, number] | null}} projection
 * @param {{ax: number, bx: number, ay: number, by: number, resolution: number}} pixelToLocal
 *   `local = pixel / resolution * a + b` on each axis (canvas pixels -> projected map units)
 * @returns {(cy: number) => ({lat: number, lngAt: (cx: number) => number} | null)}
 */
export function createRowGeometry(projection, { ax, bx, ay, by, resolution }) {
  const centralMeridianX = projection.project([0, 0])[0];
  const poleYs = [projection.project([0, 90])[1], projection.project([0, -90])[1]];
  const topY = Math.min(...poleYs);
  const bottomY = Math.max(...poleYs);
  return (cy) => {
    const localY = ((cy + 0.5) / resolution) * ay + by;
    if (localY < topY || localY > bottomY) return null;
    const lat = projection.invert([centralMeridianX, localY])?.[1];
    if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
    const [x0] = projection.project([0, lat]);
    const [x1] = projection.project([1, lat]);
    const perDegree = x1 - x0;
    return { lat, lngAt: (cx) => (((cx + 0.5) / resolution) * ax + bx - x0) / perDegree };
  };
}

/**
 * Paints an elevation raster. Two RGBA buffers come back: `all` colors ocean depth and
 * land; `land` colors everything as land, for compositing inside country outlines so the
 * crisp vector coastline wins over the (much coarser) raster's own 0 m contour.
 * @param {{width: number, height: number,
 *   rowGeometry: (cy: number) => ({lat: number, lngAt: (cx: number) => number} | null),
 *   sample: (lng: number, lat: number) => number | null}} args
 *   `rowGeometry` returns null for rows that are off the map. Natural Earth's parallels
 *   are straight lines, so each row has one latitude and a longitude linear in x.
 */
export function renderElevationRaster({ width, height, rowGeometry, sample }) {
  const all = new Uint8ClampedArray(width * height * 4);
  const land = new Uint8ClampedArray(width * height * 4);
  for (let cy = 0; cy < height; cy++) {
    const row = rowGeometry(cy);
    if (!row) continue;
    for (let cx = 0; cx < width; cx++) {
      const lng = row.lngAt(cx);
      if (lng < -180 || lng > 180) continue;
      const metres = sample(lng, row.lat);
      if (metres == null) continue;
      const offset = (cy * width + cx) * 4;
      const [ar, ag, ab] = BAND_RGB[bandIndexForElevation(metres)];
      const [lr, lg, lb] = BAND_RGB[landBandIndexForElevation(metres)];
      all[offset] = ar;
      all[offset + 1] = ag;
      all[offset + 2] = ab;
      all[offset + 3] = 255;
      land[offset] = lr;
      land[offset + 1] = lg;
      land[offset + 2] = lb;
      land[offset + 3] = 255;
    }
  }
  return { all, land };
}

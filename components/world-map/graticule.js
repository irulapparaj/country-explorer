// Pure data + formatting for the coordinate grid: which parallels/meridians to draw at a
// given zoom, the named special latitudes (equator, tropics, polar circles), and how their
// labels read. No DOM and no D3, so it is unit-testable; WorldMap draws what this returns.

// Textbook values: the tropics sit at the Earth's axial tilt (23.44 deg) and the polar
// circles at its complement.
export const TROPIC_LATITUDE = 23.44;
export const POLAR_CIRCLE_LATITUDE = 66.56;

/** North to south. `kind` drives styling: the equator is drawn heavier than the rest. */
export const SPECIAL_LINES = Object.freeze([
  { id: 'arctic-circle', name: 'Arctic Circle', lat: POLAR_CIRCLE_LATITUDE, kind: 'polar' },
  { id: 'cancer', name: 'Tropic of Cancer', lat: TROPIC_LATITUDE, kind: 'tropic' },
  { id: 'equator', name: 'Equator', lat: 0, kind: 'equator' },
  { id: 'capricorn', name: 'Tropic of Capricorn', lat: -TROPIC_LATITUDE, kind: 'tropic' },
  { id: 'antarctic-circle', name: 'Antarctic Circle', lat: -POLAR_CIRCLE_LATITUDE, kind: 'polar' },
]);

// [zoom at or above, grid step in degrees] — finer grid as you zoom in.
const GRID_STEPS = [
  { minZoom: 8, step: 5 },
  { minZoom: 4, step: 10 },
  { minZoom: 2, step: 15 },
  { minZoom: 0, step: 30 },
];

export function graticuleStepForZoom(zoom) {
  return GRID_STEPS.find((entry) => zoom >= entry.minZoom).step;
}

/** Parallels to label, ascending, excluding the poles (which are a point, not a line). */
export function parallelsForStep(step) {
  const lats = [];
  for (let lat = -90 + step; lat < 90; lat += step) lats.push(lat === 0 ? 0 : lat);
  return lats;
}

/** Meridians from the antimeridian west (-180) to the antimeridian east (180), inclusive. */
export function meridiansForStep(step) {
  const lngs = [];
  for (let lng = -180; lng <= 180; lng += step) lngs.push(lng);
  return lngs;
}

export function formatLatitude(lat) {
  if (lat === 0) return '0°';
  return `${Math.abs(lat)}°${lat > 0 ? 'N' : 'S'}`;
}

export function formatLongitude(lng) {
  if (lng === 0) return '0°';
  if (Math.abs(lng) === 180) return '180°';
  return `${Math.abs(lng)}°${lng > 0 ? 'E' : 'W'}`;
}

export function specialLineLabel(line) {
  return `${line.name} · ${formatLatitude(line.lat)}`;
}

/** Drops any tick closer than `minGap` to the previously kept one (input sorted by pos). */
export function thinTicks(ticks, minGap) {
  const kept = [];
  for (const tick of ticks) {
    if (kept.length === 0 || tick.pos - kept.at(-1).pos >= minGap) kept.push(tick);
  }
  return kept;
}

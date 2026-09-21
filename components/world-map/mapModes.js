// The map's user-facing options, kept as plain validated data so the controls, the map and
// the tests all agree on what is legal.

export const MAP_MODES = Object.freeze([
  { id: 'political', label: 'Political' },
  { id: 'geographic', label: 'Geographic' },
  { id: 'elevation', label: 'Elevation' },
]);

// "Major" is the original behavior: the biggest countries are named from the world view
// and more names are revealed as you zoom. "All" offers every country's name at every
// zoom (a name is still only drawn where it fits inside its country). "Continents" swaps
// country names for the seven continent names only.
// `short` is what fits in the compact control; the rest of `label` stays in the accessible
// name (screen readers still hear "Major countries").
export const LABEL_MODES = Object.freeze([
  { id: 'major', label: 'Major countries', short: 'Major' },
  { id: 'all', label: 'All countries', short: 'All' },
  { id: 'continents', label: 'Continents only', short: 'Continents' },
]);

export const DEFAULT_OPTIONS = Object.freeze({
  mapMode: 'political',
  labelMode: 'major',
  showGrid: true,
  showWaterNames: true,
});

const MAP_MODE_IDS = new Set(MAP_MODES.map((m) => m.id));
const LABEL_MODE_IDS = new Set(LABEL_MODES.map((m) => m.id));

/**
 * Validates a partial options object and layers it over `previous` (defaults if omitted).
 * Unknown or wrongly-typed values fall back to `previous`'s value; returns a new frozen
 * object and never mutates its inputs.
 */
export function normalizeOptions(partial = {}, previous = DEFAULT_OPTIONS) {
  const patch = partial || {};
  return Object.freeze({
    mapMode: MAP_MODE_IDS.has(patch.mapMode) ? patch.mapMode : previous.mapMode,
    labelMode: LABEL_MODE_IDS.has(patch.labelMode) ? patch.labelMode : previous.labelMode,
    showGrid: typeof patch.showGrid === 'boolean' ? patch.showGrid : previous.showGrid,
    showWaterNames: typeof patch.showWaterNames === 'boolean' ? patch.showWaterNames : previous.showWaterNames,
  });
}

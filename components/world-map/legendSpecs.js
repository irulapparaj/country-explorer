// What the on-screen key (MapLegend) shows for each map style. Pure data, generated from
// the same tables the map is painted from, so a key can never disagree with its map.

import { elevationLegend } from './elevation.js';
import { CONTINENTS, continentSlug } from './continents.js';

const ELEVATION_NOTE = 'Terrain: Mapzen Terrain Tiles (SRTM, GMTED, ETOPO1) via AWS Open Data.';

/**
 * @param {string} mapMode one of the ids in MAP_MODES
 * @returns {{title: string, ariaLabel: string, groups: Array<{heading?: string, items: Array<{label: string, color?: string, swatchClass?: string}>}>, note?: string} | null}
 */
export function legendForMode(mapMode) {
  if (mapMode === 'geographic') {
    return {
      title: 'Geographic regions',
      ariaLabel: 'Continent key',
      groups: [{ items: CONTINENTS.map((name) => ({ label: name, swatchClass: `continent-${continentSlug(name)}` })) }],
    };
  }
  if (mapMode === 'elevation') {
    const { land, ocean } = elevationLegend();
    const toItem = ({ label, color }) => ({ label, color });
    return {
      title: 'Elevation',
      ariaLabel: 'Elevation key',
      groups: [
        { heading: 'Land elevation', items: land.map(toItem) },
        { heading: 'Ocean depth', items: ocean.map(toItem) },
      ],
      note: ELEVATION_NOTE,
    };
  }
  return null;
}

// Names of oceans and seas, drawn on the map at fixed geographic anchors — the way a
// printed atlas places them, since there is no polygon in the country data to derive them
// from. Oceans are always shown; seas appear as you zoom in so the world view stays
// uncluttered.

const ocean = (id, name, lng, lat) => ({ id, name, lng, lat, kind: 'ocean', minZoom: 1 });
const sea = (id, name, lng, lat, minZoom = 2.5) => ({ id, name, lng, lat, kind: 'sea', minZoom });

export const WATER_LABELS = Object.freeze([
  ocean('north-pacific', 'North Pacific Ocean', -140, 28),
  ocean('south-pacific', 'South Pacific Ocean', -132, -28),
  ocean('north-atlantic', 'North Atlantic Ocean', -40, 33),
  ocean('south-atlantic', 'South Atlantic Ocean', -15, -25),
  ocean('indian', 'Indian Ocean', 78, -22),
  ocean('southern', 'Southern Ocean', 60, -61),
  ocean('arctic', 'Arctic Ocean', -110, 82),

  sea('mediterranean', 'Mediterranean Sea', 18, 34.5),
  sea('caribbean', 'Caribbean Sea', -75, 15),
  sea('gulf-of-mexico', 'Gulf of Mexico', -90, 25),
  sea('arabian', 'Arabian Sea', 65, 15),
  sea('bay-of-bengal', 'Bay of Bengal', 88, 14),
  sea('south-china', 'South China Sea', 114, 12),
  sea('sea-of-japan', 'Sea of Japan', 135, 40),
  sea('north-sea', 'North Sea', 3, 56),
  sea('norwegian', 'Norwegian Sea', 2, 68),
  sea('hudson-bay', 'Hudson Bay', -85, 60),
  sea('gulf-of-guinea', 'Gulf of Guinea', 0, 3),
  sea('tasman', 'Tasman Sea', 160, -38),
  sea('coral', 'Coral Sea', 154, -16),
  sea('baltic', 'Baltic Sea', 19.5, 58.5, 3.5),
  sea('black', 'Black Sea', 34, 43.3, 3.5),
  sea('red', 'Red Sea', 38, 20, 3.5),
]);

export function waterLabelsForZoom(zoom) {
  return WATER_LABELS.filter((label) => zoom >= label.minZoom);
}

/**
 * Oceans are long names on a world map, so they are set on two lines — "North Pacific" /
 * "Ocean" — which keeps them clear of neighboring coasts and inside the frame. Seas stay
 * on one line.
 * @returns {string[]}
 */
export function labelLines(label) {
  if (label.kind !== 'ocean') return [label.name];
  const match = label.name.match(/^(.*\S)\s+(Ocean)$/);
  return match ? [match[1], match[2]] : [label.name];
}

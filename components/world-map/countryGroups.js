// Two drawn shapes can carry the same ISO code — in world-atlas, Ashmore and Cartier Islands
// (3 km2) shares Australia's numeric id. Everything keyed by ISO code (selection, zoom, the
// side panel, labels) must resolve to the real country, not whichever shape came last.

/**
 * @template {{iso3: string | null, area: number}} Shape
 * @param {Shape[]} shapes
 * @returns {{primaryByIso3: Map<string, Shape>, partsByIso3: Map<string, Shape[]>}}
 *   `primaryByIso3` maps each ISO code to its LARGEST shape (first wins a tie);
 *   `partsByIso3` lists every shape carrying the code, primary included. Shapes with no
 *   ISO code belong to no group.
 */
export function groupShapesByCountry(shapes) {
  const primaryByIso3 = new Map();
  const partsByIso3 = new Map();
  for (const shape of shapes) {
    if (!shape.iso3) continue;
    partsByIso3.set(shape.iso3, [...(partsByIso3.get(shape.iso3) ?? []), shape]);
    const current = primaryByIso3.get(shape.iso3);
    if (!current || shape.area > current.area) primaryByIso3.set(shape.iso3, shape);
  }
  return { primaryByIso3, partsByIso3 };
}

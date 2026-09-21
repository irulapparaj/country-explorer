// Two related jobs for countries made of several separate pieces (France mainland vs.
// French Guiana, USA lower-48 vs. Alaska/Hawaii, Russia vs. Kaliningrad):
//
//  1. getMainLandmass — the largest single polygon, used to *label* a country. Labeling
//     the whole feature's centroid would drop France's label somewhere over the Atlantic.
//  2. getDisplayBounds — the bounds of every *significant* piece, used to *zoom* to a
//     country so the user sees all of it (French Guiana, Alaska and Hawaii included),
//     while still ignoring specks of land and pieces that wrap around the ±180° edge.
//
// Takes d3's geoArea/geoBounds/geoCentroid as injected dependencies rather than
// importing d3 (loaded as a global UMD script, not an ES module in this project) —
// this keeps the module runnable and unit-testable in plain Node with fake area/bounds
// functions, no browser or D3 required.

/** Splits a Polygon (returned as-is) or MultiPolygon (one feature per polygon) into
 * single-polygon pseudo-features sharing the original feature's properties/id. */
export function toSinglePolygonFeatures(feature) {
  const geometry = feature?.geometry;
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [feature];
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.map((rings) => ({
      type: 'Feature',
      id: feature.id,
      properties: feature.properties,
      geometry: { type: 'Polygon', coordinates: rings },
    }));
  }
  return [];
}

/**
 * @param {object} feature a GeoJSON Feature (Polygon or MultiPolygon)
 * @param {{geoArea: Function, geoBounds: Function, geoCentroid: Function}} geo
 * @returns {{feature: object, bounds: [[number,number],[number,number]], centroid: [number,number]} | null}
 */
export function getMainLandmass(feature, { geoArea, geoBounds, geoCentroid }) {
  const polygons = toSinglePolygonFeatures(feature);
  if (polygons.length === 0) return null;

  let largest = polygons[0];
  let largestArea = geoArea(largest);
  for (const polygon of polygons.slice(1)) {
    const area = geoArea(polygon);
    if (area > largestArea) {
      largest = polygon;
      largestArea = area;
    }
  }

  return {
    feature: largest,
    bounds: geoBounds(largest),
    centroid: geoCentroid(largest),
  };
}

// A polygon counts as a real part of a country (worth zooming out to include) when it is
// at least this share of the country's total land area. Calibrated against the real
// world-atlas topology: Hawaii's Big Island (0.11% of the USA), Réunion (0.40% of France)
// and Mayotte (0.065%) are in; Bouvet-scale specks (~0.01%) that would drag Norway's zoom
// down to the sub-Antarctic are out.
export const MIN_TERRITORY_SHARE = 0.00015;

/**
 * Min/max of a polygon's projected ring points, over EVERY ring (Antarctica's exterior ring
 * is a zero-height line along the pole and its real coastline is the interior ring).
 *
 * Projecting real ring points sidesteps antimeridian math for polygons that are merely
 * adjacent to ±180°. It is NOT enough for a polygon whose own ring runs across the
 * antimeridian — Russia's largest polygon is one ring spanning longitudes -180..180, so
 * its far-side points project to the opposite edge of the map and stretch the box across
 * it. Pass `anchorX` (the polygon's projected centroid x) and `maxSeparationX` (normally
 * half the map width) to drop points that are farther than that from the anchor.
 * @param {object} polygonFeature a single-Polygon GeoJSON Feature
 * @param {(lngLat: [number, number]) => [number, number] | null} project
 * @param {{anchorX?: number, maxSeparationX?: number}} [wrap]
 * @returns {[[number, number], [number, number]]}
 */
export function projectedRingBounds(polygonFeature, project, { anchorX, maxSeparationX } = {}) {
  const filterFarSide = Number.isFinite(anchorX) && Number.isFinite(maxSeparationX);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const ring of polygonFeature.geometry.coordinates) {
    for (const point of ring) {
      const projected = project(point);
      if (!projected) continue;
      const [x, y] = projected;
      if (filterFarSide && Math.abs(x - anchorX) > maxSeparationX) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return [[x0, y0], [x1, y1]];
}

/**
 * Projected bounds of everything a user should see when zooming to a country: its largest
 * polygon plus every other polygon that is (a) a meaningful share of the country's area
 * and (b) on the same side of a non-wrapping map as the largest one. Rule (b) drops pieces
 * across the antimeridian (Chatham Islands vs. New Zealand, Chukotka's far tip vs. Russia,
 * the western Aleutians vs. the USA): they are close on Earth but at opposite edges of the
 * flat map, so including them would zoom out to the whole world.
 * @param {object} feature a GeoJSON Feature (Polygon or MultiPolygon)
 * @param {{geoArea: Function, geoCentroid: Function, project: Function, maxSeparationX: number}} geo
 *   `maxSeparationX` is the largest horizontal distance (in projected units, normally half
 *   the map width) at which a piece still counts as being on the same side as the main one.
 * @returns {{bounds: [[number, number], [number, number]], polygonCount: number, mainShare: number} | null}
 *   `mainShare` is the largest polygon's fraction of the country's total area (1 = one landmass);
 *   callers use it to decide whether there is a dominant mainland worth centering on.
 */
export function getDisplayBounds(feature, { geoArea, geoCentroid, project, maxSeparationX }) {
  const polygons = toSinglePolygonFeatures(feature);
  if (polygons.length === 0) return null;

  const areas = polygons.map((polygon) => geoArea(polygon));
  const totalArea = areas.reduce((sum, area) => sum + area, 0);
  const anchorIndex = areas.indexOf(Math.max(...areas));
  const anchorX = project(geoCentroid(polygons[anchorIndex]))?.[0];

  const included = polygons.filter((polygon, i) => {
    if (i === anchorIndex) return true;
    if (totalArea > 0 && areas[i] / totalArea < MIN_TERRITORY_SHARE) return false;
    const x = project(geoCentroid(polygon))?.[0];
    return x != null && anchorX != null && Math.abs(x - anchorX) <= maxSeparationX;
  });

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const polygon of included) {
    // Each polygon is measured against its OWN center: a ring that wraps across ±180° has
    // its far-side points dropped without touching the (legitimate) far-apart polygons.
    const [[px0, py0], [px1, py1]] = projectedRingBounds(polygon, project, {
      anchorX: project(geoCentroid(polygon))?.[0],
      maxSeparationX,
    });
    x0 = Math.min(x0, px0);
    y0 = Math.min(y0, py0);
    x1 = Math.max(x1, px1);
    y1 = Math.max(y1, py1);
  }
  if (!Number.isFinite(x0)) return null;
  return { bounds: [[x0, y0], [x1, y1]], polygonCount: included.length, mainShare: totalArea > 0 ? areas[anchorIndex] / totalArea : 1 };
}

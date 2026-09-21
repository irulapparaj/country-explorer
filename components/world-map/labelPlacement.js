// Greedy label placement: given candidates already sorted most-important-first, keep
// a label only if it fits inside its own country's on-screen bounds and doesn't
// overlap a label already placed. Pure geometry — screen-space anchor points, text box
// sizes, and country bounding boxes are passed in, so this has no DOM/D3 dependency
// and no notion of zoom level; the caller (WorldMap.js) recomputes and re-calls this on
// every zoom tick with fresh screen-space numbers.

function candidateBox({ anchor, width, height }) {
  return {
    x0: anchor[0] - width / 2,
    y0: anchor[1] - height / 2,
    x1: anchor[0] + width / 2,
    y1: anchor[1] + height / 2,
  };
}

function fitsWithinBounds(box, bounds) {
  if (!bounds) return true; // no constraint given => don't block placement on it
  const [[bx0, by0], [bx1, by1]] = bounds;
  return box.x0 >= bx0 && box.x1 <= bx1 && box.y0 >= by0 && box.y1 <= by1;
}

function boxesOverlap(a, b) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

/**
 * @param {Array<{id: string, anchor: [number, number], width: number, height: number, countryScreenBounds?: [[number,number],[number,number]]}>} candidates
 * @returns same candidates, filtered to just the ones that got placed, each with a `box`
 */
export function placeLabels(candidates) {
  const placed = [];
  for (const candidate of candidates) {
    const box = candidateBox(candidate);
    if (!fitsWithinBounds(box, candidate.countryScreenBounds)) continue;
    if (placed.some((p) => boxesOverlap(box, p.box))) continue;
    placed.push({ ...candidate, box });
  }
  return placed;
}

// Tiers control which labels are even offered as candidates at a given zoom level:
// major countries (by main-landmass area) show from the world view; the rest reveal
// as the user zooms in. Border/label sizes stay constant while zooming (handled by the
// renderer counter-scaling the label group by 1/k) — only which labels are *candidates*
// changes with zoom, not their rendered size.
export const LABEL_TIERS = [
  { minZoom: 1, rankUpTo: 30 },
  { minZoom: 2.2, rankUpTo: 90 },
  { minZoom: 4, rankUpTo: Infinity },
];

/**
 * @param {number} rank 0-based position in the area-sorted country list
 * @param {number} zoomScale
 * @param {'major' | 'all'} [scope] 'major' = progressive reveal by tier (the original
 *   behavior); 'all' = every country is a candidate at every zoom, leaving the fit and
 *   no-overlap rules in placeLabels to decide what actually gets drawn.
 */
export function visibleAtZoom(rank, zoomScale, scope = 'major') {
  if (scope === 'all') return true;
  return LABEL_TIERS.some((tier) => zoomScale >= tier.minZoom && rank < tier.rankUpTo);
}

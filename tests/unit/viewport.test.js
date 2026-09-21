import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  viewBoxMapping,
  localToScreen,
  screenToLocal,
  visibleLocalRect,
  availableViewRect,
  fitTransform,
  shouldKeepZoom,
} from '../../components/world-map/viewport.js';

const VB = { width: 960, height: 500 };
const near = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} != ${expected}`);

// The map SVG uses preserveAspectRatio="xMidYMid slice": it fills the container and crops
// whichever axis overflows. Everything that positions HTML over the map (frame labels,
// the "uncovered by the side panel" centering) must use this exact mapping.

test('a container wider than the map crops top/bottom (slice), centered', () => {
  const m = viewBoxMapping(1920, 800, VB.width, VB.height); // 2.4:1, map is 1.92:1
  near(m.scale, 2); // 1920/960
  near(m.offsetX, 0);
  near(m.offsetY, (800 - 500 * 2) / 2); // -100: 100px of the map cropped top and bottom
});

test('a container narrower than the map crops left/right (slice), centered', () => {
  const m = viewBoxMapping(1440, 900, VB.width, VB.height);
  near(m.scale, 1.8); // max(1440/960, 900/500)
  near(m.offsetX, (1440 - 960 * 1.8) / 2);
  near(m.offsetY, 0);
});

test('localToScreen and screenToLocal are inverses under an arbitrary zoom transform', () => {
  const m = viewBoxMapping(1440, 900, VB.width, VB.height);
  const t = { x: -120, y: -40, k: 3.5 };
  const screen = localToScreen([200, 150], m, t);
  const back = screenToLocal(screen, m, t);
  near(back[0], 200);
  near(back[1], 150);
});

test('at the identity transform the visible local rect is exactly what slice leaves on screen', () => {
  const m = viewBoxMapping(1440, 900, VB.width, VB.height);
  const rect = visibleLocalRect(m, { x: 0, y: 0, k: 1 }, 1440, 900);
  near(rect.x0, 80);
  near(rect.x1, 880);
  near(rect.y0, 0);
  near(rect.y1, 500);
});

test('zooming in shrinks the visible local rect proportionally', () => {
  const m = viewBoxMapping(1440, 900, VB.width, VB.height);
  const rect = visibleLocalRect(m, { x: 0, y: 0, k: 2 }, 1440, 900);
  near(rect.x1 - rect.x0, 400);
  near(rect.y1 - rect.y0, 250);
});

test('a right-hand side panel shrinks the available view rect by its width, in view-box units', () => {
  const m = viewBoxMapping(1440, 900, VB.width, VB.height);
  const rect = availableViewRect(m, 1440, 900, { right: 360, bottom: 0 });
  near(rect.x0, 80);
  near(rect.x1, 880 - 360 / 1.8);
  near(rect.y0, 0);
  near(rect.y1, 500);
});

test('a bottom sheet (phones) shrinks the available view rect from below instead', () => {
  const m = viewBoxMapping(375, 667, VB.width, VB.height);
  const full = availableViewRect(m, 375, 667, { right: 0, bottom: 0 });
  const withSheet = availableViewRect(m, 375, 667, { right: 0, bottom: 300 });
  near(full.x1 - full.x0, withSheet.x1 - withSheet.x0);
  near(full.y1 - withSheet.y1, 300 / m.scale);
});

test('fitTransform centers the bounds in the available rect and never zooms past the limits', () => {
  const rect = { x0: 0, y0: 0, x1: 800, y1: 500 };
  const t = fitTransform([[100, 100], [200, 200]], rect, { minScale: 1, maxScale: 12, padding: 0.75 });
  // bounds are 100x100: fit scale = 0.75 * min(800/100, 500/100) = 3.75
  near(t.k, 3.75);
  // the bounds' center (150,150) must land on the rect's center (400,250)
  near(t.x + 150 * t.k, 400);
  near(t.y + 150 * t.k, 250);
});

test('fitTransform clamps a huge country to minScale and a speck to maxScale', () => {
  const rect = { x0: 0, y0: 0, x1: 800, y1: 500 };
  assert.equal(fitTransform([[0, 0], [2000, 900]], rect, { minScale: 1, maxScale: 12, padding: 0.75 }).k, 1);
  assert.equal(fitTransform([[10, 10], [10.1, 10.1]], rect, { minScale: 1, maxScale: 12, padding: 0.75 }).k, 12);
});

test('regression: the fit uses the VISIBLE part of the map, not the whole view box', () => {
  // On a 1440x900 screen slice hides 80 view-box units on each side and a 560px panel
  // covers 311 more. The old code fit to (960 - 311) = 649 units wide; only ~489 are
  // actually uncovered, so a country fitted to 649 poked out under the panel.
  const m = viewBoxMapping(1440, 900, VB.width, VB.height);
  const rect = availableViewRect(m, 1440, 900, { right: 560, bottom: 0 });
  near(rect.x1 - rect.x0, 800 - 560 / 1.8);
});

// ---- fitTransform with a focus point (center the country's main body, still fit its territories) ----

test('fitTransform with a focus keeps that point at the center of the area and every bound inside it', () => {
  const rect = { x0: 0, y0: 0, x1: 800, y1: 500 };
  const bounds = [[100, 100], [500, 200]]; // e.g. mainland at the right end, an overseas territory far left
  const focus = [450, 150];
  // (minScale is below the fit scale here, so nothing is clamped and exact centering is feasible)
  const t = fitTransform(bounds, rect, { minScale: 0.1, maxScale: 12, padding: 0.75, focus });
  near(t.x + 450 * t.k, 400); // the focus lands on the center of the rect...
  near(t.y + 150 * t.k, 250);
  for (const [bx, by] of [[100, 100], [500, 100], [100, 200], [500, 200]]) {
    const sx = t.x + bx * t.k;
    const sy = t.y + by * t.k;
    assert.ok(sx >= 0 && sx <= 800 && sy >= 0 && sy <= 500, `corner (${bx},${by}) -> (${sx},${sy}) must be inside the rect`);
  }
});

test('centering on an off-center focus costs zoom: it must be at least as zoomed-out as centering on the bounds', () => {
  const rect = { x0: 0, y0: 0, x1: 800, y1: 500 };
  const bounds = [[100, 100], [500, 200]];
  const centered = fitTransform(bounds, rect, { minScale: 1, maxScale: 12, padding: 0.75 });
  const focused = fitTransform(bounds, rect, { minScale: 1, maxScale: 12, padding: 0.75, focus: [450, 150] });
  assert.ok(focused.k < centered.k);
});

test('a focus at the exact center of the bounds behaves exactly like no focus', () => {
  const rect = { x0: 20, y0: 0, x1: 700, y1: 500 };
  const bounds = [[100, 100], [300, 260]];
  const a = fitTransform(bounds, rect, { minScale: 1, maxScale: 12, padding: 0.75 });
  const b = fitTransform(bounds, rect, { minScale: 1, maxScale: 12, padding: 0.75, focus: [200, 180] });
  near(a.k, b.k);
  near(a.x, b.x);
  near(a.y, b.y);
});

test('a focus on the edge of the bounds still yields a finite, in-range scale', () => {
  const rect = { x0: 0, y0: 0, x1: 800, y1: 500 };
  const t = fitTransform([[100, 100], [200, 200]], rect, { minScale: 1, maxScale: 12, padding: 0.75, focus: [100, 100] });
  assert.ok(Number.isFinite(t.k) && t.k >= 1 && t.k <= 12);
});

// ---- focusTolerance: the focus need not be EXACTLY centered, only near the center ----------------
// Requiring exact symmetry around the mainland is too costly when the territories all lie one way
// (France: Guiana and Réunion are far south of it) — the frame outgrows the world. So the focus
// may sit up to `focusTolerance` * (half the view) from the center, and the frame is the smallest
// one that still contains every bound.

const RECT = { x0: 0, y0: 0, x1: 800, y1: 500 };
const LIMITS = { minScale: 0.1, maxScale: 100, padding: 1 };

test('with a tolerance the focus may sit off-center, but never by more than tolerance x half-view', () => {
  const bounds = [[0, 200], [1000, 300]]; // wide: a mainland at x=900 with a far territory at x=0
  for (const tolerance of [0, 0.15, 0.3, 0.6]) {
    const t = fitTransform(bounds, RECT, { ...LIMITS, focus: [900, 250], focusTolerance: tolerance });
    const halfView = 400 / t.k; // half the visible width, in local units
    const viewCenter = (400 - t.x) / t.k;
    assert.ok(Math.abs(viewCenter - 900) <= tolerance * halfView + 1e-6, `tolerance ${tolerance}: focus is ${Math.abs(viewCenter - 900)} from center, allowed ${tolerance * halfView}`);
  }
});

test('with a tolerance every bound is still inside the area', () => {
  const bounds = [[0, 100], [1000, 400]];
  const t = fitTransform(bounds, RECT, { ...LIMITS, focus: [900, 350], focusTolerance: 0.3 });
  for (const [bx, by] of [[0, 100], [1000, 100], [0, 400], [1000, 400]]) {
    const sx = t.x + bx * t.k;
    const sy = t.y + by * t.k;
    assert.ok(sx >= -1e-6 && sx <= 800 + 1e-6 && sy >= -1e-6 && sy <= 500 + 1e-6, `(${bx},${by}) -> (${sx},${sy})`);
  }
});

test('a larger tolerance zooms in at least as far (more slack = a tighter frame)', () => {
  const bounds = [[0, 200], [1000, 300]];
  const ks = [0, 0.15, 0.3, 0.6, 1].map((tolerance) => fitTransform(bounds, RECT, { ...LIMITS, focus: [900, 250], focusTolerance: tolerance }).k);
  for (let i = 1; i < ks.length; i++) assert.ok(ks[i] >= ks[i - 1] - 1e-9, `tolerance step ${i}: ${ks[i]} < ${ks[i - 1]}`);
});

test('a tolerance of 1 with the focus inside the bounds fits exactly like no focus at all', () => {
  const bounds = [[0, 200], [1000, 300]];
  const plain = fitTransform(bounds, RECT, LIMITS);
  const loose = fitTransform(bounds, RECT, { ...LIMITS, focus: [900, 250], focusTolerance: 1 });
  near(plain.k, loose.k, 1e-6);
});

test('when the frame ends up larger than needed the focus is centered as closely as possible', () => {
  // the vertical extent is what limits k; horizontally there is slack, so the focus can be centered exactly
  const bounds = [[400, 0], [500, 1000]];
  const t = fitTransform(bounds, RECT, { ...LIMITS, focus: [450, 900], focusTolerance: 0.3 });
  near(t.x + 450 * t.k, 400, 1e-6);
});

test('the tolerance keeps a France-like case zoomed in where exact symmetry would not', () => {
  // mainland near the top of a very tall spread, territories far below it
  const bounds = [[0, 0], [400, 1000]];
  const focus = [200, 50];
  const exact = fitTransform(bounds, RECT, { ...LIMITS, focus });
  const tolerant = fitTransform(bounds, RECT, { ...LIMITS, focus, focusTolerance: 0.3 });
  assert.ok(tolerant.k > exact.k * 1.25, `${tolerant.k} vs ${exact.k}`); // exactly (1 + tolerance) x here
});

// Found by review: when the zoom limit (minScale) forced a view too small to honor the tolerance, the
// fallback centered exactly on the focus even when the view WAS big enough to hold every territory —
// clipping territories that a slightly different center would have shown. (Real case: a France-like
// spread on a phone with a bottom sheet.)
test('when only the tolerance cannot be met (the bounds still fit), the frame holds the bounds rather than clipping them', () => {
  const rect = { x0: 0, y0: 0, x1: 800, y1: 200 };
  const bounds = [[0, 60], [800, 250]]; // 190 tall; the view is 200 tall at minScale 1
  const t = fitTransform(bounds, rect, { minScale: 1, maxScale: 12, padding: 1, focus: [400, 70], focusTolerance: 0.15 });
  assert.equal(t.k, 1);
  const top = t.y + 60 * t.k;
  const bottom = t.y + 250 * t.k;
  assert.ok(top >= -1e-6 && bottom <= 200 + 1e-6, `bounds must be inside the view, got ${top}..${bottom}`);
});

test('when the bounds truly cannot fit at the zoom limit, the focus (the country itself) wins', () => {
  const rect = { x0: 0, y0: 0, x1: 800, y1: 100 };
  const bounds = [[0, 0], [800, 1000]]; // far taller than the view can ever be at minScale 1
  const t = fitTransform(bounds, rect, { minScale: 1, maxScale: 12, padding: 1, focus: [400, 30], focusTolerance: 0.15 });
  near(t.y + 30 * t.k, 50, 1e-6);
});

// ---- clicking the country that is already selected ---------------------------------------------------------

// The fit for the selected country, its scale, and where the user's own zoom is now.
const keep = (overrides) => shouldKeepZoom({ fromMapClick: true, wasSelected: true, currentScale: 4, fitScale: 3.5, minScale: 1, ...overrides });

test('re-clicking the selected country keeps a zoom the user chose on purpose (at or beyond the fit)', () => {
  assert.equal(keep({ currentScale: 8 }), true, 'zoomed in further than the fit');
  assert.equal(keep({ currentScale: 3.5 }), true, 'at the fit');
  assert.equal(keep({ currentScale: 3.4 }), true, 'within the tolerance below the fit');
});

test('re-clicking it while zoomed OUT still zooms to it', () => {
  assert.equal(keep({ currentScale: 1 }), false, 'the world view');
  assert.equal(keep({ currentScale: 2 }), false, 'partway');
});

test('a first selection, or a selection from search, is never a "keep"', () => {
  assert.equal(keep({ wasSelected: false }), false);
  assert.equal(keep({ fromMapClick: false }), false);
});

// Found by review: where the fit itself is clamped at the minimum scale (Antarctica; Russia and the USA on a
// phone) "at least as zoomed as the fit" is true even at the world view, so the click did nothing, for good.
test('where the fit is clamped at the minimum scale, the world view does not count as a deliberate zoom', () => {
  assert.equal(keep({ fitScale: 1, currentScale: 1 }), false, 'world view: the click re-applies the fit');
  assert.equal(keep({ fitScale: 1, currentScale: 1.02 }), false, 'a hair above the world view is still the world view');
  assert.equal(keep({ fitScale: 1, currentScale: 2 }), true, 'but a real zoom-in is kept');
  assert.equal(keep({ fitScale: 1.01, currentScale: 1 }), false, 'a fit just above the minimum behaves the same way');
});

// Mutation testing by review: the `>=` boundary, and the size of the "deliberate zoom" step, were not pinned.
test('shouldKeepZoom: exactly 95% of the fit is enough, a hair less is not', () => {
  assert.equal(keep({ fitScale: 4, currentScale: 3.8 }), true);
  assert.equal(keep({ fitScale: 4, currentScale: 3.79 }), false);
});

test('shouldKeepZoom: where the fit is clamped, 5% beyond the minimum counts as a deliberate zoom, 4% does not', () => {
  assert.equal(keep({ fitScale: 1, currentScale: 1.05 }), true);
  assert.equal(keep({ fitScale: 1, currentScale: 1.1 }), true);
  assert.equal(keep({ fitScale: 1, currentScale: 1.04 }), false);
});

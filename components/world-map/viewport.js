// Geometry of the map's on-screen frame. The SVG uses preserveAspectRatio="xMidYMid slice":
// the 960x500 view box is scaled until it FILLS the container, and whichever axis
// overflows is cropped, centered. So the part of the view box the user actually sees is
// smaller than 0..960 x 0..500 on most screens, and anything positioned in HTML over the
// map (frame labels, the "center in the part the side panel doesn't cover" fit) has to
// use this same mapping rather than assuming the whole view box is visible.
//
// "local" coordinates below are the zoom layer's own coordinates — the projected map
// before the d3-zoom transform {x, y, k} is applied. "screen" coordinates are CSS pixels
// relative to the map container.

import { clamp } from '../../lib/mathUtils.js';

/** @returns {{scale: number, offsetX: number, offsetY: number}} view-box unit -> CSS px */
export function viewBoxMapping(containerWidth, containerHeight, viewBoxWidth, viewBoxHeight) {
  const scale = Math.max(containerWidth / viewBoxWidth, containerHeight / viewBoxHeight);
  return {
    scale,
    offsetX: (containerWidth - viewBoxWidth * scale) / 2,
    offsetY: (containerHeight - viewBoxHeight * scale) / 2,
  };
}

export function localToScreen([x, y], mapping, transform) {
  return [
    mapping.offsetX + mapping.scale * (transform.x + transform.k * x),
    mapping.offsetY + mapping.scale * (transform.y + transform.k * y),
  ];
}

export function screenToLocal([sx, sy], mapping, transform) {
  return [
    ((sx - mapping.offsetX) / mapping.scale - transform.x) / transform.k,
    ((sy - mapping.offsetY) / mapping.scale - transform.y) / transform.k,
  ];
}

/** The rectangle of local (zoom-layer) space currently visible in the container. */
export function visibleLocalRect(mapping, transform, containerWidth, containerHeight) {
  const [x0, y0] = screenToLocal([0, 0], mapping, transform);
  const [x1, y1] = screenToLocal([containerWidth, containerHeight], mapping, transform);
  return { x0, y0, x1, y1 };
}

/**
 * The part of the view box that is on screen AND not covered by the side panel — the area
 * a selected country should be fitted and centered in. `insets` are CSS pixels.
 */
export function availableViewRect(mapping, containerWidth, containerHeight, insets = {}) {
  const { right = 0, bottom = 0 } = insets;
  const toViewBoxX = (px) => (px - mapping.offsetX) / mapping.scale;
  const toViewBoxY = (px) => (px - mapping.offsetY) / mapping.scale;
  return {
    x0: toViewBoxX(0),
    y0: toViewBoxY(0),
    x1: toViewBoxX(containerWidth - right),
    y1: toViewBoxY(containerHeight - bottom),
  };
}

// Smallest view half-extent (local units) that contains [lo, hi] while keeping `focus` within
// `tolerance * half` of the view's center. tolerance 0 = focus exactly at the center (symmetric
// view); tolerance >= 1 with the focus inside [lo, hi] = no constraint beyond containing [lo, hi].
function requiredHalfExtent(lo, hi, focus, tolerance) {
  return Math.max((hi - lo) / 2, (hi - focus) / (1 + tolerance), (focus - lo) / (1 + tolerance), 0.25);
}

// Where to put the view's center, given the view's ACTUAL half-extent (>= the required one): as
// close to the focus as containing [lo, hi] and honoring the tolerance allow.
function viewCenter(lo, hi, focus, tolerance, half) {
  const minCenter = Math.max(hi - half, focus - tolerance * half);
  const maxCenter = Math.min(lo + half, focus + tolerance * half);
  if (minCenter > maxCenter + 1e-6) {
    // (epsilon: an exact tie is feasible, not empty.) The zoom limits forced a view that cannot honor the
    // tolerance. If it can still HOLD the bounds, hold them — centered as near the focus as that allows —
    // rather than clip far territories that a slightly different center would have shown. If it cannot
    // even hold them, favor the focus: the country itself matters more than its far territories.
    return half >= (hi - lo) / 2 ? Math.min(lo + half, Math.max(hi - half, focus)) : focus;
  }
  return Math.min(maxCenter, Math.max(minCenter, focus));
}

/**
 * Zoom transform that fits projected `bounds` inside `rect`, with breathing room.
 *
 * By default the middle of the bounds is centered. Pass `focus` to favor some other point — a
 * country's mainland, say — and still fit ALL the bounds. `focusTolerance` says how far from the
 * center the focus may sit, as a fraction of half the view: 0 centers it exactly (a symmetric
 * frame, which can be far larger than the bounds when the territories all lie on one side); 1 puts
 * no constraint on it. The frame used is the smallest one satisfying the tolerance.
 * @param {[[number, number], [number, number]]} bounds in local coordinates
 * @param {{x0: number, y0: number, x1: number, y1: number}} rect target area, view-box units
 * @param {{minScale: number, maxScale: number, padding: number, focus?: [number, number], focusTolerance?: number}} limits
 *   `padding` < 1 leaves a margin
 * @returns {{x: number, y: number, k: number}}
 */
export function fitTransform(bounds, rect, { minScale, maxScale, padding, focus, focusTolerance = 0 }) {
  const [[bx0, by0], [bx1, by1]] = bounds;
  const [fx, fy] = focus ?? [(bx0 + bx1) / 2, (by0 + by1) / 2];
  const availableWidth = Math.max(rect.x1 - rect.x0, 1) * padding;
  const availableHeight = Math.max(rect.y1 - rect.y0, 1) * padding;

  const neededHalfWidth = requiredHalfExtent(bx0, bx1, fx, focusTolerance);
  const neededHalfHeight = requiredHalfExtent(by0, by1, fy, focusTolerance);
  const k = clamp(Math.min(availableWidth / (2 * neededHalfWidth), availableHeight / (2 * neededHalfHeight)), minScale, maxScale);

  // The view may end up larger than strictly needed (k was capped, or the other axis limited it):
  // re-derive each axis' center from the half-extent it actually has, so slack is spent on
  // centering the focus rather than wasted.
  const centerX = viewCenter(bx0, bx1, fx, focusTolerance, availableWidth / (2 * k));
  const centerY = viewCenter(by0, by1, fy, focusTolerance, availableHeight / (2 * k));
  return {
    x: (rect.x0 + rect.x1) / 2 - centerX * k,
    y: (rect.y0 + rect.y1) / 2 - centerY * k,
    k,
  };
}

// How much beyond the minimum scale the user must be for "zoomed in" to mean something when the fit
// itself is clamped at that minimum.
const DELIBERATE_ZOOM_STEP = 1.05;
const KEEP_ZOOM_RATIO = 0.95;

/**
 * Whether clicking the country that is ALREADY selected should leave the camera where it is. It should
 * when the user has zoomed in on purpose (at least about as far as the fit — re-fitting would throw that
 * zoom away, which used to snap the view back out), and should not when they are zoomed out: then the
 * click zooms to the country, as selecting it from anywhere else does.
 *
 * Where the fit is clamped at the minimum scale (Antarctica; Russia or the USA on a phone) "as far as the
 * fit" is true even at the world view, so the scale has to be a notch beyond the minimum to count.
 * @param {{fromMapClick: boolean, wasSelected: boolean, currentScale: number, fitScale: number, minScale: number, keepRatio?: number}} state
 */
export function shouldKeepZoom({ fromMapClick, wasSelected, currentScale, fitScale, minScale, keepRatio = KEEP_ZOOM_RATIO }) {
  if (!fromMapClick || !wasSelected) return false;
  return currentScale >= Math.max(fitScale * keepRatio, minScale * DELIBERATE_ZOOM_STEP);
}

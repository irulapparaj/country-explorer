import {
  SPECIAL_LINES,
  graticuleStepForZoom,
  parallelsForStep,
  meridiansForStep,
  formatLatitude,
  formatLongitude,
  specialLineLabel,
  thinTicks,
} from './graticule.js';
import { localToScreen, visibleLocalRect } from './viewport.js';
import { createEl } from '../../lib/domUtils.js';

const LAT_MIN_GAP_PX = 18;
const LON_MIN_GAP_PX = 36;
const LEFT_STRIP_PX = 40; // longitude labels keep clear of the latitude strip
const BOTTOM_STRIP_PX = 22; // latitude labels keep clear of the longitude strip
const MAX_BOTTOM_LATITUDE = 89.5; // at exactly -90 every meridian collapses to a point

/**
 * Latitude labels down the left edge, longitude labels along the bottom edge, and named
 * chips for the equator/tropics/polar circles on the right — all in screen space, so
 * they stay legible and pinned to the frame while the map pans and zooms underneath.
 * Purely decorative: aria-hidden, pointer-events off, never focusable.
 * @param {{container: HTMLElement, projection: Function, getMapping: () => object, getTransform: () => object}} deps
 */
export function createFrameLabels({ container, projection, getMapping, getTransform }) {
  const frame = createEl('div', { className: 'map-frame', attrs: { 'aria-hidden': 'true' } });
  const latStrip = createEl('div', { className: 'frame-lat' });
  const lonStrip = createEl('div', { className: 'frame-lon' });
  const chips = createEl('div', { className: 'frame-lines' });
  frame.append(latStrip, lonStrip, chips);
  container.appendChild(frame);

  const centralMeridianX = projection([0, 0])[0];

  function parallelScreenY(lat, mapping, transform) {
    return localToScreen(projection([0, lat]), mapping, transform)[1];
  }

  function latitudeTicks(step, mapping, transform, height) {
    const ticks = parallelsForStep(step)
      .map((lat) => ({ lat, pos: parallelScreenY(lat, mapping, transform) }))
      .filter(({ pos }) => pos > 10 && pos < height - BOTTOM_STRIP_PX)
      .sort((a, b) => a.pos - b.pos); // screen y grows southward, latitude grows northward: thinning needs screen order
    return thinTicks(ticks, LAT_MIN_GAP_PX);
  }

  function longitudeTicks(step, mapping, transform, width, height) {
    const visible = visibleLocalRect(mapping, transform, width, height);
    const bottomY = Math.min(visible.y1, projection([0, -MAX_BOTTOM_LATITUDE])[1]);
    const bottomLat = projection.invert([centralMeridianX, bottomY])?.[1];
    if (!Number.isFinite(bottomLat)) return [];
    const ticks = meridiansForStep(step)
      .map((lng) => ({ lng, pos: localToScreen(projection([lng, bottomLat]), mapping, transform)[0] }))
      .filter(({ pos }) => pos > LEFT_STRIP_PX && pos < width - 12)
      .sort((a, b) => a.pos - b.pos);
    return thinTicks(ticks, LON_MIN_GAP_PX);
  }

  return {
    update({ showGrid }) {
      const { width, height } = container.getBoundingClientRect();
      if (!showGrid || !width || !height) {
        latStrip.replaceChildren();
        lonStrip.replaceChildren();
        chips.replaceChildren();
        return;
      }
      const mapping = getMapping();
      const transform = getTransform();
      const step = graticuleStepForZoom(transform.k);

      latStrip.replaceChildren(
        ...latitudeTicks(step, mapping, transform, height).map(({ lat, pos }) => {
          const el = createEl('span', { className: 'frame-lat-label', text: formatLatitude(lat) });
          el.style.top = `${pos}px`;
          return el;
        })
      );
      lonStrip.replaceChildren(
        ...longitudeTicks(step, mapping, transform, width, height).map(({ lng, pos }) => {
          const el = createEl('span', { className: 'frame-lon-label', text: formatLongitude(lng) });
          el.style.left = `${pos}px`;
          return el;
        })
      );
      chips.replaceChildren(
        ...SPECIAL_LINES.map((line) => ({ line, pos: parallelScreenY(line.lat, mapping, transform) }))
          .filter(({ pos }) => pos > 8 && pos < height - BOTTOM_STRIP_PX - 4)
          .map(({ line, pos }) => {
            const el = createEl('span', { className: `frame-line-chip frame-line-chip-${line.kind}`, text: specialLineLabel(line) });
            el.style.top = `${pos}px`;
            return el;
          })
      );
    },
  };
}

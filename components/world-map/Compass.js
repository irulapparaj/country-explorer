import { createEl } from '../../lib/domUtils.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text != null) el.textContent = text;
  return el;
}

/**
 * A small fixed compass rose: the map is always north-up, so this states the four
 * cardinal directions rather than reacting to anything. Purely informational.
 * @param {HTMLElement} container
 */
export function createCompass(container) {
  const wrap = createEl('div', { className: 'map-compass-wrap' });
  const svg = svgEl('svg', {
    class: 'map-compass',
    viewBox: '-32 -32 64 64',
    role: 'img',
    'aria-label': 'Compass: north is at the top of the map, east to the right',
  });
  svg.appendChild(svgEl('circle', { class: 'compass-ring', r: 22 }));
  svg.appendChild(svgEl('path', { class: 'compass-needle-south', d: 'M0 0 L-4 0 L0 15 L4 0 Z' }));
  svg.appendChild(svgEl('path', { class: 'compass-needle-north', d: 'M0 0 L-4 0 L0 -15 L4 0 Z' }));
  svg.appendChild(svgEl('circle', { class: 'compass-hub', r: 1.6 }));
  svg.appendChild(svgEl('text', { class: 'compass-dir compass-dir-north', x: 0, y: -25 }, 'N'));
  svg.appendChild(svgEl('text', { class: 'compass-dir', x: 26, y: 0 }, 'E'));
  svg.appendChild(svgEl('text', { class: 'compass-dir', x: 0, y: 29 }, 'S'));
  svg.appendChild(svgEl('text', { class: 'compass-dir', x: -26, y: 0 }, 'W'));
  wrap.appendChild(svg);
  container.appendChild(wrap);
  return svg;
}

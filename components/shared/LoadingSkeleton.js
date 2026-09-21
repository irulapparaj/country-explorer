import { createEl } from '../../lib/domUtils.js';

/** @param {number} [lines] @param {Array<number>} [widths] percentage widths per line */
export function createSkeleton(lines = 3, widths = [90, 75, 60]) {
  const wrap = createEl('div', { className: 'skeleton', attrs: { 'aria-hidden': 'true' } });
  for (let i = 0; i < lines; i++) {
    wrap.appendChild(
      createEl('div', { className: 'skeleton-line', attrs: { style: `width:${widths[i % widths.length]}%; margin-bottom: 10px` } })
    );
  }
  return wrap;
}

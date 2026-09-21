import { createHoverTracker } from './hoverTracker.js';
import { toSinglePolygonFeatures } from './mainLandmass.js';
import { createEl } from '../../lib/domUtils.js';

const HOVER_SCALE = 1.03;
const HOVER_FADE_MS = 160;

// The "pop-out" is an overlay: a copy of the hovered country is drawn on top, each piece
// scaled a little around its OWN center, and the map's real shapes are never moved,
// re-parented or transformed. That is what fixes both reported bugs: nothing can be left
// stranded in a raised/scaled state (state lives in one tracker, see hoverTracker.js), and
// no piece can be dragged away from its neighbor — the old code scaled the whole USA around
// the middle of a bounding box stretched across the map by the Aleutians, tearing Alaska
// free of Canada.

/**
 * Owns hover: the tracked "which country is hovered" value, the pop-out overlay, the
 * tooltip, and the pointer listeners that drive them.
 * @param {{d3: object, svg: object, container: HTMLElement, countriesLayer: object, hoverLayer: object,
 *   projection: Function, pathGenerator: Function, getMapMode: () => string}} deps
 * @returns {{end: () => void}} `end()` drops any hover — call it whenever the map moves or restyles
 */
export function createHoverController({ d3, svg, container, countriesLayer, hoverLayer, projection, pathGenerator, getMapMode }) {
  const hover = createHoverTracker();
  const tooltip = createEl('div', { className: 'map-tooltip', attrs: { role: 'status', 'aria-hidden': 'true' } });
  container.appendChild(tooltip);
  let activateFrame = 0; // the pending "start the pop-out transition" frame

  function polygonOrigin(polygon) {
    const projected = projection(d3.geoCentroid(polygon));
    if (projected && Number.isFinite(projected[0]) && Number.isFinite(projected[1])) return projected;
    const [[x0, y0], [x1, y1]] = pathGenerator.bounds(polygon);
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  }

  function drawPopOut(pathEl, country) {
    const fill = getMapMode() === 'elevation' ? 'rgb(255 255 255 / 0.3)' : getComputedStyle(pathEl).fill;
    const group = hoverLayer.append('g').attr('class', 'hover-pop').attr('data-iso3', country.iso3 || '').attr('data-key', country.hoverKey);
    for (const shape of country.parts) {
      for (const polygon of toSinglePolygonFeatures(shape.feature)) {
        const pathData = pathGenerator(polygon);
        if (!pathData) continue;
        const [cx, cy] = polygonOrigin(polygon);
        group
          .append('path')
          .attr('class', 'hover-part')
          .attr('d', pathData)
          .style('fill', fill)
          .style('transform-origin', `${cx}px ${cy}px`)
          .style('--hover-scale', HOVER_SCALE);
      }
    }
    // Next frame, so the CSS transition has a start state. The frame is remembered so end()
    // can cancel it: otherwise a hover that ends within the same frame would be re-activated
    // afterwards and left on screen.
    cancelAnimationFrame(activateFrame);
    activateFrame = requestAnimationFrame(() => group.classed('active', true));
  }

  function showTooltip(country, event) {
    // A shape with no country behind it (Kosovo, Northern Cyprus, Somaliland in this topology) has no name to
    // show. Such shapes are pointer-events:none (see world-map.css) so this is not reachable today; if that ever
    // changed, hide the tooltip rather than leave the PREVIOUS country's name on screen, following the pointer.
    if (!country.iso3) {
      hideTooltip();
      return;
    }
    tooltip.textContent = country.name;
    tooltip.setAttribute('aria-hidden', 'false');
    tooltip.classList.add('visible');
    positionTooltip(event);
  }

  function positionTooltip(event) {
    const rect = container.getBoundingClientRect();
    tooltip.style.left = `${event.clientX - rect.left + 14}px`;
    tooltip.style.top = `${event.clientY - rect.top + 14}px`;
  }

  // Hiding is immediate (no fade — see .map-tooltip in world-map.css) and empties the text, so a
  // name can never linger on screen or be re-announced after the pointer has left its country.
  function hideTooltip() {
    tooltip.classList.remove('visible');
    tooltip.setAttribute('aria-hidden', 'true');
    tooltip.textContent = '';
  }

  function begin(pathEl, event) {
    const country = d3.select(pathEl).datum();
    const { changed } = hover.enter(country.hoverKey);
    if (changed) {
      countriesLayer.selectAll('.hovered').classed('hovered', false);
      hoverLayer.selectAll('g.hover-pop').remove();
      pathEl.classList.add('hovered');
      drawPopOut(pathEl, country);
    }
    showTooltip(country, event);
  }

  function end() {
    hover.clear();
    cancelAnimationFrame(activateFrame);
    activateFrame = 0;
    countriesLayer.selectAll('.hovered').classed('hovered', false); // always: cheap, and self-heals any stale class
    const groups = hoverLayer.selectAll('g.hover-pop');
    if (!groups.empty()) {
      const nodes = groups.nodes();
      groups.classed('active', false); // reverse the pop-out, then drop exactly these copies
      setTimeout(() => nodes.forEach((node) => node.remove()), HOVER_FADE_MS + 40);
    }
    hideTooltip();
  }

  // Hover follows the pointer: every move re-checks which country is under it. (Relying on
  // pointerover alone misses one case: after a zoom clears the highlight, the pointer is
  // still inside the same shape, so no "enter" ever fires again.)
  const countryUnder = (event) => (event.target instanceof Element ? event.target.closest('path.country-path') : null);
  function update(event) {
    if (event.pointerType === 'touch' || event.buttons) return; // touch taps select; a drag is a pan, not a hover
    const pathEl = countryUnder(event);
    if (!pathEl) {
      if (hover.current) end();
      return;
    }
    const country = d3.select(pathEl).datum();
    if (country.hoverKey !== hover.current) begin(pathEl, event);
    else positionTooltip(event);
  }

  svg.on('pointerover', update).on('pointermove', update).on('pointerleave', end).on('pointercancel', end);
  window.addEventListener('blur', end);
  document.addEventListener('visibilitychange', end);
  // Safety net: whatever the svg does or does not see, a pointer that is anywhere but over a country
  // means nothing may be hovered. (Covers overlays, labels, and any element that swallows the
  // svg's own pointer events.)
  document.addEventListener(
    'pointermove',
    (event) => {
      if (hover.current && !countryUnder(event)) end();
    },
    { passive: true }
  );

  return { end };
}

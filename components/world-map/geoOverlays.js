import { SPECIAL_LINES, POLAR_CIRCLE_LATITUDE, graticuleStepForZoom } from './graticule.js';
import { waterLabelsForZoom, labelLines } from './oceanLabels.js';
import { CONTINENT_LABELS } from './continents.js';
import { placeLabels } from './labelPlacement.js';

const PARALLEL_SAMPLE_STEP_DEG = 2; // a parallel is straight in Natural Earth, but sampling keeps it exact on any projection
// Rendered width of one character, in view-box units (the space SVG text is sized in),
// for each label style — an estimate, so no per-label layout measurement per zoom tick.
const CHAR_WIDTH = { ocean: 8.2, sea: 6.2 };
const LINE_HEIGHT = 12;

function parallelCoordinates(lat) {
  const coordinates = [];
  for (let lng = -180; lng <= 180; lng += PARALLEL_SAMPLE_STEP_DEG) coordinates.push([lng, lat]);
  return coordinates;
}

/**
 * Everything geographic drawn *inside* the zoom layer, under or over the countries: polar
 * caps, the graticule, the equator/tropics/polar circles, and the ocean, sea and continent
 * names. Text is counter-scaled by 1/k so it stays a constant size while the map zooms
 * (like country labels). Nothing here is interactive.
 * @param {{d3: object, projection: Function, pathGenerator: Function,
 *   layers: {polarCaps: object, graticule: object, specialLines: object, waterLabels: object, continentLabels: object},
 *   getVisibleViewBox: () => {x0: number, y0: number, x1: number, y1: number}}} deps
 *   `getVisibleViewBox` is the part of the view box actually on screen and clear of the
 *   coordinate strips, in view-box units.
 */
export function createGeoOverlays({ d3, projection, pathGenerator, layers, getVisibleViewBox }) {
  // Polar caps: the regions poleward of each polar circle, tinted so the polar regions read
  // as regions rather than as empty edges of the map.
  const capExtents = {
    arctic: [[-180, POLAR_CIRCLE_LATITUDE], [180, 90]],
    antarctic: [[-180, -90], [180, -POLAR_CIRCLE_LATITUDE]],
  };
  layers.polarCaps
    .selectAll('path.polar-cap')
    .data(Object.entries(capExtents))
    .join('path')
    .attr('class', 'polar-cap')
    .attr('data-cap', ([name]) => name)
    .attr('d', ([, extent]) => pathGenerator(d3.geoGraticule().extent(extent).outline()));

  const graticuleFor = (step) => pathGenerator(d3.geoGraticule().step([step, step])());

  function counterScaled(selection, transform) {
    return selection.attr('transform', (d) => `translate(${d.local[0]},${d.local[1]}) scale(${1 / transform.k})`);
  }

  // Keeps only labels that are near the frame and don't overlap a higher-priority one
  // (input order = priority). A label that is only partly on screen — the Pacific sits
  // across the map's edge — is nudged inward so its whole name stays readable. Works in
  // view-box units, the same space SVG text is sized in.
  function placeAnchored(labels, transform) {
    const view = getVisibleViewBox();
    const candidates = [];
    for (const label of labels) {
      const lines = labelLines(label);
      const width = Math.max(...lines.map((line) => line.length)) * CHAR_WIDTH[label.kind] + 8;
      const height = lines.length * LINE_HEIGHT;
      const [lx, ly] = projection([label.lng, label.lat]);
      let x = transform.x + transform.k * lx;
      let y = transform.y + transform.k * ly;
      const partlyVisible = x + width / 2 > view.x0 && x - width / 2 < view.x1 && y + height / 2 > view.y0 && y - height / 2 < view.y1;
      if (!partlyVisible) continue;
      if (view.x1 - view.x0 > width) x = Math.min(view.x1 - width / 2, Math.max(view.x0 + width / 2, x));
      if (view.y1 - view.y0 > height) y = Math.min(view.y1 - height / 2, Math.max(view.y0 + height / 2, y));
      candidates.push({ id: label.id ?? label.name, label, anchor: [x, y], local: [(x - transform.x) / transform.k, (y - transform.y) / transform.k], width, height });
    }
    return placeLabels(candidates).map(({ label, local }) => ({ ...label, lines: labelLines(label), local }));
  }

  function renderWaterLabels(options, transform) {
    const visible = options.showWaterNames ? placeAnchored(waterLabelsForZoom(transform.k), transform) : [];
    const texts = layers.waterLabels
      .selectAll('text.water-label')
      .data(visible, (d) => d.id)
      .join('text')
      .attr('class', (d) => `water-label water-label-${d.kind}`);
    counterScaled(texts, transform).each(function renderLines(d) {
      // Only rebuild the line spans when the text itself changed (it never does for a label id).
      if (this.childElementCount === d.lines.length) return;
      const text = d3.select(this);
      text.selectAll('*').remove();
      d.lines.forEach((line, i) => {
        // A trailing space on all but the last line keeps the element's textContent readable
        // ("Indian Ocean", not "IndianOcean") for assistive tech and text search.
        text
          .append('tspan')
          .attr('x', 0)
          .attr('dy', d.lines.length === 1 ? '0' : i === 0 ? '-0.55em' : '1.15em')
          .text(i < d.lines.length - 1 ? `${line} ` : line);
      });
    });
  }

  function renderContinentLabels(options, transform) {
    const visible = options.labelMode === 'continents' ? CONTINENT_LABELS.map((label) => ({ ...label, local: projection([label.lng, label.lat]) })) : [];
    counterScaled(
      layers.continentLabels
        .selectAll('text.continent-label')
        .data(visible, (d) => d.name)
        .join('text')
        .attr('class', 'continent-label')
        .text((d) => d.name),
      transform
    );
  }

  // The path data is built only when a line ENTERS (the grid step changed, or the grid was
  // switched on) — never re-written on the update pass: at 5 degrees the graticule is ~100 KB
  // of path text and this runs on every zoom frame.
  function renderGrid(options, transform) {
    const step = graticuleStepForZoom(transform.k);
    layers.graticule
      .selectAll('path.graticule-line')
      .data(options.showGrid ? [step] : [], (d) => d)
      .join((enter) => enter.append('path').attr('class', 'graticule-line').attr('d', graticuleFor));

    layers.specialLines
      .selectAll('path.special-line')
      .data(options.showGrid ? SPECIAL_LINES : [], (d) => d.id)
      .join((enter) =>
        enter
          .append('path')
          .attr('class', 'special-line')
          .attr('data-line', (d) => d.id)
          .attr('data-kind', (d) => d.kind)
          .attr('d', (d) => pathGenerator({ type: 'LineString', coordinates: parallelCoordinates(d.lat) }))
      );
  }

  return {
    /** Redraws whatever depends on the zoom level or the options. Cheap: ~30 elements. */
    update(options, transform) {
      renderGrid(options, transform);
      renderWaterLabels(options, transform);
      renderContinentLabels(options, transform);
    },
  };
}

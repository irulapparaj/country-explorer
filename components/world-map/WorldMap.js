import { colorCountries } from './countryColoring.js';
import { getMainLandmass, getDisplayBounds, projectedRingBounds } from './mainLandmass.js';
import { placeLabels, visibleAtZoom } from './labelPlacement.js';
import { createHoverController } from './hoverController.js';
import { groupShapesByCountry } from './countryGroups.js';
import { viewBoxMapping, localToScreen, availableViewRect, fitTransform, shouldKeepZoom } from './viewport.js';
import { DEFAULT_OPTIONS, normalizeOptions } from './mapModes.js';
import { CONTINENT_LABELS, continentSlug } from './continents.js';
import { legendForMode } from './legendSpecs.js';
import { createGeoOverlays } from './geoOverlays.js';
import { createFrameLabels } from './frameLabels.js';
import { createElevationLayer } from './elevationLayer.js';
import { createMapLegend } from './MapLegend.js';
import { createMapControls } from './MapControls.js';
import { createCompass } from './Compass.js';
import { createErrorRetry } from '../shared/ErrorRetry.js';
import { loadSearchIndex, getEntryByIsoNumeric } from '../../lib/searchIndex.js';
import { prefersReducedMotion, createEl } from '../../lib/domUtils.js';
import { fetchJson } from '../../lib/http.js';

const TOPOLOGY_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json';
// The topology is ~245 KB over the wire. A CDN response can stall part-way (headers arrive, the body never
// does — seen in Firefox), so an attempt is abandoned after 12 s and tried again, twice, rather than left
// hanging on a blank map.
const TOPOLOGY_TIMEOUT_MS = 12_000;
const TOPOLOGY_RETRIES = 2;
const CONTINENTS_URL = 'data/continents.json';
const ANTARCTICA_ISO3 = 'ATA';
const MIN_SCALE = 1;
const MAX_SCALE = 12;
const FIT_PADDING = 0.75; // leaves a margin around a country zoomed to fit
// Empty ocean above the north pole, in view-box units (~60px on a laptop). Without it the Arctic
// — Greenland, Canada's islands, Svalbard, Russia's north coast — touches the top of the page,
// and any zoomed view of a northern country is pinned against it.
const TOP_MARGIN = 34;
// A country gets its camera centered on its mainland (still fitting every territory) only when
// the largest polygon is at least this share of its area; an archipelago has no real mainland.
const DOMINANT_MAINLAND_SHARE = 0.6;
// ...and it may sit up to this fraction of half the view away from the exact center. Exact centering
// would force a frame as large as twice the distance to the farthest territory, which for France
// (Guiana and Réunion far south of it) is bigger than the world; a little slack keeps the zoom useful
// while the mainland still reads as centered. Measured on the real geometry (1440x900, 340px panel):
// 0.15 leaves Portugal's mainland ~11% of the half-width off center (it was 65% off when the view was
// centered on the whole spread) and still shows the Azores and Madeira.
const FOCUS_TOLERANCE = 0.15;
const CLICK_DRAG_THRESHOLD_PX = 5;
const VIEWBOX_WIDTH = 960;
const VIEWBOX_HEIGHT = 500;
const MOBILE_QUERY = '(max-width: 768px)';
const FRAME_LEFT_PX = 40; // keep in step with --frame-left / --frame-bottom in variables.css
const FRAME_BOTTOM_PX = 22;

// Minimum on-screen size (px, at MAX_SCALE) for a shape to be worth zooming to directly
// rather than falling back to the off-map marker. Calibrated against the real topology,
// not guessed: at MAX_SCALE, Vatican City is ~0.3px, Monaco ~1.8px, and San Marino ~3.5px
// (all effectively invisible/unusable) while Luxembourg — the smallest country this should
// NOT treat as "too small" — is ~22-26px. 15px sits cleanly between those two groups.
const MIN_VISIBLE_PX_AT_MAX_SCALE = 15;

// Deliberately no per-tile progress count: the key's status line is a live region, and 16
// "loading 3/16" updates would be 16 spoken announcements.
const boundsCenter = ([[x0, y0], [x1, y1]]) => [(x0 + x1) / 2, (y0 + y1) / 2];

function elevationStatusText({ state }) {
  if (state === 'loading') return 'Loading elevation data…';
  if (state === 'unavailable') return 'Elevation data unavailable. Check your connection, then choose the style again to retry.';
  return '';
}

/**
 * Mounts the D3/SVG world map into `container`. Real country boundaries (world-atlas
 * countries-50m TopoJSON), Natural Earth projection, three map styles (political,
 * geographic regions, elevation), neighbor-safe coloring, zoom/pan, hover pop-out,
 * click-to-select, label placement that reveals more detail as the user zooms in, and the
 * reference overlays: graticule, equator/tropics/polar circles, ocean names and compass.
 * @param {HTMLElement} container
 * @param {{onSelect?: (iso3: string) => void}} [handlers]
 */
export function createWorldMap(container, { onSelect } = {}) {
  const d3 = window.d3;
  const topojson = window.topojson;

  const model = { countries: [], byIso3: new Map(), continentsAvailable: true };
  let options = DEFAULT_OPTIONS;
  let projection;
  let pathGenerator;
  let zoomBehavior;
  let currentTransform = { x: 0, y: 0, k: 1 };
  let selectedIso3 = null;
  let offMapMarker = null;
  let ready = false;
  let overlays;
  let frameLabels;
  let elevation;
  let legend;
  let controls;
  let elevationStatus = { state: 'loading' };
  let overlayFrame = 0;
  let hoverController;
  let appliedMapMode = null;
  let pendingCamera = null; // a select/restore requested before the map finished loading

  const svg = d3
    .select(container)
    .append('svg')
    .attr('class', 'world-map-svg')
    .attr('data-map-mode', options.mapMode)
    .attr('viewBox', `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`)
    // Default "meet" letterboxes on any container whose aspect ratio doesn't match the
    // world map's ~1.92:1 — confirmed live on a narrow/tall phone viewport, where it
    // left the map as a small horizontal strip with large empty bars above and below.
    // "slice" fills the container instead, cropping the sides on a tall viewport —
    // reasonable since the map is pannable, so cropped content is still one drag away.
    // (viewport.js models exactly this crop, so overlays line up with it.)
    .attr('preserveAspectRatio', 'xMidYMid slice')
    // role="img" was tried first and confirmed live to be an actual accessibility bug,
    // not just an unwanted default: it makes browsers treat the whole SVG as one
    // atomic leaf image and prune all descendants from the focus/accessibility tree —
    // it silently broke every country path's tabindex, not merely left it "img"-styled.
    // "group" describes a labeled container without that pruning. Country shapes are
    // deliberately not part of the tab order at all (240 individual Tab stops to reach
    // e.g. Australia is a well-known anti-pattern for choropleth maps) — the search box
    // is the documented full-keyboard path to any country, drawn or not, and the label
    // says so explicitly.
    .attr('role', 'group')
    .attr('aria-label', 'Interactive world map. Use the search box above to find and select a country by keyboard.');

  svg.append('rect').attr('class', 'ocean').attr('width', VIEWBOX_WIDTH).attr('height', VIEWBOX_HEIGHT);

  // Layer order, bottom to top. Everything above the countries is non-interactive
  // (pointer-events: none in CSS) so a country under a grid line is still clickable.
  const zoomLayer = svg.append('g').attr('class', 'zoom-layer');
  const layer = (name) => zoomLayer.append('g').attr('class', name);
  const polarCapsLayer = layer('polar-caps-layer');
  const graticuleLayer = layer('graticule-layer');
  const countriesLayer = layer('countries-layer');
  const continentBordersLayer = layer('continent-borders-layer');
  const specialLinesLayer = layer('special-lines-layer');
  const selectionLayer = layer('selection-layer');
  const hoverLayer = layer('hover-layer');
  const markersLayer = layer('markers-layer');
  const waterLabelsLayer = layer('water-labels-layer');
  const continentLabelsLayer = layer('continent-labels-layer');
  const labelsLayer = layer('labels-layer');

  function buildHud() {
    const hud = createEl('div', { className: 'map-hud' });
    const zoomIn = createEl('button', { className: 'map-hud-btn', attrs: { type: 'button', 'aria-label': 'Zoom in' }, text: '+' });
    const zoomOut = createEl('button', { className: 'map-hud-btn', attrs: { type: 'button', 'aria-label': 'Zoom out' }, text: '−' });
    const resetBtn = createEl('button', { className: 'map-hud-btn map-hud-reset', attrs: { type: 'button', 'aria-label': 'Reset view' }, text: '⤡' });
    zoomIn.addEventListener('click', () => zoomBy(1.6));
    zoomOut.addEventListener('click', () => zoomBy(1 / 1.6));
    resetBtn.addEventListener('click', () => reset());
    hud.append(zoomIn, zoomOut, resetBtn);
    container.appendChild(hud);
  }

  // ---- frame geometry -------------------------------------------------------------------

  function containerSize() {
    const { width, height } = container.getBoundingClientRect();
    return width && height ? { width, height } : { width: VIEWBOX_WIDTH, height: VIEWBOX_HEIGHT };
  }

  function getMapping() {
    const { width, height } = containerSize();
    return viewBoxMapping(width, height, VIEWBOX_WIDTH, VIEWBOX_HEIGHT);
  }

  // How much of the map the side panel covers, in CSS px. Measured from the panel's own
  // size rather than its on-screen position, so it is right even before the panel has
  // slid in: the panel only opens AFTER a selection, and the old "is it open right now?"
  // check meant the first selection was centered on the whole map and then covered.
  function panelInsets() {
    const panel = document.querySelector('#side-panel-mount .side-panel');
    if (!panel) return { right: 0, bottom: 0 };
    return window.matchMedia(MOBILE_QUERY).matches ? { right: 0, bottom: panel.offsetHeight } : { right: panel.offsetWidth, bottom: 0 };
  }

  // The part of the view box that is on screen and clear of the coordinate strips, in
  // view-box units (the coordinate space SVG text is laid out in).
  function getVisibleViewBox() {
    const { width, height } = containerSize();
    const { scale, offsetX, offsetY } = getMapping();
    const px = (screenPx, offset) => (screenPx - offset) / scale;
    return {
      x0: px(FRAME_LEFT_PX + 6, offsetX),
      x1: px(width - 8, offsetX),
      y0: px(8, offsetY),
      y1: px(height - FRAME_BOTTOM_PX - 4, offsetY),
    };
  }

  function availableRect() {
    const { width, height } = containerSize();
    return availableViewRect(getMapping(), width, height, panelInsets());
  }

  // ---- data + rendering -------------------------------------------------------------------

  async function init() {
    // With a timeout and a retry: a stalled CDN used to leave a blank map that never reached the Retry UI.
    const [topology, continents] = await Promise.all([
      fetchJson(TOPOLOGY_URL, { timeoutMs: TOPOLOGY_TIMEOUT_MS, retries: TOPOLOGY_RETRIES }),
      fetchJson(CONTINENTS_URL, { timeoutMs: 8000, retries: 1 }).catch(() => null),
      loadSearchIndex(),
    ]);
    model.continentsAvailable = continents !== null;

    const featureCollection = topojson.feature(topology, topology.objects.countries);
    const geometries = topology.objects.countries.geometries;
    const features = featureCollection.features;

    const neighborLists = topojson.neighbors(geometries);
    const colorIndices = colorCountries(neighborLists);

    // Fit the whole sphere, not just the drawn land, so both polar regions are fully in frame:
    // the south pole sits on the bottom edge and the north pole TOP_MARGIN units below the top.
    projection = d3.geoNaturalEarth1().fitExtent([[0, TOP_MARGIN], [VIEWBOX_WIDTH, VIEWBOX_HEIGHT]], { type: 'Sphere' });
    pathGenerator = d3.geoPath(projection);
    const project = (lngLat) => projection(lngLat);

    const entries = await Promise.all(features.map((f) => getEntryByIsoNumeric(f.id)));
    const continentOf = (iso3) => (iso3 && continents?.[iso3]) || null;
    const antarcticaAnchor = CONTINENT_LABELS.find((l) => l.name === 'Antarctica');

    model.countries = features.map((feature, i) => {
      const entry = entries[i];
      const iso3 = entry?.iso3 || null;
      const mainLandmass = getMainLandmass(feature, { geoArea: d3.geoArea, geoBounds: d3.geoBounds, geoCentroid: d3.geoCentroid });
      const labelBounds = mainLandmass
        ? projectedRingBounds(mainLandmass.feature, project, { anchorX: project(mainLandmass.centroid)?.[0], maxSeparationX: VIEWBOX_WIDTH / 2 })
        : null;
      const display = getDisplayBounds(feature, { geoArea: d3.geoArea, geoCentroid: d3.geoCentroid, project, maxSeparationX: VIEWBOX_WIDTH / 2 });
      return {
        feature,
        iso3,
        key: String(i), // unique per drawn shape (two shapes can share an ISO code)
        hoverKey: iso3 || String(i), // shapes of one country hover as one
        name: entry?.names?.common || feature.properties?.name || 'Unknown',
        continent: continentOf(iso3),
        colorIndex: colorIndices[i],
        geometry: geometries[i],
        mainLandmass,
        labelBounds,
        // Everything a user should see when this country is selected: mainland AND the
        // significant overseas pieces (French Guiana, Alaska, Hawaii...), minus specks
        // and pieces wrapped across the antimeridian (see getDisplayBounds).
        zoomBounds: display?.bounds ?? labelBounds,
        // Where the camera centers when this country is selected: on its mainland if it has a
        // dominant one (so Portugal is centered on Portugal, not on a point between it and the
        // Azores), else on the middle of everything (null).
        focus: labelBounds && display && display.mainShare >= DOMINANT_MAINLAND_SHARE ? boundsCenter(labelBounds) : null,
        // A polygon that encloses the pole has no meaningful centroid; name Antarctica
        // where the continent label goes.
        labelAnchor: iso3 === ANTARCTICA_ISO3 ? [antarcticaAnchor.lng, antarcticaAnchor.lat] : mainLandmass?.centroid,
        area: mainLandmass ? d3.geoArea(mainLandmass.feature) : 0,
      };
    });
    // Two drawn shapes can share one ISO code (Ashmore and Cartier Islands carry Australia's).
    // The largest shape IS the country — it is what selection zooms to and what gets a label —
    // and the rest are its `parts`, highlighted and popped out together with it. (Keeping the
    // last shape, as this used to, sent Australia's zoom to a 3 km2 speck in the Timor Sea.)
    const { primaryByIso3, partsByIso3 } = groupShapesByCountry(model.countries);
    model.countries.forEach((c) => {
      c.isPrimary = !c.iso3 || primaryByIso3.get(c.iso3) === c;
      c.parts = c.iso3 ? partsByIso3.get(c.iso3) : [c];
      if (c.isPrimary && c.iso3) model.byIso3.set(c.iso3, c);
    });
    model.countries.sort((a, b) => b.area - a.area).forEach((c, rank) => { c.rank = rank; });

    renderCountries();
    renderContinentBorders(topology, geometries);
    overlays = createGeoOverlays({
      d3,
      projection,
      pathGenerator,
      layers: { polarCaps: polarCapsLayer, graticule: graticuleLayer, specialLines: specialLinesLayer, waterLabels: waterLabelsLayer, continentLabels: continentLabelsLayer },
      getVisibleViewBox,
    });
    frameLabels = createFrameLabels({ container, projection, getMapping, getTransform: () => currentTransform });
    elevation = createElevationLayer({
      container,
      projection,
      drawLand: (ctx) => {
        const canvasPath = d3.geoPath(projection, ctx);
        model.countries.forEach((c) => canvasPath(c.feature));
      },
      getMapping,
      getTransform: () => currentTransform,
      onStatus: (status) => {
        elevationStatus = status;
        if (options.mapMode === 'elevation') legend.setStatus(elevationStatusText(status));
      },
    });
    legend = createMapLegend(container);
    createCompass(container);
    setupZoom();
    setupPointerHandling();
    buildHud();
    controls = createMapControls(container, { options, onChange: setOptions });
    // A resized window, a rotated phone or a collapsing mobile URL bar changes the container
    // without any zoom event, so the terrain canvas (sized to the container) must be redrawn
    // here too or it stays stretched and out of register with the vector layers.
    new ResizeObserver(() => {
      refreshOverlays();
      elevation.refresh();
    }).observe(container);

    ready = true;
    applyOptions();
    const replay = pendingCamera;
    pendingCamera = null;
    replay?.();
  }

  function renderCountries() {
    countriesLayer
      .selectAll('path.country-path')
      .data(model.countries, (d) => d.key)
      .join('path')
      .attr('class', 'country-path')
      .attr('data-iso3', (d) => d.iso3 || '')
      .attr('data-key', (d) => d.key)
      .attr('data-color', (d) => d.colorIndex % 7)
      .attr('data-continent', (d) => (d.continent ? continentSlug(d.continent) : ''))
      .attr('d', (d) => pathGenerator(d.feature))
      // Deliberately not a tab stop (no tabindex/role="button"): 240 individual Tab
      // stops to reach, say, Australia is a well-known anti-pattern, and the search
      // box already gives full keyboard access to every country. aria-label is kept
      // since it costs nothing and some assistive tech still surfaces it on touch
      // exploration even without a focusable role.
      .attr('aria-label', (d) => d.name);
  }

  // The borders that separate one continent from another, plus every coastline — drawn
  // heavier than the (faint) borders between countries of the same continent when the
  // map is in geographic-regions mode, so each continent reads as one block.
  function renderContinentBorders(topology, geometries) {
    const continentByGeometry = new Map(model.countries.map((c) => [c.geometry, c.continent]));
    const mesh = topojson.mesh(topology, { type: 'GeometryCollection', geometries }, (a, b) => a === b || continentByGeometry.get(a) !== continentByGeometry.get(b));
    continentBordersLayer.append('path').attr('class', 'continent-borders').attr('d', pathGenerator(mesh));
  }

  // ---- zoom / pointer ---------------------------------------------------------------------

  function setupZoom() {
    zoomBehavior = d3
      .zoom()
      .scaleExtent([MIN_SCALE, MAX_SCALE])
      .translateExtent([[0, 0], [VIEWBOX_WIDTH, VIEWBOX_HEIGHT]])
      .on('zoom', (event) => {
        currentTransform = event.transform;
        zoomLayer.attr('transform', currentTransform);
        hoverController?.end(); // whatever is under a stationary pointer changes as the map moves
        refreshOverlays();
        elevation.refresh();
      });
    svg.call(zoomBehavior).on('dblclick.zoom', null); // avoid double-click zoom fighting with click-to-select
  }

  function setupPointerHandling() {
    hoverController = createHoverController({
      d3,
      svg,
      container,
      countriesLayer,
      hoverLayer,
      projection,
      pathGenerator,
      getMapMode: () => options.mapMode,
    });

    let downPoint = null;
    svg.on('pointerdown', (event) => {
      downPoint = [event.clientX, event.clientY];
    });
    svg.on('pointerup', (event) => {
      if (!downPoint) return;
      const dist = Math.hypot(event.clientX - downPoint[0], event.clientY - downPoint[1]);
      downPoint = null;
      if (dist > CLICK_DRAG_THRESHOLD_PX) return; // was a drag/pan, not a click
      const target = event.target instanceof Element ? event.target.closest('path.country-path') : null;
      const iso3 = target?.getAttribute('data-iso3');
      if (iso3) selectCountry(iso3, { fromMapClick: true });
    });
  }

  // ---- labels + overlays ------------------------------------------------------------------

  function toViewBoxSpace([localX, localY]) {
    return [currentTransform.x + localX * currentTransform.k, currentTransform.y + localY * currentTransform.k];
  }

  function renderLabels() {
    if (!model.countries.length) return;
    const wantsCountryNames = options.labelMode !== 'continents';
    const candidates = wantsCountryNames
      ? model.countries
          .filter((c) => c.iso3 && c.isPrimary && c.mainLandmass && visibleAtZoom(c.rank, currentTransform.k, options.labelMode))
          .map((c) => {
            const [p0, p1] = c.labelBounds.map(toViewBoxSpace);
            return {
              id: c.iso3,
              name: c.name,
              anchor: toViewBoxSpace(projection(c.labelAnchor)),
              width: estimateTextWidth(c.name),
              height: 9,
              // "Major" names a country only where the name fits inside it. "All" is allowed to
              // spill past a small country's outline (there is no other way to name Belgium at
              // world zoom) — it still never lets two names overlap, biggest country first.
              countryScreenBounds:
                options.labelMode === 'all'
                  ? null
                  : [
                      [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1])],
                      [Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])],
                    ],
            };
          })
      : [];

    const placed = placeLabels(candidates);
    labelsLayer
      .selectAll('g.map-label')
      .data(placed, (d) => d.id)
      .join((enter) => {
        const g = enter.append('g').attr('class', 'map-label');
        g.append('text');
        return g;
      })
      .attr('transform', (d) => {
        const localX = (d.anchor[0] - currentTransform.x) / currentTransform.k;
        const localY = (d.anchor[1] - currentTransform.y) / currentTransform.k;
        return `translate(${localX},${localY}) scale(${1 / currentTransform.k})`;
      })
      .select('text')
      .text((d) => d.name);
  }

  function estimateTextWidth(text) {
    return text.length * 5.4 + 6; // avoids a synchronous layout/measure per candidate per zoom tick
  }

  // Overlays (labels, grid, frame text) are redrawn at most once per animation frame, so a
  // burst of zoom events during a pinch or animated fly-to costs one redraw, not dozens.
  function refreshOverlays() {
    if (overlayFrame || !ready) return;
    overlayFrame = requestAnimationFrame(() => {
      overlayFrame = 0;
      redrawOverlays();
    });
  }

  function redrawOverlays() {
    renderLabels();
    overlays.update(options, currentTransform);
    frameLabels.update(options);
  }

  // ---- map options ------------------------------------------------------------------------

  function refreshLegend() {
    const spec = legendForMode(options.mapMode);
    if (!spec) {
      legend.hide();
      return;
    }
    legend.show(spec);
    if (options.mapMode === 'elevation') legend.setStatus(elevationStatusText(elevationStatus));
    else if (!model.continentsAvailable) legend.setStatus('Continent data unavailable, so regions are not colored.');
  }

  function applyOptions() {
    svg.attr('data-map-mode', options.mapMode);
    container.setAttribute('data-map-mode', options.mapMode);
    hoverController.end();
    // Toggling grid or names must not cost a full elevation redraw (or rebuild the key).
    if (appliedMapMode !== options.mapMode) {
      appliedMapMode = options.mapMode;
      elevation.setActive(options.mapMode === 'elevation');
      refreshLegend();
    }
    controls.sync(options);
    redrawOverlays();
  }

  function setOptions(patch) {
    options = normalizeOptions(patch, options);
    if (ready) applyOptions();
    return options;
  }

  // ---- selection + camera -----------------------------------------------------------------

  function fitTransformToBounds(bounds, focus = null) {
    const t = fitTransform(bounds, availableRect(), { minScale: MIN_SCALE, maxScale: MAX_SCALE, padding: FIT_PADDING, focus: focus ?? undefined, focusTolerance: FOCUS_TOLERANCE });
    return d3.zoomIdentity.translate(t.x, t.y).scale(t.k);
  }

  // d3-zoom only enforces its pan limits on user gestures, not on transforms set from code —
  // so fitting a country near the map's edge (or selecting Antarctica, whose bounds span the
  // whole width) could scroll the view out past the map into empty background. Constrain
  // against the part of the screen the user can actually see (on screen, not under the
  // side panel), which also keeps Pacific islands near the right edge out from under it.
  function constrainToMap(transform) {
    const { x0, y0, x1, y1 } = availableRect();
    return zoomBehavior.constrain()(transform, [[x0, y0], [x1, y1]], [[0, 0], [VIEWBOX_WIDTH, VIEWBOX_HEIGHT]]);
  }

  function applyTransform(transform, animate) {
    const target = constrainToMap(transform);
    const duration = animate && !prefersReducedMotion() ? 400 : 0;
    if (duration === 0) {
      svg.call(zoomBehavior.transform, target);
    } else {
      svg.transition().duration(duration).call(zoomBehavior.transform, target);
    }
  }

  function clearSelectionVisuals() {
    countriesLayer.selectAll('path.country-path').classed('selected', false);
    selectionLayer.selectAll('*').remove();
    if (offMapMarker) {
      offMapMarker.remove();
      offMapMarker = null;
    }
  }

  // The red fill is a class on the country's own shape; the crisp outline is a separate
  // copy in a layer above every country, so no neighbor's border ever half-covers it.
  function markSelected(iso3) {
    const country = model.byIso3.get(iso3);
    if (!country) return;
    countriesLayer.selectAll(`path[data-iso3="${iso3}"]`).classed('selected', true);
    for (const part of country.parts) {
      selectionLayer.append('path').attr('class', 'selection-outline').attr('data-iso3', iso3).attr('d', pathGenerator(part.feature));
    }
  }

  function isTooSmallToSelect(bounds) {
    const [[x0, y0], [x1, y1]] = bounds;
    const width = Math.abs(x1 - x0) * MAX_SCALE;
    const height = Math.abs(y1 - y0) * MAX_SCALE;
    return Math.max(width, height) < MIN_VISIBLE_PX_AT_MAX_SCALE;
  }

  /**
   * @param {string} iso3
   * @param {{animate?: boolean, coord?: {lat: number, lng: number}, name?: string}} [opts]
   *   `coord`/`name` are used for the off-map fly-to path when the country has no
   *   drawn shape (or none matched) — search.js supplies these from the bundled index.
   */
  function selectCountry(iso3, opts = {}) {
    if (!ready) {
      pendingCamera = () => selectCountry(iso3, opts); // replayed once the shapes exist, instead of throwing
      return;
    }
    const { animate = true, fromMapClick = false } = opts;
    const wasSelected = selectedIso3 === iso3;
    clearSelectionVisuals();
    selectedIso3 = iso3;
    const country = model.byIso3.get(iso3);
    const tooSmall = country?.mainLandmass && isTooSmallToSelect(country.zoomBounds);

    if (country?.mainLandmass && !tooSmall) {
      markSelected(iso3);
      const target = fitTransformToBounds(country.zoomBounds, country.focus);
      // Clicking the country that is already selected must not undo a zoom the user did on
      // purpose (zoom in to look closer, click the country again: it used to snap back out to the
      // fit). Selecting it from search — or clicking it while zoomed OUT — still zooms to it.
      const keepZoom = shouldKeepZoom({ fromMapClick, wasSelected, currentScale: currentTransform.k, fitScale: target.k, minScale: MIN_SCALE });
      if (!keepZoom) applyTransform(target, animate);
      onSelect?.(iso3);
      return;
    }

    const [lng, lat] = country?.mainLandmass ? country.mainLandmass.centroid : [];
    const coord = opts.coord || (lat != null ? { lat, lng } : null);
    if (!coord) {
      onSelect?.(iso3); // no shape and no coordinate at all — panel still opens, map just doesn't move
      return;
    }
    if (tooSmall) markSelected(iso3);
    renderOffMapMarker(coord, opts.name || country?.name || iso3);
    const point = projection([coord.lng, coord.lat]);
    const t = fitTransform([point, point], availableRect(), { minScale: MAX_SCALE * 0.5, maxScale: MAX_SCALE * 0.5, padding: 1 });
    applyTransform(d3.zoomIdentity.translate(t.x, t.y).scale(t.k), animate);
    onSelect?.(iso3);
  }

  function renderOffMapMarker(coord, name) {
    const [x, y] = projection([coord.lng, coord.lat]);
    const g = markersLayer.append('g').attr('class', 'off-map-marker').attr('transform', `translate(${x},${y})`);
    g.append('circle').attr('class', 'off-map-ring').attr('r', 6);
    g.append('circle').attr('class', 'off-map-dot').attr('r', 2.5);
    g.append('text').attr('class', 'off-map-label').attr('x', 9).attr('y', 3).text(name);
    g.on('pointerup', (event) => {
      event.stopPropagation();
      selectCountry(selectedIso3, { animate: false, coord, name });
    });
    offMapMarker = g;
  }

  function clearSelection() {
    clearSelectionVisuals();
    selectedIso3 = null;
  }

  function reset() {
    applyTransform(d3.zoomIdentity, true);
  }

  function zoomBy(factor) {
    svg.transition().duration(200).call(zoomBehavior.scaleBy, factor);
  }

  // Restores a previously-saved camera position (and, optionally, which country is
  // highlighted) without re-running a zoom-to-country animation — used when returning
  // to the map view from the country page, so it looks exactly as the user left it
  // rather than re-fitting to the selected country's bounds.
  function restoreTransform(transform, iso3) {
    if (!ready) {
      pendingCamera = () => restoreTransform(transform, iso3);
      return;
    }
    if (transform) applyTransform(d3.zoomIdentity.translate(transform.x, transform.y).scale(transform.k), false);
    if (iso3 && model.byIso3.has(iso3)) {
      clearSelectionVisuals();
      markSelected(iso3);
      selectedIso3 = iso3;
    }
  }

  // ---- dev / E2E hooks --------------------------------------------------------------------

  function toScreen(lng, lat) {
    const rect = container.getBoundingClientRect();
    const [x, y] = localToScreen(projection([lng, lat]), getMapping(), currentTransform);
    return { x: rect.left + x, y: rect.top + y };
  }

  // True if a lng/lat is on screen AND not under the side panel — i.e. actually visible.
  function isGeoPointInView(lng, lat) {
    const { width, height } = containerSize();
    const { x, y } = toScreen(lng, lat);
    const rect = container.getBoundingClientRect();
    const insets = panelInsets();
    return x - rect.left >= 0 && y - rect.top >= 0 && x - rect.left <= width - insets.right && y - rect.top <= height - insets.bottom;
  }

  // A failed topology / search-index / continents request must not leave a silently blank map.
  let loadError = null;
  function start() {
    loadError?.remove();
    loadError = null;
    init().catch(() => {
      loadError = createEl('div', {
        className: 'map-load-error',
        children: [createErrorRetry('The world map could not be loaded. Check your connection and try again.', start)],
      });
      container.appendChild(loadError);
    });
  }
  start();

  return {
    selectCountry,
    clearSelection,
    reset,
    zoomBy,
    isReady: () => ready,
    getTransform: () => ({ ...currentTransform }),
    restoreTransform,
    getOptions: () => options,
    setOptions,
    project: (lng, lat) => projection([lng, lat]),
    toScreen,
    isGeoPointInView,
    elevationBandAt: (lng, lat) => elevation?.bandAt(lng, lat) ?? null,
  };
}

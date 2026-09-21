import {
  ELEVATION_BANDS,
  TILE_SIZE,
  TERRARIUM_MIN_ZOOM,
  tileUrl,
  decodeTerrarium,
  tileZoomForScale,
  createElevationSampler,
  renderElevationRaster,
  createRowGeometry,
} from './elevation.js';
import { localToScreen } from './viewport.js';
import { createEl } from '../../lib/domUtils.js';

const MAX_CONCURRENT_FETCHES = 8;
const MAX_DETAIL_TILES_PER_DRAW = 40;
const MAX_CACHED_DETAIL_TILES = 300; // ~128 KB each; the 16 base tiles are never evicted
const FETCH_TIMEOUT_MS = 15_000; // same budget as the app's other live requests
const FAILED_RETRY_MS = 30_000; // a failed detail tile may be retried after this long
const DRAFT_RESOLUTION = 0.3; // low-res while zooming/panning; full-res once things settle
const SETTLE_MS = 140;
const BASE_TILE_COUNT = 4 ** TERRARIUM_MIN_ZOOM;

async function fetchElevationGrid(z, x, y) {
  // A hung connection must fail rather than occupy one of the 8 fetch slots forever (which
  // would leave "Loading elevation data…" on screen with no way out).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let blob;
  try {
    const response = await fetch(tileUrl(z, x, y), { signal: controller.signal });
    if (!response.ok) throw new Error(`Elevation tile ${z}/${x}/${y} failed (${response.status})`);
    blob = await response.blob();
  } finally {
    clearTimeout(timer);
  }
  let bitmap;
  try {
    // Terrarium encodes numbers in RGB, so no color management or alpha handling may touch it.
    bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    bitmap = await createImageBitmap(blob);
  }
  const scratch = document.createElement('canvas');
  scratch.width = TILE_SIZE;
  scratch.height = TILE_SIZE;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);
  bitmap.close?.();
  const grid = new Int16Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0; i < grid.length; i++) grid[i] = Math.round(decodeTerrarium(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]));
  return grid;
}

/**
 * The elevation map: a canvas painted BEHIND the (transparent-filled) country SVG. It is
 * re-rendered from Terrarium terrain tiles for exactly what is on screen — sharper tiles
 * are fetched as you zoom in, coarser ones fill in until they arrive — and clipped to the
 * vector country outlines so the crisp coastline wins over the raster's own 0 m contour.
 * @param {{container: HTMLElement, projection: Function, drawLand: (ctx: CanvasRenderingContext2D) => void,
 *   getMapping: () => object, getTransform: () => object,
 *   onStatus: (status: {state: 'loading' | 'ready' | 'unavailable', loaded?: number, total?: number}) => void}} deps
 */
export function createElevationLayer({ container, projection, drawLand, getMapping, getTransform, onStatus }) {
  const canvas = createEl('canvas', { className: 'elevation-canvas', attrs: { 'aria-hidden': 'true' } });
  canvas.hidden = true;
  container.insertBefore(canvas, container.firstChild);
  const landCanvas = document.createElement('canvas');
  const projectionApi = { project: (lngLat) => projection(lngLat), invert: (xy) => projection.invert(xy) };

  const tiles = new Map(); // insertion order = age, for eviction
  const inflight = new Map();
  const failed = new Map(); // key -> time of failure
  const queue = [];
  let running = 0;
  let active = false;
  let baseState = 'idle'; // idle | loading | ready | unavailable
  let frameHandle = 0;
  let settleTimer = 0;

  function hasRecentlyFailed(key) {
    const at = failed.get(key);
    if (at === undefined) return false;
    if (Date.now() - at < FAILED_RETRY_MS) return true;
    failed.delete(key);
    return false;
  }

  // Keeps memory bounded on a long session of panning: the oldest detail tiles go first.
  function evictOldDetailTiles() {
    let detailCount = 0;
    for (const key of tiles.keys()) if (!key.startsWith(`${TERRARIUM_MIN_ZOOM}/`)) detailCount++;
    for (const key of tiles.keys()) {
      if (detailCount <= MAX_CACHED_DETAIL_TILES) break;
      if (key.startsWith(`${TERRARIUM_MIN_ZOOM}/`)) continue;
      tiles.delete(key);
      detailCount--;
    }
  }

  function pump() {
    while (running < MAX_CONCURRENT_FETCHES && queue.length > 0) {
      // Newest request first: after a fast pan, the tiles for where the user IS matter more
      // than the ones queued for where they were a moment ago.
      const job = queue.pop();
      running++;
      fetchElevationGrid(job.z, job.x, job.y)
        .then((grid) => {
          tiles.set(job.key, grid);
          evictOldDetailTiles();
        })
        .catch(() => failed.set(job.key, Date.now()))
        .finally(() => {
          running--;
          inflight.delete(job.key);
          job.resolve();
          pump();
        });
    }
  }

  function requestTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (tiles.has(key) || hasRecentlyFailed(key)) return Promise.resolve();
    if (inflight.has(key)) return inflight.get(key);
    const promise = new Promise((resolve) => queue.push({ z, x, y, key, resolve }));
    inflight.set(key, promise);
    pump();
    return promise;
  }

  async function ensureBase() {
    if (baseState === 'loading' || baseState === 'ready') return;
    baseState = 'loading';
    failed.clear();
    const size = 2 ** TERRARIUM_MIN_ZOOM;
    const jobs = [];
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        jobs.push(requestTile(TERRARIUM_MIN_ZOOM, x, y).then(() => onStatus({ state: 'loading', loaded: countBaseTiles(), total: BASE_TILE_COUNT })));
      }
    }
    onStatus({ state: 'loading', loaded: 0, total: BASE_TILE_COUNT });
    await Promise.all(jobs);
    baseState = countBaseTiles() === BASE_TILE_COUNT ? 'ready' : 'unavailable';
    onStatus({ state: baseState === 'ready' ? 'ready' : 'unavailable' });
    if (baseState === 'ready') draw(false);
  }

  function countBaseTiles() {
    let count = 0;
    for (const key of tiles.keys()) if (key.startsWith(`${TERRARIUM_MIN_ZOOM}/`)) count++;
    return count;
  }

  function draw(draft) {
    if (!active || baseState !== 'ready') return;
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height) return;
    const resolution = draft ? DRAFT_RESOLUTION : 1;
    const pixelWidth = Math.max(1, Math.round(width * resolution));
    const pixelHeight = Math.max(1, Math.round(height * resolution));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      landCanvas.width = pixelWidth;
      landCanvas.height = pixelHeight;
    }

    const mapping = getMapping();
    const transform = getTransform();
    const zoom = tileZoomForScale(transform.k);
    const wanted = new Set();
    const getTile = (z, x, y) => {
      const key = `${z}/${x}/${y}`;
      const tile = tiles.get(key);
      if (!tile && z === zoom && !hasRecentlyFailed(key)) wanted.add(key);
      return tile ?? null;
    };

    // Pixel -> local map coordinates is linear on each axis: local = pixel * a + b.
    const ax = 1 / (mapping.scale * transform.k);
    const by = -(mapping.offsetY / mapping.scale + transform.y) / transform.k;
    const bx = -(mapping.offsetX / mapping.scale + transform.x) / transform.k;
    const rowGeometry = createRowGeometry(projectionApi, { ax, bx, ay: ax, by, resolution });

    const { all, land } = renderElevationRaster({ width: pixelWidth, height: pixelHeight, rowGeometry, sample: createElevationSampler(getTile, zoom) });
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pixelWidth, pixelHeight);
    ctx.putImageData(new ImageData(all, pixelWidth, pixelHeight), 0, 0);
    landCanvas.getContext('2d').putImageData(new ImageData(land, pixelWidth, pixelHeight), 0, 0);

    ctx.save();
    const k = resolution * mapping.scale * transform.k;
    ctx.setTransform(k, 0, 0, k, resolution * (mapping.offsetX + mapping.scale * transform.x), resolution * (mapping.offsetY + mapping.scale * transform.y));
    ctx.beginPath();
    drawLand(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clip();
    ctx.drawImage(landCanvas, 0, 0);
    ctx.restore();

    if (!draft) {
      canvas.dataset.ready = 'true';
      for (const key of [...wanted].slice(0, MAX_DETAIL_TILES_PER_DRAW)) {
        const [z, x, y] = key.split('/').map(Number);
        requestTile(z, x, y).then(scheduleSettledDraw);
      }
    }
  }

  function scheduleSettledDraw() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => draw(false), SETTLE_MS);
  }

  return {
    setActive(next) {
      active = next;
      canvas.hidden = !next;
      if (!next) {
        canvas.dataset.ready = 'false';
        return;
      }
      if (baseState === 'unavailable') baseState = 'idle'; // switching to elevation again is a retry
      if (baseState === 'ready') {
        onStatus({ state: 'ready' });
        draw(false);
      } else {
        ensureBase();
      }
    },
    /** Call on zoom/pan/resize: a quick half-res frame now, a sharp one when things settle. */
    refresh() {
      if (!active || baseState !== 'ready') return;
      cancelAnimationFrame(frameHandle);
      frameHandle = requestAnimationFrame(() => draw(true));
      scheduleSettledDraw();
    },
    /** The id of the elevation band actually painted at a lng/lat (reads the canvas), for tests. */
    bandAt(lng, lat) {
      if (!active || canvas.dataset.ready !== 'true') return null;
      const rect = container.getBoundingClientRect();
      const [sx, sy] = localToScreen(projection([lng, lat]), getMapping(), getTransform());
      const px = canvas.getContext('2d').getImageData(Math.round((sx * canvas.width) / rect.width), Math.round((sy * canvas.height) / rect.height), 1, 1).data;
      const band = ELEVATION_BANDS.find((b) => [1, 3, 5].every((o, i) => parseInt(b.color.slice(o, o + 2), 16) === px[i]));
      return band?.id ?? 'unknown';
    },
  };
}

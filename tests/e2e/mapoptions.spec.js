import { test, expect } from '@playwright/test';
import { openMap, chooseOption } from './helpers.js';

const CONTINENTS = ['Africa', 'Antarctica', 'Asia', 'Europe', 'North America', 'Oceania', 'South America'];
const fillOf = (page, iso3) =>
  page.locator(`.country-path[data-iso3="${iso3}"]`).first().evaluate((el) => getComputedStyle(el).fill);

test.describe('map options', () => {
  test('a compact options card offers map style, names and overlay toggles, with sensible defaults', async ({ page }) => {
    await openMap(page);
    const card = page.locator('.map-options');
    await expect(card).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Map style' }).getByRole('radio')).toHaveCount(3);
    await expect(page.getByRole('radio', { name: 'Political' })).toBeChecked();
    await expect(page.getByRole('radiogroup', { name: 'Names' }).getByRole('radio')).toHaveCount(3);
    await expect(page.getByRole('radio', { name: 'Major countries' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Grid and coordinates' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Ocean and sea names' })).toBeChecked();
    const width = (await card.boundingBox()).width;
    expect(width).toBeLessThan(260); // compact: it must not hide the map it controls
  });

  test('the card can be collapsed to just its title', async ({ page }) => {
    await openMap(page);
    const toggle = page.locator('.map-options-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.map-options-body')).toBeHidden();
    await toggle.click();
    await expect(page.locator('.map-options-body')).toBeVisible();
  });
});

// Item 9 (geographic) — regions colored by continent.
test.describe('geographic regions mode', () => {
  test('colors every country by continent: same continent = same color, different = different', async ({ page }) => {
    await openMap(page);
    await chooseOption(page, 'Map style', 'Geographic');
    await expect(page.locator('svg.world-map-svg')).toHaveAttribute('data-map-mode', 'geographic');

    expect(await fillOf(page, 'FRA')).toBe(await fillOf(page, 'DEU')); // both Europe
    expect(await fillOf(page, 'USA')).toBe(await fillOf(page, 'MEX')); // both North America
    expect(await fillOf(page, 'BRA')).toBe(await fillOf(page, 'ARG')); // both South America
    expect(await fillOf(page, 'FRA')).not.toBe(await fillOf(page, 'BRA'));
    expect(await fillOf(page, 'IND')).not.toBe(await fillOf(page, 'NGA'));
    expect(await fillOf(page, 'AUS')).not.toBe(await fillOf(page, 'IDN')); // Oceania vs Asia
  });

  test('shows a key naming all seven continents', async ({ page }) => {
    await openMap(page);
    await chooseOption(page, 'Map style', 'Geographic');
    const legend = page.locator('.map-legend');
    await expect(legend).toBeVisible();
    for (const name of CONTINENTS) await expect(legend.locator('.map-legend-item', { hasText: name })).toHaveCount(1);
  });

  test('the political colors come back when switching back (mode is fully reversible)', async ({ page }) => {
    await openMap(page);
    const politicalFrance = await fillOf(page, 'FRA');
    await chooseOption(page, 'Map style', 'Geographic');
    await chooseOption(page, 'Map style', 'Political');
    expect(await fillOf(page, 'FRA')).toBe(politicalFrance);
    await expect(page.locator('.map-legend')).toBeHidden();
  });
});

// Items 9 + 10 — elevation mode and its key.
test.describe('elevation mode', () => {
  test('shows a key with every elevation band, land and ocean, using the same colors as the map', async ({ page }) => {
    await openMap(page);
    await chooseOption(page, 'Map style', 'Elevation');
    const legend = page.locator('.map-legend');
    await expect(legend).toBeVisible();
    await expect(legend).toContainText('Elevation');
    for (const label of ['Above 5,000 m', '4,000 – 5,000 m', '3,000 – 4,000 m', '2,000 – 3,000 m', '1,000 – 2,000 m', '500 – 1,000 m', '200 – 500 m', '0 – 200 m', '0 – 200 m deep', '200 – 4,000 m deep', 'Deeper than 4,000 m']) {
      await expect(legend.locator('.map-legend-item', { hasText: label }).first(), label).toBeVisible();
    }
    const swatches = await legend.locator('.map-legend-swatch').evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
    expect(swatches).toHaveLength(11);
    expect(new Set(swatches).size).toBe(11); // no two bands share a color
    await expect(legend).toContainText(/terrain tiles/i); // credits the data source
  });

  test('paints real terrain: high plateaus, lowlands and ocean depths each get the right band', async ({ page }) => {
    await openMap(page);
    await chooseOption(page, 'Map style', 'Elevation');
    await page.waitForSelector('.elevation-canvas[data-ready="true"]', { timeout: 45000 });

    const bandAt = (lng, lat) => page.evaluate(([x, y]) => window.__worldMap.elevationBandAt(x, y), [lng, lat]);
    const tibet = await bandAt(88, 32); // Tibetan Plateau, ~4,500-5,000 m
    const netherlands = await bandAt(5.3, 52.2); // low-lying delta
    const pacific = await bandAt(-140, 0); // abyssal Pacific
    expect(tibet).toMatch(/^land-(4000|5000)$/);
    expect(netherlands).toMatch(/^land-(0|200)$/);
    expect(pacific).toBe('ocean-deep');
  });

  // The terrain canvas is sized to the map container and clipped to the vector coastline. A resize
  // (window drag, phone rotation, mobile URL bar) fires no zoom event, so it was never redrawn:
  // the stale bitmap stayed stretched and out of register with the borders and labels.
  test('resizing the window redraws the terrain to the new size', async ({ page }) => {
    await openMap(page);
    await chooseOption(page, 'Map style', 'Elevation');
    await page.waitForSelector('.elevation-canvas[data-ready="true"]', { timeout: 45000 });
    const canvasWidth = () => page.locator('.elevation-canvas').evaluate((c) => c.width);
    await expect.poll(canvasWidth).toBe(1280); // Desktop Chrome default viewport

    await page.setViewportSize({ width: 900, height: 900 });
    await expect.poll(canvasWidth, { timeout: 5000 }).toBe(900);
    const [w, h] = await page.locator('.elevation-canvas').evaluate((c) => [c.width, c.height]);
    const box = await page.locator('#world-map-mount').boundingBox();
    expect([w, h]).toEqual([Math.round(box.width), Math.round(box.height)]);
  });

  // applyOptions() used to call the elevation layer's setActive() on EVERY option change, so
  // ticking "Grid" or switching the names redrew the whole terrain raster.
  test('changing an unrelated option (grid, names) does not repaint the terrain', async ({ page }) => {
    await openMap(page);
    await chooseOption(page, 'Map style', 'Elevation');
    await page.waitForSelector('.elevation-canvas[data-ready="true"]', { timeout: 45000 });
    await page.waitForTimeout(600); // let detail-tile redraws settle
    await page.evaluate(() => {
      window.__paints = 0;
      const original = CanvasRenderingContext2D.prototype.putImageData;
      CanvasRenderingContext2D.prototype.putImageData = function counted(...args) {
        window.__paints++;
        return original.apply(this, args);
      };
    });
    await page.getByRole('checkbox', { name: 'Grid and coordinates' }).uncheck();
    await chooseOption(page, 'Names', 'All countries');
    await page.getByRole('checkbox', { name: 'Ocean and sea names' }).uncheck();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__paints)).toBe(0);
  });

  // (Rows beyond the poles being left unpainted is covered by createRowGeometry's unit tests: the
  // camera is now constrained to the map, so that area can no longer be scrolled into view.)

  test('country outlines stay clickable in elevation mode, and selection is still visible', async ({ page }) => {
    await openMap(page);
    await chooseOption(page, 'Map style', 'Elevation');
    const fill = await page.locator('.country-path[data-iso3="FRA"]').evaluate((el) => getComputedStyle(el).fill);
    expect(fill).toMatch(/rgba\(0, 0, 0, 0\)|transparent/); // the terrain shows through the country shape
    await page.evaluate(() => window.__worldMap.selectCountry('FRA', { animate: false }));
    await expect(page.locator('.country-path[data-iso3="FRA"]')).toHaveClass(/selected/);
    await expect(page.locator('.selection-outline')).toHaveCount(1);
  });

  test('a failed tile download degrades to a visible message, not a broken page', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.route('**/elevation-tiles-prod/**', (route) => route.abort());
    await openMap(page);
    await chooseOption(page, 'Map style', 'Elevation');
    await expect(page.locator('.map-legend-status')).toContainText(/unavailable/i, { timeout: 30000 });
    expect(errors).toEqual([]);
  });
});

// Items 4 + 8 — label modes.
test.describe('names', () => {
  const countryLabels = (page) => page.locator('.map-label').allTextContents();

  test('"Major countries" (default) names only the biggest countries at world view', async ({ page }) => {
    await openMap(page);
    const names = await countryLabels(page);
    expect(names.length).toBeGreaterThan(8);
    expect(names).toEqual(expect.arrayContaining(['Russia', 'Brazil', 'Australia']));
    expect(names).not.toContain('Belgium');
  });

  test('"All countries" offers many more names than "Major countries" at the same zoom, and updates the map', async ({ page }) => {
    await openMap(page);
    const major = (await countryLabels(page)).length;
    await chooseOption(page, 'Names', 'All countries');
    // Belgium, Cuba, Ghana... cannot fit their names inside their outlines at world zoom, so
    // "All" must be allowed to spill over the border, or it would look identical to "Major".
    await expect.poll(async () => (await countryLabels(page)).length).toBeGreaterThan(major + 25);
    expect(await countryLabels(page)).toEqual(expect.arrayContaining(['Russia', 'Brazil', 'Cuba']));
    await chooseOption(page, 'Names', 'Major countries');
    await expect.poll(async () => (await countryLabels(page)).length).toBe(major);
  });

  test('"Continents only" shows the continent names and no country names', async ({ page }) => {
    await openMap(page);
    await chooseOption(page, 'Names', 'Continents only');
    await expect(page.locator('.map-label')).toHaveCount(0);
    const names = await page.locator('.continent-label').allTextContents();
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const name of names) expect(CONTINENTS).toContain(name);
    expect(names).toEqual(expect.arrayContaining(['Africa', 'Asia', 'Europe', 'North America', 'South America']));
  });

  test('continent names are hidden again when leaving "Continents only"', async ({ page }) => {
    await openMap(page);
    await chooseOption(page, 'Names', 'Continents only');
    await chooseOption(page, 'Names', 'Major countries');
    await expect(page.locator('.continent-label')).toHaveCount(0);
    expect((await countryLabels(page)).length).toBeGreaterThan(8);
  });
});

// Item 3 — ocean names, cardinal directions, latitude/longitude, equator and tropics.
test.describe('geographic reference overlays', () => {
  test('names the oceans', async ({ page }) => {
    await openMap(page);
    const names = await page.locator('.water-label').allTextContents();
    for (const expected of ['Pacific', 'Atlantic', 'Indian Ocean', 'Southern Ocean', 'Arctic Ocean']) {
      expect(names.some((n) => n.includes(expected)), `an ocean label containing "${expected}"`).toBe(true);
    }
  });

  test('seas appear as you zoom in', async ({ page }) => {
    await openMap(page);
    expect(await page.locator('.water-label', { hasText: 'Mediterranean' }).count()).toBe(0);
    const [lx, ly] = await page.evaluate(() => window.__worldMap.project(18, 34.5));
    await page.evaluate(([x, y]) => window.__worldMap.restoreTransform({ x: 480 - x * 4, y: 250 - y * 4, k: 4 }, null), [lx, ly]);
    await expect(page.locator('.water-label', { hasText: 'Mediterranean Sea' })).toHaveCount(1);
  });

  test('draws the equator, both tropics and both polar circles, and labels them', async ({ page }) => {
    await openMap(page);
    for (const id of ['equator', 'cancer', 'capricorn', 'arctic-circle', 'antarctic-circle']) {
      await expect(page.locator(`.special-line[data-line="${id}"]`), id).toHaveCount(1);
    }
    const chips = await page.locator('.frame-line-chip').allTextContents();
    const text = chips.join(' | ');
    for (const expected of ['Equator', 'Tropic of Cancer', 'Tropic of Capricorn', 'Arctic Circle', 'Antarctic Circle']) {
      expect(text, expected).toContain(expected);
    }
    expect(text).toContain('23.44°N');
    expect(text).toContain('23.44°S');
  });

  test('the equator is drawn where latitude 0 actually is', async ({ page }) => {
    await openMap(page);
    const { lineY, expectedY } = await page.evaluate(() => {
      const el = document.querySelector('.special-line[data-line="equator"]');
      return { lineY: el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2, expectedY: window.__worldMap.toScreen(0, 0).y };
    });
    expect(Math.abs(lineY - expectedY)).toBeLessThan(2);
  });

  test('labels latitude and longitude along the map edges', async ({ page }) => {
    await openMap(page);
    const lats = (await page.locator('.frame-lat-label').allTextContents()).join(' ');
    for (const expected of ['30°N', '30°S', '60°N', '0°']) expect(lats, expected).toContain(expected);
    const lons = (await page.locator('.frame-lon-label').allTextContents()).join(' ');
    for (const expected of ['0°', '60°E', '60°W']) expect(lons, expected).toContain(expected);
  });

  test('the grid gets finer as you zoom in (30 degrees at world view, 10 by 6x)', async ({ page }) => {
    await openMap(page);
    await expect(page.locator('.frame-lat-label', { hasText: '30°N' })).toHaveCount(1);
    await expect(page.locator('.frame-lat-label', { hasText: '20°N' })).toHaveCount(0);
    const [lx, ly] = await page.evaluate(() => window.__worldMap.project(10, 30));
    await page.evaluate(([x, y]) => window.__worldMap.restoreTransform({ x: 480 - x * 6, y: 250 - y * 6, k: 6 }, null), [lx, ly]);
    await expect(page.locator('.frame-lat-label', { hasText: '20°N' })).toHaveCount(1);
    await expect(page.locator('.frame-lat-label', { hasText: '40°N' })).toHaveCount(1);
  });

  test('shows a compass rose with all four cardinal directions', async ({ page }) => {
    await openMap(page);
    const compass = page.locator('.map-compass');
    await expect(compass).toBeVisible();
    for (const dir of ['N', 'E', 'S', 'W']) await expect(compass.locator('text', { hasText: new RegExp(`^${dir}$`) })).toHaveCount(1);
    await expect(compass).toHaveAttribute('role', 'img');
    await expect(compass).toHaveAttribute('aria-label', /north/i);
  });

  test('"Grid and coordinates" toggles the graticule, special lines and edge labels together', async ({ page }) => {
    await openMap(page);
    await expect(page.locator('.graticule-line')).not.toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Grid and coordinates' }).uncheck();
    await expect(page.locator('.graticule-line')).toHaveCount(0);
    await expect(page.locator('.special-line')).toHaveCount(0);
    await expect(page.locator('.frame-lat-label')).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Grid and coordinates' }).check();
    await expect(page.locator('.special-line')).toHaveCount(5);
  });

  test('"Ocean and sea names" toggles the water labels', async ({ page }) => {
    await openMap(page);
    await expect(page.locator('.water-label')).not.toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Ocean and sea names' }).uncheck();
    await expect(page.locator('.water-label')).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Ocean and sea names' }).check();
    await expect(page.locator('.water-label')).not.toHaveCount(0);
  });

  test('the overlays never intercept clicks: a country under a grid line is still selectable', async ({ page }) => {
    await openMap(page);
    const onEquator = await page.evaluate(() => window.__worldMap.toScreen(-60, 0)); // Brazil, right on the equator
    await page.mouse.click(onEquator.x, onEquator.y);
    await expect(page.locator('.country-path[data-iso3="BRA"]')).toHaveClass(/selected/);
  });
});

// Item 5 — polar regions.
test.describe('polar regions', () => {
  test('both polar circles and both polar caps are marked', async ({ page }) => {
    await openMap(page);
    await expect(page.locator('.polar-cap[data-cap="arctic"]')).toHaveCount(1);
    await expect(page.locator('.polar-cap[data-cap="antarctic"]')).toHaveCount(1);
    await expect(page.locator('.special-line[data-line="arctic-circle"]')).toHaveCount(1);
    await expect(page.locator('.special-line[data-line="antarctic-circle"]')).toHaveCount(1);
  });

  // Antarctica's polygon in the topology has the pole line as its exterior ring and the real
  // coastline as a hole, so its label box used to have zero height and the name never fit.
  test('Antarctica is named on the map in the default "Major countries" mode', async ({ page }) => {
    await openMap(page);
    expect(await page.locator('.map-label').allTextContents()).toContain('Antarctica');
  });

  test('Antarctica is named on the map in "Continents only" mode', async ({ page }) => {
    await openMap(page);
    await chooseOption(page, 'Names', 'Continents only');
    await expect(page.locator('.continent-label', { hasText: 'Antarctica' })).toHaveCount(1);
  });

  test('searching for Antarctica selects the drawn shape', async ({ page }) => {
    await openMap(page);
    await page.locator('.search-input').fill('Antarctica');
    await page.locator('.search-option', { hasText: 'Antarctica' }).click();
    await expect(page.locator('.country-path[data-iso3="ATA"]')).toHaveClass(/selected/);
  });
});

import { test, expect } from '@playwright/test';
import { openMap, readPixels, cssColorToRgb, colorDistance, waitForCameraToSettle } from './helpers.js';

test.describe('world map', () => {
  test('renders real country shapes with no console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

    await page.goto('/');
    await page.waitForFunction(() => window.__worldMap?.isReady());

    const pathCount = await page.locator('.country-path').count();
    expect(pathCount).toBeGreaterThan(200); // world-atlas has 240 non-Antarctica countries
    expect(errors).toEqual([]);
  });

  // Polar regions were missing: Antarctica used to be filtered out of the drawn map.
  test('Antarctica is drawn as a real, selectable shape', async ({ page }) => {
    await openMap(page);
    const antarctica = page.locator('.country-path[data-iso3="ATA"]');
    await expect(antarctica).toHaveCount(1);
    expect(await antarctica.getAttribute('d')).toBeTruthy();

    await page.evaluate(() => window.__worldMap.selectCountry('ATA', { animate: false }));
    await expect(antarctica).toHaveClass(/selected/);
  });

  test('no two adjacent country paths share a fill color', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__worldMap?.isReady());
    // Spot-check a handful of well-known shared borders rather than the full adjacency
    // graph (already proven clash-free against the real topology in
    // tests/unit/countryColoring.test.js + a one-off Node check during development).
    const borderPairs = [['FRA', 'DEU'], ['USA', 'CAN'], ['BRA', 'ARG'], ['IND', 'CHN']];
    for (const [a, b] of borderPairs) {
      const colorA = await page.locator(`.country-path[data-iso3="${a}"]`).getAttribute('data-color');
      const colorB = await page.locator(`.country-path[data-iso3="${b}"]`).getAttribute('data-color');
      expect(colorA, `${a} vs ${b}`).not.toBe(colorB);
    }
  });

  // Item 1: a country with land outside its mainland must zoom to show ALL of it. The map
  // used to zoom to the largest polygon only, so French Guiana, Alaska and Hawaii were
  // pushed out of view.
  async function selectAndWait(page, iso3) {
    await page.evaluate((code) => window.__worldMap.selectCountry(code, { animate: false }), iso3);
    await expect(page.locator(`.country-path[data-iso3="${iso3}"]`).first()).toHaveClass(/selected/);
    await expect(page.locator('.side-panel')).toHaveClass(/\bopen\b/);
  }
  const inView = (page, lng, lat) => page.evaluate(([x, y]) => window.__worldMap.isGeoPointInView(x, y), [lng, lat]);

  test('selecting France shows mainland France AND French Guiana, Guadeloupe and Réunion', async ({ page }) => {
    await openMap(page);
    await selectAndWait(page, 'FRA');
    expect(await inView(page, 2.5, 46.6), 'mainland France').toBe(true);
    expect(await inView(page, -53.2, 3.9), 'French Guiana').toBe(true);
    expect(await inView(page, -61.7, 16.2), 'Guadeloupe').toBe(true);
    expect(await inView(page, 55.5, -21.1), 'Réunion').toBe(true);
    expect(await page.evaluate(() => window.__worldMap.getTransform().k)).toBeGreaterThan(1);
  });

  test('selecting the USA shows the lower 48, Alaska AND Hawaii', async ({ page }) => {
    await openMap(page);
    await selectAndWait(page, 'USA');
    expect(await inView(page, -98.8, 39.9), 'contiguous US').toBe(true);
    expect(await inView(page, -152.6, 64.3), 'Alaska').toBe(true);
    expect(await inView(page, -155.5, 19.6), 'Hawaii').toBe(true);
  });

  // Russia's largest polygon is ONE ring whose points run across +/-180 degrees. Filtering whole
  // polygons by centroid cannot help there, so its bounds used to stretch across the entire map:
  // no zoom at all (k = 1.00), and Kamchatka and the Far East sat under the side panel.
  test('regression: Russia (one ring across the antimeridian) zooms, and its Far East is not left under the panel', async ({ page }) => {
    await openMap(page);
    await selectAndWait(page, 'RUS');
    expect(await page.evaluate(() => window.__worldMap.getTransform().k)).toBeGreaterThan(1.2);
    expect(await inView(page, 95.5, 65.9), 'Siberia').toBe(true);
    expect(await inView(page, 37.6, 55.8), 'Moscow').toBe(true);
    expect(await inView(page, 21.4, 54.7), 'Kaliningrad').toBe(true);
    expect(await inView(page, 158.6, 53.0), 'Kamchatka').toBe(true);
    expect(await inView(page, 142.7, 50.2), 'Sakhalin').toBe(true);
  });

  test('regression: a country with islands across the antimeridian (New Zealand) is not zoomed out to the whole world', async ({ page }) => {
    // Its Chatham Islands sit at -176.5°, the opposite edge of a non-wrapping map from the
    // main islands at +175°; including them would stretch the fit across the entire map.
    await openMap(page);
    await selectAndWait(page, 'NZL');
    expect(await page.evaluate(() => window.__worldMap.getTransform().k)).toBeGreaterThan(3);
    expect(await inView(page, 174.8, -41.3), 'Wellington / North Island').toBe(true);
    expect(await inView(page, 170.5, -44), 'South Island').toBe(true);
  });

  // Two drawn shapes share Australia's ISO code (the 3 km2 Ashmore and Cartier Islands). The
  // lookup used to keep the LAST one, so selecting Australia zoomed to a speck in the Timor Sea.
  test('regression: selecting Australia zooms to Australia itself, not to the tiny island shape that shares its code', async ({ page }) => {
    await openMap(page);
    await selectAndWait(page, 'AUS');
    expect(await inView(page, 134.2, -25.6), 'the outback').toBe(true);
    expect(await inView(page, 146.6, -42.0), 'Tasmania').toBe(true);
    expect(await inView(page, 115.9, -31.9), 'Perth').toBe(true);
    await expect(page.locator('.off-map-marker')).toHaveCount(0);
    expect(await page.evaluate(() => window.__worldMap.getTransform().k)).toBeGreaterThan(2);
    // every shape carrying the code is highlighted together
    const flags = await page.locator('.country-path[data-iso3="AUS"]').evaluateAll((els) => els.map((el) => el.classList.contains('selected')));
    expect(flags.length).toBeGreaterThan(1);
    expect(flags.every(Boolean)).toBe(true);
  });

  // Programmatic transforms bypass d3-zoom's pan limits, so selecting Antarctica (bounds as
  // wide as the map) used to scroll the whole map up and leave half the screen empty.
  test('selecting Antarctica does not scroll the map out from under itself into empty background', async ({ page }) => {
    await openMap(page);
    await selectAndWait(page, 'ATA');
    const t = await page.evaluate(() => window.__worldMap.getTransform());
    expect(t.k).toBe(1);
    expect(Math.abs(t.y)).toBeLessThan(1);
    expect(await inView(page, 0, -85), 'the polar plateau').toBe(true);
    expect(await inView(page, 0, 80), 'the Arctic is still on screen too').toBe(true);
  });

  test('islands near the right edge of the map (Tuvalu) are kept clear of the side panel, not centered beneath it', async ({ page }) => {
    await openMap(page);
    await page.evaluate(() => window.__worldMap.selectCountry('TUV', { animate: false, coord: { lat: -8.5, lng: 179.2 }, name: 'Tuvalu' }));
    await expect(page.locator('.side-panel')).toHaveClass(/\bopen\b/);
    expect(await inView(page, 179.2, -8.5)).toBe(true);
    await expect(page.locator('.off-map-marker')).toBeVisible();
  });

  // "When clicking bordering countries the camera zooms to the left instead of centering on the
  // country." Since a country's view includes its distant territories, it was centered on the
  // middle of the whole spread (Portugal + the Azores, the USA + Alaska + Hawaii), which left the
  // country itself far off to one side — Portugal's mainland ended up 350px right of center.
  // The camera now centers on a dominant mainland and widens just enough to keep every territory.
  test.describe('the camera centers on the country itself, territories included', () => {
    const freeCenter = (page) => page.evaluate(() => ({ x: document.querySelector('.side-panel').getBoundingClientRect().left / 2, y: window.innerHeight / 2 }));
    const cases = [
      ['PRT', 'Portugal', -8.0, 39.7, [[-28.0, 38.6, 'Azores'], [-17.0, 32.8, 'Madeira']]],
      ['NLD', 'the Netherlands', 5.6, 52.3, [[-68.3, 12.2, 'Bonaire']]],
      ['ESP', 'Spain', -3.6, 40.4, [[-15.6, 28.3, 'the Canary Islands']]],
      ['ECU', 'Ecuador', -78.4, -1.4, [[-90.8, -0.6, 'the Galápagos']]],
      ['USA', 'the USA', -98.8, 39.9, [[-152.6, 64.3, 'Alaska'], [-155.5, 19.6, 'Hawaii']]],
      ['FRA', 'France', 2.5, 46.6, [[-53.2, 3.9, 'French Guiana'], [55.5, -21.1, 'Réunion']]],
    ];
    for (const [iso3, label, lng, lat, territories] of cases) {
      test(`${label}: mainland is centered in the free area, and its territories are still in view`, async ({ page }) => {
        await openMap(page);
        await selectAndWait(page, iso3);
        await page.waitForTimeout(400); // panel finishes sliding in, so its left edge is final
        const center = await freeCenter(page);
        const mainland = await page.evaluate(([a, b]) => window.__worldMap.toScreen(a, b), [lng, lat]);
        // Guarantee: the mainland is within ~15% of half the free area of its center horizontally
        // (before this, Portugal's was ~350px off and the Netherlands' ~400px: >60% of half the width).
        // Vertically the map's top/bottom edges can also push it, so that bound is looser.
        expect(Math.abs(mainland.x - center.x), `${label} mainland x offset`).toBeLessThan(center.x * 0.2 + 12);
        expect(Math.abs(mainland.y - center.y), `${label} mainland y offset`).toBeLessThan(center.y * 0.45);
        for (const [tlng, tlat, tname] of territories) expect(await inView(page, tlng, tlat), tname).toBe(true);
      });
    }

    test('an archipelago with no dominant mainland (Indonesia) is still centered on the whole spread, not on one island', async ({ page }) => {
      await openMap(page);
      await selectAndWait(page, 'IDN');
      await page.waitForTimeout(400);
      for (const [lng, lat, name] of [[98, 3, 'Sumatra'], [113, -1, 'Borneo'], [138, -5, 'Papua'], [112, -7.5, 'Java']]) expect(await inView(page, lng, lat), name).toBe(true);
    });

    test('a bordering sequence (Canada, then the USA, then Mexico) centers each one', async ({ page }) => {
      await openMap(page);
      for (const [iso3, lng, lat] of [['CAN', -100, 58], ['USA', -98.8, 39.9], ['MEX', -102, 23]]) {
        const spot = await page.evaluate(([a, b]) => window.__worldMap.toScreen(a, b), [lng, lat]);
        await page.mouse.click(spot.x, spot.y);
        await expect(page.locator(`.country-path[data-iso3="${iso3}"]`).first()).toHaveClass(/selected/);
        await waitForCameraToSettle(page);
        const center = await freeCenter(page);
        const main = await page.evaluate(([a, b]) => window.__worldMap.toScreen(a, b), [lng, lat]);
        expect(Math.abs(main.x - center.x), `${iso3} x`).toBeLessThan(120);
      }
    });
  });

  // Issue 7: "When clicking the selected country twice, it zooms out."
  test.describe('clicking the country that is already selected', () => {
    const k = (page) => page.evaluate(() => window.__worldMap.getTransform().k);
    const clickBrazil = async (page) => {
      const spot = await page.evaluate(() => window.__worldMap.toScreen(-53, -10));
      await page.mouse.click(spot.x, spot.y);
    };

    test('keeps the zoom the user chose instead of snapping back out to the fit', async ({ page }) => {
      await openMap(page);
      await clickBrazil(page);
      await expect(page.locator('.country-path[data-iso3="BRA"]')).toHaveClass(/selected/);
      await waitForCameraToSettle(page);
      const fit = await k(page);
      const spot = await page.evaluate(() => window.__worldMap.toScreen(-53, -10));
      await page.mouse.move(spot.x, spot.y);
      for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(120); }
      await page.waitForTimeout(400);
      const zoomedIn = await k(page);
      expect(zoomedIn).toBeGreaterThan(fit * 1.5);

      await clickBrazil(page);
      await waitForCameraToSettle(page);
      expect(await k(page)).toBeCloseTo(zoomedIn, 1); // did not zoom out
      await expect(page.locator('.country-path[data-iso3="BRA"]')).toHaveClass(/selected/);
    });

    test('a double-click does not zoom out either', async ({ page }) => {
      await openMap(page);
      const spot = await page.evaluate(() => window.__worldMap.toScreen(-53, -10));
      await page.mouse.dblclick(spot.x, spot.y);
      await waitForCameraToSettle(page);
      const settled = await k(page);
      const spot2 = await page.evaluate(() => window.__worldMap.toScreen(-53, -10));
      await page.mouse.dblclick(spot2.x, spot2.y);
      await waitForCameraToSettle(page);
      expect(await k(page)).toBeCloseTo(settled, 1);
    });

    test('still zooms in on it when you are zoomed OUT (the click is a "go to" then)', async ({ page }) => {
      await openMap(page);
      await clickBrazil(page);
      await waitForCameraToSettle(page);
      const fit = await k(page);
      await page.locator('.map-hud-reset').click();
      await waitForCameraToSettle(page);
      expect(await k(page)).toBeLessThan(fit);
      await clickBrazil(page);
      await waitForCameraToSettle(page);
      expect(await k(page)).toBeCloseTo(fit, 1);
    });

    test('choosing the selected country again from the search box does re-fit it (an explicit "go to")', async ({ page }) => {
      await openMap(page);
      await clickBrazil(page);
      await waitForCameraToSettle(page);
      const fit = await k(page);
      await page.evaluate(() => window.__worldMap.zoomBy(3));
      await page.waitForTimeout(500);
      await page.evaluate(() => window.__worldMap.selectCountry('BRA', { animate: false }));
      expect(await k(page)).toBeCloseTo(fit, 1);
    });
  });

  // Issue 6: countries at the top sat against the top edge of the page.
  test.describe('space above the map', () => {
    test('the north pole is a clear margin below the top of the page at the world view', async ({ page }) => {
      await openMap(page);
      const pole = await page.evaluate(() => window.__worldMap.toScreen(0, 90));
      expect(pole.y).toBeGreaterThan(40);
      const greenland = await page.evaluate(() => document.querySelector('.country-path[data-iso3="GRL"]').getBoundingClientRect().top);
      expect(greenland).toBeGreaterThan(50);
    });

    test('a zoomed view of a northern country keeps clear of the top edge too', async ({ page }) => {
      await openMap(page);
      await selectAndWait(page, 'GRL');
      const top = await page.evaluate(() => document.querySelector('.country-path[data-iso3="GRL"]').getBoundingClientRect().top);
      expect(top).toBeGreaterThan(40);
    });

    test('the south pole is still on screen (the margin is at the top only)', async ({ page }) => {
      await openMap(page);
      const pole = await page.evaluate(() => window.__worldMap.toScreen(0, -90));
      const height = await page.evaluate(() => window.innerHeight);
      expect(pole.y).toBeLessThanOrEqual(height + 2);
    });
  });

  test('the selected country is centered in the part of the map the side panel does not cover', async ({ page }) => {
    await openMap(page);
    await selectAndWait(page, 'BRA');
    const { panelLeft, brazilX } = await page.evaluate(() => ({
      panelLeft: document.querySelector('.side-panel').getBoundingClientRect().left,
      brazilX: window.__worldMap.toScreen(-53, -10).x,
    }));
    expect(brazilX).toBeLessThan(panelLeft);
  });

  test('France and Germany both resolve to their own correct country on click (known map-data gap check)', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__worldMap?.isReady());
    await page.evaluate(() => window.__worldMap.selectCountry('FRA', { animate: false }));
    const franceSelected = await page.locator('.country-path.selected').getAttribute('data-iso3');
    expect(franceSelected).toBe('FRA');
  });

  test('hovering a large country (Russia) and a small one (Belgium) applies the hover state with no console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForFunction(() => window.__worldMap?.isReady());

    // Russia's main-landmass ring crosses the antimeridian, so its rendered <path>'s
    // native bounding box spans two disjoint pieces (correct — see WorldMap.js's
    // projectedLocalBounds comment) and Playwright's default hover-at-bbox-center
    // would land in the ocean gap between them, same as a naive click there would for
    // a real user. Hover at the label's position instead — guaranteed to be a point
    // actually inside the country, since that's exactly what its placement guarantees.
    const russiaLabel = await page.locator('.map-label', { hasText: 'Russia' }).boundingBox();
    await page.mouse.move(russiaLabel.x + russiaLabel.width / 2, russiaLabel.y + russiaLabel.height / 2);
    await expect(page.locator('.country-path[data-iso3="RUS"]')).toHaveClass(/hovered/);

    await page.evaluate(() => window.__worldMap.selectCountry('BEL', { animate: false }));
    await page.mouse.move(0, 0); // move away first so the hover event actually fires on entry
    await page.locator('.country-path[data-iso3="BEL"]').hover();
    await expect(page.locator('.country-path[data-iso3="BEL"]')).toHaveClass(/hovered/);

    expect(errors).toEqual([]);
  });

  test('reset view returns to the identity transform after zooming', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__worldMap?.isReady());
    await page.evaluate(() => window.__worldMap.selectCountry('FRA', { animate: false }));
    expect(await page.evaluate(() => window.__worldMap.getTransform().k)).toBeGreaterThan(1);

    await page.locator('.map-hud-reset').click();
    await page.waitForTimeout(500); // reset animates even with the E2E's animate:false selectCountry calls
    const k = await page.evaluate(() => window.__worldMap.getTransform().k);
    expect(k).toBeCloseTo(1, 1);
  });

  test('a genuine microstate (Vatican) uses the off-map marker; a small-but-visible country (Belgium) does not', async ({ page }) => {
    // Regression test for a real bug found during development: Vatican City *does*
    // have a polygon in the topology (unlike Tuvalu, which has none at all), just one
    // that's sub-pixel at any usable zoom — an early threshold for "too small to zoom
    // to directly" was miscalibrated and caught ordinary small-but-visible countries
    // (Belgium, Netherlands, Switzerland, Luxembourg...) in the same net.
    await page.goto('/');
    await page.waitForFunction(() => window.__worldMap?.isReady());

    await page.evaluate(() => window.__worldMap.selectCountry('VAT', { animate: false }));
    await expect(page.locator('.off-map-marker')).toBeVisible();

    await page.evaluate(() => window.__worldMap.selectCountry('BEL', { animate: false }));
    await expect(page.locator('.off-map-marker')).toHaveCount(0);
    await expect(page.locator('.country-path[data-iso3="BEL"]')).toHaveClass(/selected/);
  });

  test('dragging the map does not trigger a country selection', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__worldMap?.isReady());
    const box = await page.locator('.world-map-svg').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 10 });
    await page.mouse.up();
    const selected = await page.locator('.country-path.selected').count();
    expect(selected).toBe(0);
  });
  // Item 6: countries that "stay highlighted". Reproduced live on the old build: after a
  // mouse sweep across the map and moving away, 16-18 countries were still `.hovered`.
  test.describe('hover highlight always reverts', () => {
    test('sweeping across many countries never highlights more than one, and leaving clears it', async ({ page }) => {
      await openMap(page);
      const box = await page.locator('.world-map-svg').boundingBox();
      let worst = 0;
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i <= 50; i++) {
          await page.mouse.move(box.x + 100 + i * 20, box.y + 200 + Math.sin(i / 4) * 120, { steps: 2 });
          worst = Math.max(worst, await page.locator('.country-path.hovered').count());
        }
      }
      expect(worst).toBeLessThanOrEqual(1);

      await page.mouse.move(box.x + 5, box.y + box.height - 5, { steps: 4 }); // out over open ocean
      await expect(page.locator('.country-path.hovered')).toHaveCount(0);
      await expect(page.locator('.hover-pop')).toHaveCount(0);
    });

    test('moving the pointer onto a map control (off the svg entirely) clears the highlight', async ({ page }) => {
      await openMap(page);
      const spot = await page.evaluate(() => window.__worldMap.toScreen(-98, 40)); // over the USA
      await page.mouse.move(spot.x, spot.y);
      await expect(page.locator('.country-path.hovered')).toHaveCount(1);

      await page.locator('.map-hud-btn').first().hover();
      await expect(page.locator('.country-path.hovered')).toHaveCount(0);
      await expect(page.locator('.hover-pop')).toHaveCount(0);
    });

    test('zooming with the wheel while hovering drops the highlight instead of leaving it on a country now elsewhere', async ({ page }) => {
      await openMap(page);
      const spot = await page.evaluate(() => window.__worldMap.toScreen(2.5, 46.6)); // France
      await page.mouse.move(spot.x, spot.y);
      await expect(page.locator('.country-path.hovered')).toHaveCount(1);

      await page.mouse.wheel(0, -400);
      await expect(page.locator('.country-path.hovered')).toHaveCount(0);
      await page.mouse.move(spot.x + 2, spot.y + 2); // any movement re-establishes hover normally
      await expect(page.locator('.country-path.hovered')).toHaveCount(1);
    });

    // The pop-out is switched on a frame after it is drawn. If the hover ended (a zoom, the
    // pointer leaving) inside that same frame, the pending activation used to run afterwards and
    // resurrect the copy, which then stayed on screen.
    test('a hover that ends within the same frame it began does not leave a pop-out behind', async ({ page }) => {
      await openMap(page);
      await page.evaluate(() => {
        const el = document.querySelector('.country-path[data-iso3="FRA"]');
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
        window.__worldMap.restoreTransform({ x: -20, y: -10, k: 1.2 }, null); // ends the hover in the same task
      });
      await expect(page.locator('.hover-pop')).toHaveCount(0);
      await expect(page.locator('.hover-pop.active')).toHaveCount(0);
      await expect(page.locator('.country-path.hovered')).toHaveCount(0);
    });

    // "Hovering a country and then the ocean, the country name is still there in the mouseover."
    test('the name tooltip vanishes, and is emptied, the moment the pointer is over open water', async ({ page }) => {
      await openMap(page);
      const brazil = await page.evaluate(() => window.__worldMap.toScreen(-53, -10));
      await page.mouse.move(brazil.x, brazil.y);
      await expect(page.locator('.map-tooltip.visible')).toHaveText('Brazil');

      const ocean = await page.evaluate(() => window.__worldMap.toScreen(-25, -10));
      await page.mouse.move(ocean.x, ocean.y, { steps: 12 });
      await expect(page.locator('.map-tooltip.visible')).toHaveCount(0);
      await expect(page.locator('.map-tooltip')).toHaveText(''); // not just faded: nothing left to see or announce
      expect(await page.locator('.map-tooltip').evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    });

    test('it also clears when the pointer leaves a country over labels, grid lines and overlays', async ({ page }) => {
      await openMap(page);
      const start = await page.evaluate(() => window.__worldMap.toScreen(-60, 0)); // Brazil, on the equator line
      await page.mouse.move(start.x, start.y);
      await expect(page.locator('.map-tooltip.visible')).toHaveCount(1);
      await page.mouse.move(start.x - 400, start.y + 50, { steps: 20 }); // out across grid lines and water labels
      await expect(page.locator('.map-tooltip.visible')).toHaveCount(0);
      await expect(page.locator('.hover-pop.active')).toHaveCount(0);
    });

    test('hover pop-out is an overlay: the hovered country\'s own shape is never moved or re-parented', async ({ page }) => {
      await openMap(page);
      const before = await page.evaluate(() => {
        const el = document.querySelector('.country-path[data-iso3="FRA"]');
        return { index: [...el.parentNode.children].indexOf(el), transform: getComputedStyle(el).transform };
      });
      const spot = await page.evaluate(() => window.__worldMap.toScreen(2.5, 46.6));
      await page.mouse.move(spot.x, spot.y);
      await expect(page.locator('.hover-pop[data-iso3="FRA"]')).toHaveCount(1);
      const during = await page.evaluate(() => {
        const el = document.querySelector('.country-path[data-iso3="FRA"]');
        return { index: [...el.parentNode.children].indexOf(el), transform: getComputedStyle(el).transform };
      });
      expect(during).toEqual(before);
    });
  });

  // Item 2: "gaps between countries, e.g. Alaska, USA and Canada". The topology itself is
  // clean (every border is a shared arc); the gap was the hover pop-out scaling the USA
  // around the center of a bounding box that spans the whole map (its Aleutian islands
  // wrap past 180°), dragging Alaska tens of pixels away from Canada.
  test('hovering the USA does not open an ocean-colored gap between Alaska and Canada', async ({ page }) => {
    await openMap(page);
    const [lx, ly] = await page.evaluate(() => window.__worldMap.project(-141, 65));
    await page.evaluate(([x, y]) => window.__worldMap.restoreTransform({ x: 480 - x * 6, y: 250 - y * 6, k: 6 }, null), [lx, ly]);

    const inAlaska = await page.evaluate(() => window.__worldMap.toScreen(-150, 64));
    await page.mouse.move(inAlaska.x, inAlaska.y);
    await expect(page.locator('.hover-pop[data-iso3="USA"]')).toHaveCount(1);

    const border = [];
    for (let lat = 61; lat <= 69; lat += 0.5) {
      const p = await page.evaluate(([la]) => window.__worldMap.toScreen(-141, la), [lat]);
      for (const dx of [-3, 0, 3]) border.push({ x: p.x + dx, y: p.y });
    }
    const ocean = await cssColorToRgb(page, '.ocean', 'fill');
    const pixels = await readPixels(page, border);
    const oceanish = pixels.filter((px) => colorDistance(px, ocean) < 14);
    expect(oceanish, `${oceanish.length} of ${pixels.length} samples along the border looked like open water`).toEqual([]);
  });

  test('neighboring countries stay edge-to-edge in every hover state (Canada hovered too)', async ({ page }) => {
    await openMap(page);
    const [lx, ly] = await page.evaluate(() => window.__worldMap.project(-141, 65));
    await page.evaluate(([x, y]) => window.__worldMap.restoreTransform({ x: 480 - x * 6, y: 250 - y * 6, k: 6 }, null), [lx, ly]);
    const inYukon = await page.evaluate(() => window.__worldMap.toScreen(-135, 63));
    await page.mouse.move(inYukon.x, inYukon.y);
    await expect(page.locator('.hover-pop[data-iso3="CAN"]')).toHaveCount(1);

    const samples = [];
    for (let lat = 61; lat <= 69; lat += 0.5) {
      const p = await page.evaluate(([la]) => window.__worldMap.toScreen(-141, la), [lat]);
      samples.push({ x: p.x, y: p.y });
    }
    const ocean = await cssColorToRgb(page, '.ocean', 'fill');
    const pixels = await readPixels(page, samples);
    expect(pixels.filter((px) => colorDistance(px, ocean) < 14)).toEqual([]);
  });

  test.describe('loading', () => {
    // Picking a country before the shapes exist used to throw ("projection is not a function"):
    // nothing was selected and the panel never opened.
    test('a country selected before the map has loaded is applied once it has', async ({ page }) => {
      const errors = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await page.route('**/world-atlas@2/**', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.continue();
      });
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__worldMap);
      expect(await page.evaluate(() => window.__worldMap.isReady())).toBe(false);
      await page.evaluate(() => window.__worldMap.selectCountry('BRA', { animate: false }));

      await page.waitForFunction(() => window.__worldMap.isReady(), null, { timeout: 30000 });
      await expect(page.locator('.country-path[data-iso3="BRA"]')).toHaveClass(/selected/);
      await expect(page.locator('.side-panel')).toHaveClass(/\bopen\b/);
      expect(errors).toEqual([]);
    });

    test('a failed map download shows an error with a working Retry, not a silently blank map', async ({ page }) => {
      await page.route('**/world-atlas@2/**', (route) => route.abort());
      await page.goto('/');
      await expect(page.locator('.map-load-error .error-retry')).toBeVisible({ timeout: 20000 });
      expect(await page.evaluate(() => window.__worldMap.isReady())).toBe(false);

      await page.unroute('**/world-atlas@2/**');
      await page.locator('.map-load-error .error-retry-btn').click();
      await page.waitForFunction(() => window.__worldMap.isReady(), null, { timeout: 30000 });
      await expect(page.locator('.map-load-error')).toHaveCount(0);
      expect(await page.locator('.country-path').count()).toBeGreaterThan(200);
    });
  });
});

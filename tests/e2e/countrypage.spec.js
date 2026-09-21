import { test, expect } from '@playwright/test';

// The full country page fetches from ~15 live endpoints in parallel (Wikidata core +
// lists + religion + cities + attractions, nine World Bank scalars, a 17-band
// population pyramid, five Wikipedia topic summaries, the local file) — a real, and
// sometimes slow, amount of live network activity. Generous timeouts here reflect that
// reality rather than papering over it.
test.setTimeout(60000);

async function openCountryPage(page, iso3) {
  await page.goto(`/#/country/${iso3}`);
  await page.waitForSelector('.country-section#population', { timeout: 45000 });
}

test.describe('country page', () => {
  test('a direct deep link loads the page with no console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await openCountryPage(page, 'FRA');
    await expect(page.locator('.country-header-name')).toHaveText('France (FRA)');
    expect(errors).toEqual([]);
  });

  test('refreshing the page still loads it directly (no reliance on prior map state)', async ({ page }) => {
    await openCountryPage(page, 'NGA');
    await page.reload();
    await page.waitForSelector('.country-section#population', { timeout: 45000 });
    await expect(page.locator('.country-header-name')).toHaveText('Nigeria (NGA)');
  });

  test('all six sections are present with working sticky nav links', async ({ page }) => {
    await openCountryPage(page, 'AUS');
    const expected = ['overview', 'geography', 'history', 'government', 'culture', 'population'];
    for (const id of expected) {
      await expect(page.locator(`.country-section#${id}`)).toHaveCount(1);
      await expect(page.locator(`[data-section-link="${id}"]`)).toHaveCount(1);
    }
  });

  test('the population pyramid renders a real chart canvas', async ({ page }) => {
    await openCountryPage(page, 'BRA');
    await page.locator('#population').scrollIntoViewIfNeeded();
    await expect(page.locator('#pyramid-mount canvas')).toBeVisible({ timeout: 15000 });
  });

  test('the sticky section nav highlights the section currently in view while scrolling', async ({ page }) => {
    await openCountryPage(page, 'FRA');
    await page.locator('#culture').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-section-link].active')).toHaveAttribute('data-section-link', 'culture', { timeout: 5000 });

    await page.locator('#population').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-section-link].active')).toHaveAttribute('data-section-link', 'population', { timeout: 5000 });
  });

  // Found by review: the section links (href="#geography") changed the hash to something the router took for "the
  // map view", so the very first click threw you out of the country page. No test had ever clicked one.
  test.describe('links within the page', () => {
    const onCountryPage = (page) => Promise.all([expect(page.locator('#view-country')).toBeVisible(), expect(page.locator('#view-map')).toBeHidden()]);

    test('a section link scrolls to that section and stays on the country page', async ({ page }) => {
      await openCountryPage(page, 'FRA');
      const topOf = (id) => page.locator(`.country-section#${id}`).evaluate((el) => Math.round(el.getBoundingClientRect().top));
      for (const id of ['geography', 'culture']) {
        await page.locator(`[data-section-link="${id}"]`).click();
        await onCountryPage(page);
        expect(await page.evaluate(() => location.hash)).toBe(`#${id}`);
        await expect.poll(() => topOf(id), { timeout: 5000 }).toBeLessThan(150); // at the top of the view, just below the sticky nav
      }
      // the LAST section cannot reach the top (nothing below it to scroll past): it only has to come into view
      await page.locator('[data-section-link="population"]').click();
      await onCountryPage(page);
      await expect.poll(() => topOf('population'), { timeout: 5000 }).toBeLessThan(await page.evaluate(() => window.innerHeight - 100));
    });

    test('the skip link does not leave the country page either', async ({ page }) => {
      await openCountryPage(page, 'FRA');
      await page.locator('.skip-link').focus();
      await page.keyboard.press('Enter');
      await onCountryPage(page);
    });

    test('Back after using a section link returns to the country route, then to the map', async ({ page }) => {
      await openCountryPage(page, 'FRA');
      await page.locator('[data-section-link="history"]').click();
      await onCountryPage(page);
      await page.goBack();
      await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/country/FRA');
      await onCountryPage(page);
      await expect(page.locator('.country-header-name')).toHaveText('France (FRA)');
    });
  });

  test('"Back to map" returns to the map view', async ({ page }) => {
    await openCountryPage(page, 'FRA');
    await page.locator('.back-to-map-btn').click();
    await expect(page.locator('#view-map')).toBeVisible();
    await expect(page.locator('#view-country')).toBeHidden();
  });

  test('scrolling the page does not get hijacked by the embedded Leaflet map', async ({ page }) => {
    await openCountryPage(page, 'FRA');
    const before = await page.evaluate(() => document.getElementById('view-country').scrollTop);
    // Wheel over the map itself, before any click has enabled its scroll-zoom.
    const mapBox = await page.locator('.country-leaflet-map').boundingBox();
    await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => document.getElementById('view-country').scrollTop);
    expect(after).toBeGreaterThan(before);
  });

  test('a real Leaflet map renders with capital and city markers', async ({ page }) => {
    await openCountryPage(page, 'FRA');
    // .leaflet-tile-pane itself is a zero-size positioning container by Leaflet's own
    // design (its children are individually transformed <img> tiles) — check for an
    // actual rendered tile image, not the container's own bounding box.
    await expect(page.locator('.leaflet-tile-pane img').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.country-map-marker.marker-capital')).toHaveCount(1);
  });

  // Every country is served by live data alone: there is no hand-authored file for any of them, so no
  // country can be better covered than another.
  test('a country builds entirely from live data, with no editorial file behind it', async ({ page }) => {
    await openCountryPage(page, 'JPN');
    await expect(page.locator('.country-header-name')).toHaveText('Japan (JPN)');
    await expect(page.locator('#overview')).toContainText('Asia');
    await expect(page.locator('#country-page-mount')).not.toContainText('Details coming soon');
  });
  // Issue 9: the Vatican's population pyramid said only "Not available". No open source has an age-by-sex
  // breakdown for it (the World Bank rejects its code; Wikidata and the CIA Factbook carry a total only),
  // and inventing one is not an option — so say WHY, and show the population that IS known.
  test.describe('population pyramid when there is nothing to draw', () => {
    test('Vatican City explains that no age breakdown is published, instead of a bare "Not available"', async ({ page }) => {
      await openCountryPage(page, 'VAT');
      const pyramid = page.locator('#pyramid-mount');
      await expect(pyramid).toContainText('Vatican City', { timeout: 60000 });
      await expect(pyramid).toContainText(/no age/i);
      await expect(pyramid).toContainText('World Bank');
      await expect(pyramid.locator('canvas')).toHaveCount(0);
      expect((await pyramid.innerText()).trim()).not.toBe('Not available');
    });

    test('Vatican City still shows its population (from Wikidata: the World Bank has none)', async ({ page }) => {
      await openCountryPage(page, 'VAT');
      await expect(page.locator('.header-stat', { hasText: 'Population' })).toContainText(/[\d,]+ \(\d{4}\)/, { timeout: 60000 });
    });

    test('a country with age data still gets the chart', async ({ page }) => {
      await openCountryPage(page, 'FRA');
      await expect(page.locator('#pyramid-mount canvas')).toHaveCount(1, { timeout: 60000 });
    });

    test('if the age data fails to load, the pyramid says so (and does not claim there is none)', async ({ page }) => {
      await page.route('**/api.worldbank.org/**', (route) => route.abort());
      await openCountryPage(page, 'FRA');
      const pyramid = page.locator('#pyramid-mount');
      await expect(pyramid).toContainText(/could not be loaded/i, { timeout: 90000 });
      await expect(pyramid).not.toContainText(/no age/i);
    });
  });

  // Issue 10: Russia's anthem read "Recording unavailable" — only because the query carrying it had failed.
  test('Russia\'s anthem has a recording (the current State Anthem, not the ended one)', async ({ page }) => {
    await openCountryPage(page, 'RUS');
    await expect(page.locator('.country-header-anthem .anthem-title')).toContainText(/State Anthem of the Russian Federation/i, { timeout: 60000 });
    await expect(page.locator('.country-header-anthem .anthem-play-btn')).toBeEnabled();
    await expect(page.locator('.country-header-anthem')).not.toContainText(/unavailable/i);
  });

  test('a country page with a failed source offers Try again at the top', async ({ page }) => {
    await page.route('**/www.wikidata.org/**', (route) => route.abort());
    await openCountryPage(page, 'BRA');
    await expect(page.locator('.country-page .partial-notice')).toBeVisible({ timeout: 90000 });
  });

  // The anthem's recording is found by one of the LATER requests in Wikidata's chain, so it is the likeliest to
  // be refused when Wikimedia is busy. That used to be cached as a complete answer (no notice, and no audio in
  // Safari, which needs the MP3 that request provides), and a Try again could not restore the player.
  test('when the anthem recording lookup fails the page says so, and Try again brings the recording back', async ({ page }) => {
    await page.route('**/commons.wikimedia.org/w/api.php**', (route) => route.abort());
    await openCountryPage(page, 'RUS');
    await expect(page.locator('.country-page .partial-notice')).toContainText('Wikidata', { timeout: 90000 });
    const mp3 = page.locator('#anthem-player-root audio source[type="audio/mpeg"]');
    await expect(mp3).toHaveCount(0);

    await page.unroute('**/commons.wikimedia.org/w/api.php**');
    await page.locator('.country-page .partial-notice-btn').click();
    // Wait for the REBUILT page, not merely for the notice to be gone: Try again swaps in the skeleton at once (which
    // has no notice either), and the retry takes a few seconds — longer on a busy machine.
    await expect(page.locator('.country-page .country-header-name')).toBeVisible({ timeout: 90000 });
    await expect(page.locator('.country-page .partial-notice')).toHaveCount(0);
    await expect(mp3).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('.country-header-anthem .anthem-play-btn')).toBeEnabled();
    await expect(page.locator('.country-header-anthem')).not.toContainText(/unavailable/i);
  });

  // Found by review: a <source> that fails fires its error at the <source> and it does not bubble, so the player
  // never heard that every recording had failed: Play did nothing, for ever, on a button that looked usable. And a
  // FAILED load is not "no recording" (a network hiccup is the usual cause): Play stays available and tries again.
  test('when the recording files cannot be fetched the player says so, and Play tries again', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', "Playwright's WebKit does not route <audio> requests, so the files cannot be made to fail there");
    const blocked = ['**/upload.wikimedia.org/wikipedia/commons/**', '**/commons.wikimedia.org/wiki/Special:FilePath/**'];
    for (const pattern of blocked) await page.route(pattern, (route) => route.fulfill({ status: 404, body: '' }));
    await openCountryPage(page, 'FRA');
    const play = page.locator('.country-header-anthem .anthem-play-btn');
    const license = page.locator('.country-header-anthem .anthem-license');
    await expect(page.locator('.country-header-anthem .anthem-title')).toBeVisible({ timeout: 60000 });

    // Chromium tries the files as soon as they are set; Firefox and WebKit wait until Play is pressed (once).
    let pressed = false;
    await expect
      .poll(
        async () => {
          if (/could not be loaded/i.test((await license.textContent()) ?? '')) return true;
          if (!pressed && (await play.isEnabled())) {
            pressed = true;
            await play.click({ timeout: 2000 }).catch(() => {}); // it may have just changed: fine
          }
          return false;
        },
        { timeout: 30000, intervals: [300] }
      )
      .toBe(true);
    await expect(play).toBeEnabled(); // a failed load is not "no recording"

    for (const pattern of blocked) await page.unroute(pattern);
    await play.click();
    await expect(play).toHaveAttribute('aria-label', 'Pause anthem', { timeout: 20000 }); // playing now
    await page.locator('.country-header-anthem .anthem-play-btn').click(); // and stop, before the test ends
  });

  // Found by review: with the notice on screen while the map was still loading, Try again swapped the page
  // out, and the OLD build then resumed against the new DOM (a null mount: an uncaught error, and a map
  // leaked into a detached node).
  test('pressing Try again while the map is still loading does not break the rebuilt page', async ({ page }) => {
    test.setTimeout(150000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/unpkg.com/leaflet@1.9.4/dist/leaflet.js', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // hold Leaflet back: the notice is up while the old build waits on it
      await route.continue();
    });
    await page.route('**/www.wikidata.org/**', (route) => route.abort());
    await page.goto('/#/country/BRA');
    await expect(page.locator('.country-page .partial-notice')).toBeVisible({ timeout: 90000 });

    await page.unroute('**/www.wikidata.org/**');
    await page.locator('.country-page .partial-notice-btn').click();
    await expect(page.locator('.country-page .partial-notice')).toHaveCount(0, { timeout: 90000 });
    await expect(page.locator('#country-map-mount .country-leaflet-map')).toHaveCount(1, { timeout: 30000 });
    await expect(page.locator('#pyramid-mount canvas')).toHaveCount(1, { timeout: 30000 });
    expect(errors).toEqual([]);
  });

  // Found by review: a typed-in code that is not a country showed "Could not load this country" with a Try again
  // that could never work.
  test('a code that is not a country says so, with nothing to retry', async ({ page }) => {
    await page.goto('/#/country/ZZZ');
    await expect(page.locator('#country-page-mount .error-retry-message')).toHaveText('There is no country with the code ZZZ.', { timeout: 45000 });
    await expect(page.locator('#country-page-mount .error-retry-btn')).toHaveCount(0);
  });

  // Found by review: a page still loading when you went back to the map finished anyway — under ANOTHER country's
  // panel — and started its anthem in the shared player and announced itself on the map.
  test('leaving a country page that is still loading stops it: it cannot finish under another country', async ({ page }) => {
    test.setTimeout(120000);
    let releaseFrance;
    const franceMayProceed = new Promise((resolve) => { releaseFrance = resolve; });
    // Hold back France's item only (Q142); everything else, Nigeria's included, goes through at once.
    await page.route('**/www.wikidata.org/w/api.php**ids=Q142**', async (route) => { await franceMayProceed; await route.continue(); });

    await page.goto('/#/country/FRA');
    await page.waitForFunction(() => window.__worldMap?.isReady());
    await page.evaluate(() => { window.location.hash = '#/'; }); // back to the map while France is still loading
    await expect(page.locator('#view-map')).toBeVisible();
    await page.evaluate(() => window.__worldMap.selectCountry('NGA', { animate: false }));
    await expect(page.locator('.panel-name')).toHaveText('Nigeria (NGA)');
    await expect(page.locator('.panel-facts')).toContainText('Abuja', { timeout: 60000 });

    releaseFrance(); // France's page would now finish loading…
    await page.waitForTimeout(8000);
    await expect(page.locator('#live-region')).not.toContainText('France country page loaded'); // …but it was cancelled
    const sources = await page.locator('#anthem-player-root audio source').evaluateAll((els) => els.map((el) => el.src).join(' '));
    expect(sources).not.toContain('Marseillaise'); // France's anthem did not take over the shared player

    // and the next visit to France's page is a fresh, complete load
    await page.evaluate(() => { window.location.hash = '#/country/FRA'; });
    await page.waitForSelector('.country-section#population', { timeout: 60000 });
    await expect(page.locator('.country-header-name')).toHaveText('France (FRA)');
  });

  test.describe('third-party scripts failing to load', () => {
    // A CDN outage usually takes the stylesheet and the script together: a failed stylesheet used to be remembered
    // as loaded, so Try again built the map without its CSS.
    test('a map that cannot load says so in its place, the rest of the page still renders, and Try again brings it back — styled', async ({ page }) => {
      const blocked = ['**/unpkg.com/leaflet@1.9.4/dist/leaflet.js', '**/unpkg.com/leaflet@1.9.4/dist/leaflet.css'];
      for (const pattern of blocked) await page.route(pattern, (route) => route.abort());
      await openCountryPage(page, 'FRA');
      await expect(page.locator('#country-map-mount .error-retry')).toContainText(/map could not be loaded/i, { timeout: 45000 });
      await expect(page.locator('#pyramid-mount canvas')).toHaveCount(1, { timeout: 60000 }); // not aborted by the map failing

      for (const pattern of blocked) await page.unroute(pattern); // a failed load is not remembered
      await page.locator('#country-map-mount .error-retry-btn').click();
      await expect(page.locator('#country-map-mount .country-leaflet-map')).toHaveCount(1, { timeout: 30000 });
      await expect(page.locator('#country-map-mount .leaflet-container')).toHaveCSS('overflow', 'hidden'); // leaflet.css is really applied
    });

    // The script downloads fine but is not a working Chart.js (a CDN error page served as script).
    test('a chart script that loads but does not work says so, and Try again downloads it afresh', async ({ page }) => {
      await page.route('**/cdn.jsdelivr.net/npm/chart.js@**', (route) => route.fulfill({ contentType: 'text/javascript', body: 'window.Chart = function () { throw new Error("broken chart"); };' }));
      await openCountryPage(page, 'FRA');
      await expect(page.locator('#pyramid-mount .error-retry')).toContainText(/chart could not be drawn/i, { timeout: 60000 });
      await expect(page.locator('#live-region')).toContainText(/country page loaded/i, { timeout: 30000 }); // the rest of the page finished

      await page.unroute('**/cdn.jsdelivr.net/npm/chart.js@**');
      await page.locator('#pyramid-mount .error-retry-btn').click();
      await expect(page.locator('#pyramid-mount canvas')).toHaveCount(1, { timeout: 30000 });
    });

    test('a chart that cannot load says so, and Try again draws it', async ({ page }) => {
      await page.route('**/cdn.jsdelivr.net/npm/chart.js@**', (route) => route.abort());
      await openCountryPage(page, 'FRA');
      await expect(page.locator('#pyramid-mount .error-retry')).toContainText(/chart could not be loaded/i, { timeout: 60000 });

      await page.unroute('**/cdn.jsdelivr.net/npm/chart.js@**');
      await page.locator('#pyramid-mount .error-retry-btn').click();
      await expect(page.locator('#pyramid-mount canvas')).toHaveCount(1, { timeout: 30000 });
    });
  });
});

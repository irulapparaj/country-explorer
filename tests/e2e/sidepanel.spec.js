import { test, expect } from '@playwright/test';

async function openPanelFor(page, iso3) {
  await page.goto('/');
  await page.waitForFunction(() => window.__worldMap?.isReady());
  await page.evaluate((code) => window.__worldMap.selectCountry(code, { animate: false }), iso3);
  await page.waitForSelector('.panel-facts', { timeout: 15000 });
}

test.describe('side panel', () => {
  test('opens with real data and a working "More details" link to the country page', async ({ page }) => {
    await openPanelFor(page, 'FRA');
    await expect(page.locator('.panel-name')).toHaveText('France (FRA)');
    await expect(page.locator('.panel-facts')).toContainText('Paris');
    const href = await page.locator('.panel-more-link').getAttribute('href');
    expect(href).toBe('#/country/FRA');
  });

  test('the currency fact shows every currency, not just one (France: Euro and CFP Franc)', async ({ page }) => {
    await openPanelFor(page, 'FRA');
    await expect(page.locator('.panel-facts')).toContainText('Euro, CFP Franc');
  });

  test('fullscreen expands the panel and the button toggles back', async ({ page }) => {
    await openPanelFor(page, 'FRA');
    const panel = page.locator('.side-panel');
    await expect(panel).not.toHaveClass(/fullscreen/);
    await page.locator('.icon-btn[aria-label="Fullscreen"]').click();
    await expect(panel).toHaveClass(/fullscreen/);
    await page.locator('.icon-btn[aria-label="Exit fullscreen"]').click();
    await expect(panel).not.toHaveClass(/fullscreen/);
  });

  test('closing the panel clears the map highlight', async ({ page }) => {
    await openPanelFor(page, 'FRA');
    await expect(page.locator('.country-path[data-iso3="FRA"]')).toHaveClass(/selected/);
    await page.locator('.icon-btn[aria-label="Close panel"]').click();
    await expect(page.locator('.side-panel')).not.toHaveClass(/\bopen\b/);
    await expect(page.locator('.country-path.selected')).toHaveCount(0);
  });

  test('Escape exits fullscreen first, then closes the panel on a second press', async ({ page }) => {
    await openPanelFor(page, 'FRA');
    await page.locator('.icon-btn[aria-label="Fullscreen"]').click();
    await expect(page.locator('.side-panel')).toHaveClass(/fullscreen/);

    await page.keyboard.press('Escape');
    await expect(page.locator('.side-panel')).not.toHaveClass(/fullscreen/);
    await expect(page.locator('.side-panel')).toHaveClass(/\bopen\b/);

    await page.keyboard.press('Escape');
    await expect(page.locator('.side-panel')).not.toHaveClass(/\bopen\b/);
  });

  test('switching to another country while open swaps content without closing the panel', async ({ page }) => {
    await openPanelFor(page, 'FRA');
    await expect(page.locator('.panel-name')).toHaveText('France (FRA)');

    await page.evaluate(() => window.__worldMap.selectCountry('NGA', { animate: false }));
    await expect(page.locator('.panel-name')).toHaveText('Nigeria (NGA)', { timeout: 15000 });
    await expect(page.locator('.side-panel')).toHaveClass(/\bopen\b/);
  });

  test('switching countries stops the anthem rather than letting it keep playing', async ({ page }) => {
    await openPanelFor(page, 'FRA');
    await page.waitForSelector('.anthem-play-btn:not([disabled])', { timeout: 15000 });
    await page.locator('.anthem-play-btn').click();
    await expect(page.locator('.anthem-play-btn')).toHaveAttribute('aria-label', 'Pause anthem');

    await page.evaluate(() => window.__worldMap.selectCountry('NGA', { animate: false }));
    await page.waitForSelector('.panel-name:has-text("Nigeria")');
    // load()'s stop() call is synchronous, but a play() promise still resolving after
    // it can momentarily leave the browser's own .paused bookkeeping mid-flight.
    await expect
      .poll(() => page.evaluate(() => document.querySelector('#anthem-player-root audio')?.paused))
      .toBe(true);
  });

  // The heading now shows the new country's name at once, so "Nigeria is showing" no longer means its data has
  // arrived — and the old anthem used to be stopped only when it did. It must stop the moment the selection
  // changes; if the new country never loads, the old anthem must not play on under its error.
  test('switching countries stops the anthem at once, even when the new country fails to load', async ({ page }) => {
    await openPanelFor(page, 'FRA');
    await page.waitForSelector('.anthem-play-btn:not([disabled])', { timeout: 15000 });
    await page.locator('.anthem-play-btn').click();
    await expect(page.locator('.anthem-play-btn')).toHaveAttribute('aria-label', 'Pause anthem');

    for (const source of ['**/www.wikidata.org/**', '**/query.wikidata.org/**', '**/api.worldbank.org/**']) await page.route(source, (route) => route.abort());
    await page.evaluate(() => window.__worldMap.selectCountry('NGA', { animate: false }));
    await expect(page.locator('.error-retry')).toBeVisible({ timeout: 30000 }); // NGA never loads
    expect(await page.evaluate(() => document.querySelector('#anthem-player-root audio').paused)).toBe(true);
  });

  test('a total data failure shows an error with a working Retry button', async ({ page }) => {
    // Every source down. (Country facts are read from www.wikidata.org's Action API; only the optional
    // extras use query.wikidata.org — both are blocked so this really is a total outage.)
    const sources = ['**/www.wikidata.org/**', '**/query.wikidata.org/**', '**/api.worldbank.org/**'];
    for (const source of sources) await page.route(source, (route) => route.abort());
    await openPanelForNoWait(page, 'FRA');
    await expect(page.locator('.error-retry')).toBeVisible({ timeout: 30000 });

    for (const source of sources) await page.unroute(source);
    await page.locator('.error-retry-btn').click();
    await expect(page.locator('.panel-facts')).toBeVisible({ timeout: 30000 });
  });
});


// Issue 1: "selecting Brazil/Russia, most fields say Not Available". The cause was the Wikidata Query
// Service being throttled, and a failed lookup being remembered for the whole visit. Now Wikidata is read
// through its Action API, transient failures are retried, and anything that still fails is SAID so —
// with a Try again — instead of masquerading as a fact about the country.
test.describe('partial data', () => {
  const noWikidata = async (page) => {
    await page.route('**/www.wikidata.org/**', (route) => route.abort());
    await page.route('**/query.wikidata.org/**', (route) => route.abort());
  };

  test('when Wikidata is unreachable the panel says so and offers Try again, while World Bank data still shows', async ({ page }) => {
    await noWikidata(page);
    await openPanelFor(page, 'BRA');
    await expect(page.locator('.partial-notice')).toBeVisible({ timeout: 45000 });
    await expect(page.locator('.partial-notice')).toContainText('Wikidata');
    await expect(page.locator('.partial-notice .partial-notice-btn')).toBeVisible();
    await expect(page.locator('.panel-facts')).toContainText('people'); // population, from the World Bank
    await expect(page.locator('.panel-name')).toHaveText('Brazil (BRA)');
  });

  test('Try again refetches, and the notice disappears once everything loads', async ({ page }) => {
    await noWikidata(page);
    await openPanelFor(page, 'BRA');
    await expect(page.locator('.partial-notice')).toBeVisible({ timeout: 45000 });

    await page.unroute('**/www.wikidata.org/**');
    await page.unroute('**/query.wikidata.org/**');
    await page.locator('.partial-notice .partial-notice-btn').click();
    await expect(page.locator('.panel-facts')).toContainText('Brasília', { timeout: 60000 });
    await expect(page.locator('.partial-notice')).toHaveCount(0);
  });

  // Found by review: Try again replaced the panel's content, dropping keyboard focus to <body>, and the only
  // announcement was "Brazil selected" — a screen-reader user never heard that details had failed, or whether
  // Try again had worked.
  test('Try again keeps keyboard focus in the panel, and the outcome is announced both ways', async ({ page }) => {
    await noWikidata(page);
    await openPanelFor(page, 'BRA');
    await expect(page.locator('.partial-notice')).toBeVisible({ timeout: 45000 });
    await expect(page.locator('#live-region')).toContainText(/could not be loaded from Wikidata/i);

    await page.unroute('**/www.wikidata.org/**');
    await page.unroute('**/query.wikidata.org/**');
    await page.locator('.partial-notice .partial-notice-btn').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.panel-facts')).toContainText('Brasília', { timeout: 60000 });
    await expect(page.locator('.side-panel')).toBeFocused();
    await expect(page.locator('#live-region')).toContainText(/all details loaded/i);
  });

  test('a failure that heals by itself on a retry never shows the notice at all', async ({ page }) => {
    let refused = 0;
    await page.route('**/www.wikidata.org/w/api.php**', (route) => (refused++ < 2 ? route.abort() : route.continue()));
    await openPanelFor(page, 'BRA');
    await expect(page.locator('.panel-facts')).toContainText('Brasília', { timeout: 60000 });
    await expect(page.locator('.partial-notice')).toHaveCount(0);
    expect(refused).toBeGreaterThan(2);
  });

  test('the World Bank being unreachable is reported too', async ({ page }) => {
    await page.route('**/api.worldbank.org/**', (route) => route.abort());
    await openPanelFor(page, 'BRA');
    await expect(page.locator('.partial-notice')).toContainText('World Bank', { timeout: 60000 });
  });
});

// "India (IND)": the country's name with its three-letter code — including while the data is still
// loading or has failed, when the heading used to fall back to the bare code ("BRA").
test.describe('panel heading shows the name with its code', () => {
  test('immediately, before any data arrives (heading was the bare code)', async ({ page }) => {
    await page.route('**/query.wikidata.org/**', (route) => route.abort());
    await page.route('**/www.wikidata.org/**', (route) => route.abort());
    await page.route('**/api.worldbank.org/**', (route) => route.abort());
    await openPanelForNoWait(page, 'BRA');
    await expect(page.locator('.panel-name')).toHaveText('Brazil (BRA)');
  });

  test('after the data loads, and for other countries', async ({ page }) => {
    await openPanelFor(page, 'IND');
    await expect(page.locator('.panel-name')).toHaveText('India (IND)');
  });
});

// The closed panel is visibility:hidden (no shadow on the map, nothing tabbable inside it), which
// makes the browser drop focus to <body> if it was on a control inside. A keyboard user closing the
// panel must not lose their place.
test.describe('focus after closing the panel', () => {
  const activeClass = (page) => page.evaluate(() => document.activeElement?.className ?? '');

  test('closing with the keyboard (Enter on the close button) returns focus to the search box', async ({ page }) => {
    await openPanelFor(page, 'FRA');
    await page.locator('.icon-btn[aria-label="Close panel"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.side-panel')).not.toHaveClass(/\bopen\b/);
    expect(await activeClass(page)).toContain('search-input');
  });

  test('closing with Escape returns focus to the search box', async ({ page }) => {
    await openPanelFor(page, 'FRA');
    await page.locator('.icon-btn[aria-label="Close panel"]').focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('.side-panel')).not.toHaveClass(/\bopen\b/);
    expect(await activeClass(page)).toContain('search-input');
  });

  test('a mouse close does not steal focus into the search box (no surprise on-screen keyboard on phones)', async ({ page }) => {
    await openPanelFor(page, 'FRA');
    await page.locator('.icon-btn[aria-label="Close panel"]').click();
    await expect(page.locator('.side-panel')).not.toHaveClass(/\bopen\b/);
    expect(await activeClass(page)).not.toContain('search-input');
  });

  test('a closed panel has nothing left in the Tab order', async ({ page }) => {
    await openPanelFor(page, 'FRA');
    await page.locator('.icon-btn[aria-label="Close panel"]').click();
    await expect(page.locator('.side-panel')).toHaveCSS('visibility', 'hidden');
    const focusable = await page.locator('.side-panel').evaluate((el) => el.querySelectorAll('button, a[href]').length);
    expect(focusable).toBeGreaterThan(0); // they exist...
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.side-panel'))).toBe(false); // ...but are not reachable
  });
});

// Item 7: the panel used to be 560px (39% of a 1440px screen) and hid the map behind it.
test.describe('compact side panel', () => {
  test('on desktop it takes about a quarter of the width or less, leaving the map visible', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openPanelFor(page, 'FRA');
    const box = await page.locator('.side-panel').boundingBox();
    expect(box.width).toBeLessThanOrEqual(360);
    expect(box.width / 1440).toBeLessThan(0.26);
  });

  test('on a mid-size laptop it never exceeds a third of the screen', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await openPanelFor(page, 'FRA');
    const box = await page.locator('.side-panel').boundingBox();
    expect(box.width / 1024).toBeLessThan(0.34);
  });

  test('the compact panel still shows every key fact and the "More details" button without horizontal scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openPanelFor(page, 'FRA');
    await expect(page.locator('.panel-more-link')).toBeVisible();
    for (const label of ['Official name', 'Capital', 'Continent', 'Population', 'Area', 'Languages', 'Currency', 'Time zone(s)']) {
      await expect(page.locator('.panel-facts dt', { hasText: label })).toBeVisible();
    }
    const overflow = await page.locator('.panel-inner').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('on a 375px phone the bottom sheet covers at most about half the screen', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await openPanelFor(page, 'FRA');
    const box = await page.locator('.side-panel').boundingBox();
    expect(box.height / 667).toBeLessThanOrEqual(0.52);
    await expect(page.locator('.panel-more-link')).toBeVisible();
  });

  test('on a phone the selected country is centered in the map above the sheet, not under it', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await openPanelFor(page, 'BRA');
    await expect(page.locator('.side-panel')).toHaveClass(/\bopen\b/);
    const { sheetTop, y } = await page.evaluate(() => ({
      sheetTop: document.querySelector('.side-panel').getBoundingClientRect().top,
      y: window.__worldMap.toScreen(-53, -10).y,
    }));
    expect(y).toBeLessThan(sheetTop);
  });

  test('fullscreen still expands the compact panel to the whole window', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openPanelFor(page, 'FRA');
    await page.locator('.icon-btn[aria-label="Fullscreen"]').click();
    await expect.poll(async () => (await page.locator('.side-panel').boundingBox()).width).toBeGreaterThan(1400);
  });
});

async function openPanelForNoWait(page, iso3) {
  await page.goto('/');
  await page.waitForFunction(() => window.__worldMap?.isReady());
  await page.evaluate((code) => window.__worldMap.selectCountry(code, { animate: false }), iso3);
}

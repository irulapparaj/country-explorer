import { test, expect } from '@playwright/test';

test.describe('accessibility', () => {
  test('every icon-only button has an accessible name', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__worldMap?.isReady());
    await page.evaluate(() => window.__worldMap.selectCountry('FRA', { animate: false }));
    await page.waitForSelector('.panel-facts', { timeout: 20000 });

    const buttons = page.locator('.map-hud-btn, .icon-btn, .anthem-play-btn, .search-clear');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const label = await buttons.nth(i).getAttribute('aria-label');
      expect(label, `button #${i} has no aria-label`).toBeTruthy();
    }
  });

  test('a full keyboard-only flow selects a country via search with no mouse', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__worldMap?.isReady());

    await page.locator('.search-input').focus();
    await page.keyboard.type('Nigeria');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    await expect(page.locator('.country-path[data-iso3="NGA"]')).toHaveClass(/selected/);
    await page.waitForSelector('.panel-facts', { timeout: 20000 });
    await expect(page.locator('.panel-name')).toHaveText('Nigeria (NGA)');
  });

  // Deliberate design choice (240 individual Tab stops to reach e.g. Australia is a
  // known anti-pattern for choropleth maps): country shapes are mouse/touch-clickable
  // but not part of the Tab order at all. This also regression-guards a real bug found
  // live — role="img" on the map SVG made browsers prune every descendant, including
  // paths with an explicit tabindex, from the focus tree entirely.
  test('country shapes are not part of the Tab order; the search box is the documented keyboard path to any country', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__worldMap?.isReady());

    const tabIndex = await page.locator('.country-path[data-iso3="FRA"]').evaluate((el) => el.tabIndex);
    expect(tabIndex).toBe(-1);
    await expect(page.locator('svg.world-map-svg')).toHaveAttribute('aria-label', /search box/i);
  });

  test('focused elements show a visible focus outline', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__worldMap?.isReady());

    // The map's HUD button relies on the global :focus-visible outline (reset.css).
    await page.locator('.map-hud-btn').first().focus();
    const hudOutline = await page.locator('.map-hud-btn').first().evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(hudOutline).not.toBe('none');

    // The search input deliberately turns off its own outline and instead relies on
    // its *wrapper's* :focus-within box-shadow ring — check the element the visible
    // effect actually renders on, not the input itself (which has no outline by design).
    await page.locator('.search-input').focus();
    const wrapShadow = await page.locator('.search-input-wrap').evaluate((el) => getComputedStyle(el).boxShadow);
    expect(wrapShadow).not.toBe('none');
  });

  test('reduced motion disables the map zoom animation duration', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.waitForFunction(() => window.__worldMap?.isReady());
    await page.evaluate(() => window.__worldMap.selectCountry('FRA')); // animate defaults true, but reduced-motion should override it
    // If the transition were animated (400ms), the scale would still be mid-flight
    // immediately after the call; under reduced motion it should already be final.
    const scale = await page.evaluate(() => window.__worldMap.getTransform().k);
    expect(scale).toBeGreaterThan(1);
  });

  test('reduced motion swaps the off-map marker pulse for a static ring', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.waitForFunction(() => window.__worldMap?.isReady());
    await page.evaluate(() => window.__worldMap.selectCountry('VAT', { animate: false }));
    const animationName = await page.locator('.off-map-ring').evaluate((el) => getComputedStyle(el).animationName);
    expect(animationName).toBe('none');
  });

  test('the world map SVG uses role="group", not role="img"', async ({ page }) => {
    // role="img" is the specific bug this regression-guards against: it makes browsers
    // treat the whole SVG as one atomic leaf and prune every descendant — including
    // anything with its own tabindex — from the accessibility/focus tree.
    await page.goto('/');
    await page.waitForFunction(() => window.__worldMap?.isReady());
    await expect(page.locator('svg.world-map-svg')).toHaveAttribute('role', 'group');
  });
  test.describe('map options controls', () => {
    test('each control group is a named, native radio group or checkbox', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.__worldMap?.isReady());
      await expect(page.getByRole('radiogroup', { name: 'Map style' })).toBeVisible();
      await expect(page.getByRole('radiogroup', { name: 'Names' })).toBeVisible();
      await expect(page.getByRole('checkbox', { name: 'Grid and coordinates' })).toBeVisible();
      await expect(page.getByRole('checkbox', { name: 'Ocean and sea names' })).toBeVisible();
    });

    test('the map style can be changed with the keyboard alone (arrow keys move the choice)', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.__worldMap?.isReady());
      await page.getByRole('radio', { name: 'Political' }).focus();
      await page.keyboard.press('ArrowRight');
      await expect(page.getByRole('radio', { name: 'Geographic' })).toBeChecked();
      await expect(page.locator('svg.world-map-svg')).toHaveAttribute('data-map-mode', 'geographic');
      await page.keyboard.press('ArrowRight');
      await expect(page.getByRole('radio', { name: 'Elevation' })).toBeChecked();
    });

    test('a focused option shows a visible focus indicator', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.__worldMap?.isReady());
      await page.keyboard.press('Tab'); // skip link
      await page.getByRole('radio', { name: 'Political' }).focus();
      const style = await page.locator('.seg-option', { hasText: 'Political' }).evaluate((el) => {
        const s = getComputedStyle(el);
        return { outline: s.outlineStyle, shadow: s.boxShadow };
      });
      expect(style.outline !== 'none' || style.shadow !== 'none').toBe(true);
    });

    test('the elevation key is exposed to assistive tech as a labeled list', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.__worldMap?.isReady());
      await page.locator('.seg-option', { hasText: 'Elevation' }).click();
      const legend = page.locator('.map-legend');
      await expect(legend).toHaveAttribute('aria-label', /elevation/i);
      expect(await legend.getByRole('listitem').count()).toBeGreaterThanOrEqual(11);
    });

    test('the decorative overlays do not add tab stops or block the search box', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.__worldMap?.isReady());
      const stops = await page.evaluate(() => [...document.querySelectorAll('.frame-lat-label, .frame-lon-label, .frame-line-chip, .water-label, .continent-label')].filter((el) => el.tabIndex >= 0).length);
      expect(stops).toBe(0);
      await page.locator('.search-input').fill('Nigeria'); // not covered by any overlay
      await expect(page.locator('.search-option', { hasText: 'Nigeria' })).toBeVisible();
    });
  });
});

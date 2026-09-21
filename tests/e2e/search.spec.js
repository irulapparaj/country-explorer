import { test, expect } from '@playwright/test';
import { waitForCameraToSettle } from './helpers.js';

async function search(page, query) {
  await page.goto('/');
  await page.waitForFunction(() => window.__worldMap?.isReady());
  await page.locator('.search-input').fill(query);
}

test.describe('search', () => {
  test('a typo ("Indai") still fuzzy-matches India', async ({ page }) => {
    await search(page, 'Indai');
    await expect(page.locator('.search-option', { hasText: 'India' })).toBeVisible();
  });

  test('common abbreviations resolve to the right country: USA, UK, Ivory Coast', async ({ page }) => {
    await search(page, 'USA');
    await expect(page.locator('.search-option', { hasText: 'United States' })).toBeVisible();

    await search(page, 'UK');
    await expect(page.locator('.search-option', { hasText: 'United Kingdom' })).toBeVisible();

    await search(page, 'Ivory Coast');
    await expect(page.locator('.search-option', { hasText: 'Ivory Coast' })).toBeVisible();
  });

  test('Burma and Türkiye resolve to Myanmar and Turkey', async ({ page }) => {
    await search(page, 'Burma');
    await expect(page.locator('.search-option', { hasText: 'Myanmar' })).toBeVisible();

    await search(page, 'Turkiye');
    await expect(page.locator('.search-option', { hasText: 'Turkey' })).toBeVisible();
  });

  test('selecting a result highlights and zooms exactly like a map click', async ({ page }) => {
    await search(page, 'France');
    await page.locator('.search-option', { hasText: 'France' }).click();
    await expect(page.locator('.country-path[data-iso3="FRA"]')).toHaveClass(/selected/);
    // Unlike the WorldMap-only tests, this goes through the real search UI with no
    // animate:false override, so the 400ms zoom transition may still be in flight —
    // poll instead of reading the transform exactly once, immediately after the click.
    await expect
      .poll(() => page.evaluate(() => window.__worldMap.getTransform().k))
      .toBeGreaterThan(1);
  });

  test('keyboard navigation: arrow down then Enter selects a result', async ({ page }) => {
    await search(page, 'United');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const selected = await page.locator('.country-path.selected').getAttribute('data-iso3');
    expect(['USA', 'GBR', 'ARE']).toContain(selected);
  });

  test('Escape closes the results dropdown', async ({ page }) => {
    await search(page, 'France');
    await expect(page.locator('.search-listbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.search-listbox')).toBeHidden();
  });

  test('Vatican City has no drawn shape at world zoom — search flies to it and shows a pulsing marker', async ({ page }) => {
    await search(page, 'Vatican City');
    await page.locator('.search-option', { hasText: 'Vatican City' }).click();
    await expect(page.locator('.off-map-marker')).toBeVisible();
    await expect(page.locator('.off-map-label')).toHaveText('Vatican City');
    // clicking the marker reopens the panel (same onSelect callback as any other selection)
    // — click the non-animating dot, not the perpetually-pulsing ring, since Playwright's
    // actionability check waits for the target to stop moving before clicking it.
    await page.locator('.off-map-dot').click();
    await expect(page.locator('#side-panel-mount')).toContainText('VAT');
  });

  test('Tuvalu is entirely absent from the drawn topology — search still flies to it with a marker', async ({ page }) => {
    await search(page, 'Tuvalu');
    await page.locator('.search-option', { hasText: 'Tuvalu' }).click();
    await expect(page.locator('.off-map-marker')).toBeVisible();
    await expect(page.locator('.off-map-label')).toHaveText('Tuvalu');
  });

  test('a near-miss typo offers a "did you mean" suggestion that is itself selectable', async ({ page }) => {
    await search(page, 'Frnace');
    await expect(page.locator('.search-message')).toContainText('Did you mean');
    await page.locator('.search-suggestion-btn').click();
    await expect(page.locator('.country-path[data-iso3="FRA"]')).toHaveClass(/selected/);
  });

  test('a nonsense query shows "no matching country found"', async ({ page }) => {
    await search(page, 'zzzxxqqnotacountry');
    await expect(page.locator('.search-message')).toContainText('No matching country found');
  });
  // The combobox announces its state through aria-expanded / aria-activedescendant. These used
  // to be reset only by closeResults(), so a screen reader kept hearing an open list and a
  // highlighted option that were no longer there.
  test.describe('combobox ARIA state stays truthful', () => {
    test('moving from a results list to "did you mean" or "no match" collapses the list and its state', async ({ page }) => {
      await search(page, 'Fra');
      await expect(page.locator('.search-option').first()).toBeVisible();
      await expect(page.locator('.search-input')).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('.search-input')).toHaveAttribute('aria-activedescendant', /search-option-\d/);

      await page.locator('.search-input').fill('nzzzq');
      await expect(page.locator('.search-message')).toContainText(/no matching country/i);
      await expect(page.locator('.search-input')).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('.search-input')).not.toHaveAttribute('aria-activedescendant', /.+/);
      await expect(page.locator('#search-listbox .search-option')).toHaveCount(0);
    });

    test('typing after arrowing onto an option no longer points aria-activedescendant at the old option', async ({ page }) => {
      await search(page, 'Fra');
      await expect(page.locator('.search-option').first()).toBeVisible();
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('.search-input')).toHaveAttribute('aria-activedescendant', /search-option-\d/);
      await page.keyboard.type('n');
      await expect(page.locator('.search-input')).not.toHaveAttribute('aria-activedescendant', /.+/);
    });
  });
  // Selecting on the map must be reflected in the search box, replacing whatever was there.
  test.describe('the search box follows the selection', () => {
    const inputValue = (page) => page.locator('.search-input').inputValue();

    test('clicking a country on the map puts its name in the search box, replacing older text', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.__worldMap?.isReady());
      await page.locator('.search-input').fill('France');
      await page.locator('.search-option', { hasText: 'France' }).click();
      await expect.poll(() => inputValue(page)).toBe('France');
      await waitForCameraToSettle(page); // the fly-to France is still animating: a screen position now would be stale

      const spot = await page.evaluate(() => window.__worldMap.toScreen(-53, -10)); // Brazil, on the map
      await page.mouse.click(spot.x, spot.y);
      await expect.poll(() => inputValue(page)).toBe('Brazil');
    });

    test('the sequence of map clicks each overrides the previous name', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.__worldMap?.isReady());
      for (const [name, lng, lat] of [['Brazil', -53, -10], ['Argentina', -64, -34], ['Bolivia', -64.5, -17]]) {
        await waitForCameraToSettle(page); // each click flies the camera; wait before aiming the next one
        const spot = await page.evaluate(([a, b]) => window.__worldMap.toScreen(a, b), [lng, lat]);
        await page.mouse.click(spot.x, spot.y);
        await expect.poll(() => inputValue(page)).toBe(name);
      }
    });

    // Found by review: clicking the country that was already selected changes no state, so nothing rewrote the
    // box and text typed since stayed there.
    test('clicking the country that is already selected puts its name back over text typed since', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.__worldMap?.isReady());
      const clickBrazil = async () => {
        await waitForCameraToSettle(page);
        const spot = await page.evaluate(() => window.__worldMap.toScreen(-53, -10));
        await page.mouse.click(spot.x, spot.y);
      };
      await clickBrazil();
      await expect.poll(() => inputValue(page)).toBe('Brazil');
      await page.locator('.search-input').fill('zzz');
      await clickBrazil();
      await expect.poll(() => inputValue(page)).toBe('Brazil');
    });

    test('a leftover dropdown or clear button does not survive a map selection', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.__worldMap?.isReady());
      await page.locator('.search-input').fill('Ind');
      await expect(page.locator('.search-option').first()).toBeVisible();
      const spot = await page.evaluate(() => window.__worldMap.toScreen(-53, -10));
      await page.mouse.click(spot.x, spot.y);
      await expect.poll(() => inputValue(page)).toBe('Brazil');
      await expect(page.locator('#search-listbox')).toBeHidden();
      await expect(page.locator('.search-clear')).toBeVisible(); // there is text now, so it can be cleared
    });

    test('closing the panel clears the name it had put there, but not text the user typed', async ({ page }) => {
      await page.goto('/');
      await page.waitForFunction(() => window.__worldMap?.isReady());
      // (re-derived each time: the map has zoomed since the last click, so an old screen point is stale)
      const clickBrazil = async () => {
        await waitForCameraToSettle(page);
        const spot = await page.evaluate(() => window.__worldMap.toScreen(-53, -10));
        await page.mouse.click(spot.x, spot.y);
      };
      await clickBrazil();
      await expect.poll(() => inputValue(page)).toBe('Brazil');
      await page.locator('.icon-btn[aria-label="Close panel"]').click();
      await expect.poll(() => inputValue(page)).toBe('');

      await clickBrazil();
      await expect.poll(() => inputValue(page)).toBe('Brazil');
      await page.locator('.search-input').fill('Braz'); // the user is now typing their own query
      await page.locator('.icon-btn[aria-label="Close panel"]').click();
      await expect.poll(() => inputValue(page)).toBe('Braz');
    });

    test('opening a country page directly also names it in the search box (seen when you go back to the map)', async ({ page }) => {
      await page.goto('/#/country/IND');
      await page.waitForFunction(() => window.__worldMap?.isReady());
      await page.evaluate(() => { window.location.hash = '#/'; });
      await expect(page.locator('#view-map')).toBeVisible();
      await expect.poll(() => inputValue(page)).toBe('India');
    });
  });
});

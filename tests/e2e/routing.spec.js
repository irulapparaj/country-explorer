import { test, expect } from '@playwright/test';

test('loads the map view by default with no console errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/');

  await expect(page.locator('#view-map')).toBeVisible();
  await expect(page.locator('#view-country')).toBeHidden();
  expect(errors).toEqual([]);
});

test('navigating to a country hash swaps to the country view', async ({ page }) => {
  await page.goto('/#/country/IND');

  await expect(page.locator('#view-country')).toBeVisible();
  await expect(page.locator('#view-map')).toBeHidden();
});

test('browser back returns from a country route to the map view', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    window.location.hash = '#/country/FRA';
  });
  await expect(page.locator('#view-country')).toBeVisible();

  await page.goBack();

  await expect(page.locator('#view-map')).toBeVisible();
  await expect(page.locator('#view-country')).toBeHidden();
});

import { expect } from '@playwright/test';

// Shared helpers for map E2E specs. These lean on the dev/E2E hooks WorldMap exposes via
// window.__worldMap (project, toScreen, isGeoPointInView, getOptions, setOptions...).

export async function openMap(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__worldMap?.isReady());
}

/** Clicks a segmented-control option (a real <label>) the way a user would. */
export async function chooseOption(page, groupName, optionLabel) {
  await page
    .getByRole('radiogroup', { name: groupName })
    .locator('label', { hasText: optionLabel })
    .click();
}

/**
 * Reads real rendered pixels (CSS px coordinates) out of a page screenshot. Used by the
 * regression tests that must assert on what the user SEES (e.g. no ocean-colored gap
 * between two countries), which no DOM query can prove.
 */
export async function readPixels(page, points) {
  const png = await page.screenshot();
  return page.evaluate(
    async ({ b64, points: pts }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const ratio = img.width / window.innerWidth;
      return pts.map(({ x, y }) => Array.from(ctx.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data));
    },
    { b64: png.toString('base64'), points }
  );
}

/** The rendered [r, g, b] of a CSS color (resolves oklch()/var() through a canvas). */
export async function cssColorToRgb(page, selector, property) {
  return page.evaluate(
    ({ sel, prop }) => {
      const value = getComputedStyle(document.querySelector(sel))[prop];
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
    },
    { sel: selector, prop: property }
  );
}

export const colorDistance = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

/**
 * Waits until the map camera has stopped moving. A selection animates the camera for ~400ms, and the
 * screen position of a country computed DURING that animation is wrong by the time a click arrives —
 * whatever is under the point at that instant gets clicked instead. (Chromium's timing hid this;
 * WebKit and Firefox did not.)
 */
export async function waitForCameraToSettle(page) {
  let previous = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await page.evaluate(() => window.__worldMap.getTransform()));
        const unchanged = now === previous;
        previous = now;
        return unchanged;
      },
      { intervals: [120], timeout: 8000 }
    )
    .toBe(true);
}

/**
 * Latency baseline — measures perceived performance timings for panel and country page,
 * records p50/p95 for Brazil, Russia, India and Vatican City. Run after each optimisation phase to
 * track progress against the targets stated in data/plans/latency-optimization.md.
 *
 * Phase 1+2 results (chromium, 3 runs):
 *   page first section p50  ~28–34ms  ✓  (target < 1 000ms; was ~200–400ms before Phase 1)
 *   page complete      p50  ~31–41ms  ✓  (target < 4 000ms)
 *   panel first fact   p50  ~2.8–3.3s ✗  (target < 1 500ms; unchanged — WB batching blocked by CORS)
 *
 * Phase 2 note: The World Bank sources/2 batch endpoint lacks Access-Control-Allow-Origin headers
 * and cannot be used from a browser. The per-indicator endpoint (v2/country/…/indicator/…) has
 * CORS enabled and remains the only viable option.
 *
 * Targets (from the plan):
 *   panel first fact  < 1 500 ms at p50
 *   page first section <  1 000 ms at p50  (summary already cached from the panel open)
 *   page complete      <  4 000 ms at p50
 *
 * This spec is intentionally slow — it reloads the page for every run to avoid cache effects.
 * Control how many runs are collected with the PERF_RUNS environment variable (default 3).
 * Run it on its own to avoid race-limiting from the other E2E specs:
 *
 *   PERF_RUNS=5 npx playwright test tests/e2e/perf.spec.js --workers=1
 */
import { test } from '@playwright/test';

const COUNTRIES = ['BRA', 'RUS', 'IND', 'VAT'];
const RUNS = Math.max(1, parseInt(process.env.PERF_RUNS ?? '3', 10));

// Targets from data/plans/latency-optimization.md
const TARGET_PANEL_FIRST_FACT_P50 = 1500;
const TARGET_PAGE_FIRST_SECTION_P50 = 1000;
const TARGET_PAGE_COMPLETE_P50 = 4000;

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

// Wait for whichever selector appears first (all comma-joined → browser handles it natively).
async function waitForAny(page, selector, timeout) {
  return page.waitForSelector(selector, { timeout });
}

test.describe('latency baseline (Phase 1+2)', () => {
  // Per-test timeout: generous per run plus headroom for the page boot.
  test.setTimeout(90_000 * RUNS + 30_000);

  for (const iso3 of COUNTRIES) {
    test(`${iso3} — panel and page timings (${RUNS} run${RUNS > 1 ? 's' : ''})`, async ({ page }) => {
      const panelFirstFact = [];
      const panelComplete = [];
      const pageFirstSection = [];
      const pageComplete = [];

      for (let run = 0; run < RUNS; run++) {
        // Fresh page load so every run measures a cold fetch (no in-memory data-service cache).
        await page.goto('/');
        await page.waitForFunction(() => window.__worldMap?.isReady(), { timeout: 20_000 });

        // ── Panel timings ────────────────────────────────────────────────────────────
        const t0panel = Date.now();
        await page.evaluate((code) => window.__worldMap.selectCountry(code, { animate: false }), iso3);

        // panel: first fact — .panel-facts appears once getCountrySummary resolves.
        await waitForAny(page, '.panel-facts, .error-retry', 20_000);
        panelFirstFact.push(Date.now() - t0panel);

        // panel: complete — anthem player mounted (even if disabled), or partial/error notice.
        // .anthem-play-btn is rendered synchronously after .panel-facts via a microtask.
        await waitForAny(page, '.anthem-play-btn, .partial-notice, .error-retry', 40_000);
        panelComplete.push(Date.now() - t0panel);

        // ── Country page timings  (summary already cached from the panel open above) ──
        // Navigate via the "More details" link so the data-service cache is warm.
        await page.click('.panel-more-link');

        const t0page = Date.now();

        // page: first section — any .country-section in the DOM.
        await waitForAny(page, '.country-section, .error-retry', 30_000);
        pageFirstSection.push(Date.now() - t0page);

        // page: complete — the population section (last section) is present.
        await waitForAny(page, '.country-section#population, .error-retry', 60_000);
        pageComplete.push(Date.now() - t0page);
      }

      // ── Print results ────────────────────────────────────────────────────────────
      const report = {
        'panel first fact  p50': pct(panelFirstFact, 50),
        'panel first fact  p95': pct(panelFirstFact, 95),
        'panel complete    p50': pct(panelComplete, 50),
        'panel complete    p95': pct(panelComplete, 95),
        'page first section p50': pct(pageFirstSection, 50),
        'page first section p95': pct(pageFirstSection, 95),
        'page complete     p50': pct(pageComplete, 50),
        'page complete     p95': pct(pageComplete, 95),
      };

      // Log as a compact block so it is easy to copy into a spreadsheet.
      console.log(`\n════ ${iso3} latency baseline (ms, ${RUNS} run${RUNS > 1 ? 's' : ''}) ════`);
      for (const [key, val] of Object.entries(report)) {
        const target =
          key.startsWith('panel first fact  p50') ? TARGET_PANEL_FIRST_FACT_P50 :
          key.startsWith('page first section p50') ? TARGET_PAGE_FIRST_SECTION_P50 :
          key.startsWith('page complete     p50') ? TARGET_PAGE_COMPLETE_P50 : null;
        const flag = target != null ? (val <= target ? ' ✓' : ` ✗  (target: ${target})`) : '';
        console.log(`  ${key.padEnd(25)} ${String(val).padStart(5)}${flag}`);
      }

      // ── Assertions — the p50 targets are the goals for later phases, not current
      // guarantees.  We only hard-fail on a catastrophic regression (10× the target).
      // Update these to the real targets once all phases are done.
      const CATASTROPHIC = 10;
      const assert = await import('node:assert/strict');
      assert.default.ok(
        pct(panelFirstFact, 50) < TARGET_PANEL_FIRST_FACT_P50 * CATASTROPHIC,
        `${iso3} panel first fact p50 is catastrophically slow`,
      );
      assert.default.ok(
        pct(pageComplete, 50) < TARGET_PAGE_COMPLETE_P50 * CATASTROPHIC,
        `${iso3} page complete p50 is catastrophically slow`,
      );
    });
  }
});

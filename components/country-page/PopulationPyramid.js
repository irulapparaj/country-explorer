import { loadScript, forgetScript, prefersReducedMotion } from '../../lib/domUtils.js';
import { createErrorRetry } from '../shared/ErrorRetry.js';

const CHART_JS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.js';
const BAND_LABELS = {
  '0004': '0-4', '0509': '5-9', '1014': '10-14', '1519': '15-19', '2024': '20-24',
  '2529': '25-29', '3034': '30-34', '3539': '35-39', '4044': '40-44', '4549': '45-49',
  '5054': '50-54', '5559': '55-59', '6064': '60-64', '6569': '65-69', '7074': '70-74',
  '7579': '75-79', '80UP': '80+',
};

let chartInstance = null;

// Three different reasons there may be nothing to draw, each said plainly: a bare "Not available" made
// a busy service look like a fact about the country.
function pyramidMessage(status, countryName) {
  const place = countryName || 'this country';
  if (status === 'failed') return 'The age-by-sex data could not be loaded just now. Use “Try again” at the top of the page.';
  return `No age-by-sex breakdown is published for ${place}. The World Bank, this page's source for population by age and sex, has none for it.`;
}

/**
 * Renders the population pyramid (male left / female right, by 5-year age band) into
 * a fresh <canvas> inside `container`. Destroys any previous chart instance first —
 * Chart.js throws if you re-render onto a canvas it's already attached to.
 * @param {HTMLElement} container
 * @param {Array<{band: string, male: {value:number,year:number}|null, female: {value:number,year:number}|null}>} pyramid
 * @param {{status?: 'ok' | 'no-data' | 'failed', countryName?: string}} [context]
 */
export async function renderPopulationPyramid(container, pyramid, { status = 'ok', countryName } = {}) {
  container.replaceChildren();
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  if (status !== 'ok' || !pyramid || pyramid.length === 0) {
    const note = document.createElement('p');
    note.className = 'pyramid-note';
    note.textContent = pyramidMessage(status === 'ok' ? 'no-data' : status, countryName);
    container.appendChild(note);
    return;
  }
  try {
    await loadScript(CHART_JS_URL);
  } catch {
    // The chart library (a third-party script) did not load: say so, with a way to try again, instead of
    // leaving an empty box — or letting the failure abort the rest of the page.
    container.replaceChildren(createErrorRetry('The chart could not be loaded just now.', () => renderPopulationPyramid(container, pyramid, { status, countryName })));
    return;
  }
  if (!container.isConnected) return; // the page was rebuilt while the library loaded: drawing now would orphan a chart
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Population pyramid by age band and sex');
  container.appendChild(canvas);

  const labels = pyramid.map((row) => BAND_LABELS[row.band] || row.band);
  const male = pyramid.map((row) => (row.male ? -row.male.value : null));
  const female = pyramid.map((row) => (row.female ? row.female.value : null));

  if (chartInstance) chartInstance.destroy();
  try {
    chartInstance = drawChart(canvas, labels, male, female);
  } catch {
    // The script "loaded" but is not a working Chart.js (an error page served as script, a blocked global): say so, with
    // a way to try again, rather than leave an empty canvas — or let the failure abort the rest of the page.
    chartInstance = null;
    forgetScript(CHART_JS_URL); // so that Try again downloads it afresh instead of re-running the same broken script
    container.replaceChildren(createErrorRetry('The chart could not be drawn just now.', () => renderPopulationPyramid(container, pyramid, { status, countryName })));
  }
}

function drawChart(canvas, labels, male, female) {
  return new window.Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Male', data: male, backgroundColor: 'oklch(70% 0.11 195)' },
        { label: 'Female', data: female, backgroundColor: 'oklch(53% 0.21 30)' },
      ],
    },
    options: {
      indexAxis: 'y',
      animation: prefersReducedMotion() ? false : undefined,
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          stacked: true,
          ticks: { callback: (v) => Math.abs(v).toLocaleString() },
        },
        y: { stacked: true },
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${Math.abs(ctx.parsed.x).toLocaleString()}`,
          },
        },
      },
    },
  });
}

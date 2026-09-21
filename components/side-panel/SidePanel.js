import { getState, setState, subscribe } from '../../lib/store.js';
import { getCountrySummary } from '../../lib/dataService.js';
import { countryHash } from '../../lib/router.js';
import { createEl, prefersReducedMotion, announce } from '../../lib/domUtils.js';
import { formatStat, formatArea, formatList, orNotAvailable, formatCountryTitle } from '../../lib/format.js';
import { peekEntryByIso3 } from '../../lib/searchIndex.js';
import { createSkeleton } from '../shared/LoadingSkeleton.js';
import { createErrorRetry, createNotFound } from '../shared/ErrorRetry.js';
import { createPartialDataNotice, describeLoadOutcome } from '../shared/PartialDataNotice.js';
import * as AnthemPlayer from '../anthem-player/AnthemPlayer.js';

/**
 * Mounts the quick-summary side panel into `container`. Purely store-driven: it
 * subscribes to selectedIso3/panelOpen/fullscreen and renders accordingly, so a map
 * click, a search selection, or a direct `#/country/X` deep link all drive the same
 * panel through the same state, with no separate code path per trigger.
 * @param {HTMLElement} container
 */
export function createSidePanel(container) {
  let lastRenderedIso3 = null;
  let requestToken = 0;

  const panel = createEl('aside', { className: 'side-panel', attrs: { 'aria-label': 'Country summary', tabindex: '-1' } });
  container.appendChild(panel);

  function render() {
    const { selectedIso3, panelOpen, fullscreen } = getState();
    panel.classList.toggle('open', panelOpen);
    panel.classList.toggle('fullscreen', panelOpen && fullscreen);
    panel.setAttribute('data-panel-open', panelOpen ? 'true' : 'false');
    syncFullscreenButton(fullscreen);

    if (!panelOpen || !selectedIso3) {
      lastRenderedIso3 = null;
      return;
    }
    if (selectedIso3 === lastRenderedIso3) return; // only re-render on an actual country change
    lastRenderedIso3 = selectedIso3;
    loadAndRender(selectedIso3);
  }

  // A Try again asks the data service again; nothing needs clearing first, because a result that is missing
  // something is never remembered (and what did load is kept, so only the failed sources are re-requested).
  async function loadAndRender(iso3, { isRetry = false } = {}) {
    const token = ++requestToken;
    const isStale = () => token !== requestToken || getState().selectedIso3 !== iso3; // the user moved on
    // A different country: the previous anthem stops NOW, not when this country's data arrives — which could be
    // seconds away, or never (then the old anthem would play on under this country's error). A Try again is
    // the same country, and must not interrupt what is playing.
    if (!isRetry) AnthemPlayer.stop();
    panel.replaceChildren(buildChrome(iso3, { loading: true }));
    if (isRetry) {
      // The Try again button that was just pressed is gone: keep the keyboard user's place rather than drop them on <body>…
      panel.focus({ preventScroll: true });
      // …and, the skeleton being silent to a screen reader, say what is happening.
      announce(`Trying again to load ${peekEntryByIso3(iso3)?.names?.common ?? iso3}`);
    }

    // A code that is not a country at all is not an outage: there is nothing to retry. (Both boxes are role="alert".)
    const showLoadError = (loaded) => panel.replaceChildren(buildChrome(iso3, {
      error: loaded?.isKnownCountry === false
        ? createNotFound(`There is no country with the code ${iso3}.`)
        : createErrorRetry('Could not load this country right now.', () => loadAndRender(iso3, { isRetry: true })),
    }));

    // A service outage never lands here (it comes back as failed sources); a rejection is a BUG. Either way the
    // panel must not sit on its skeleton for ever — so show the error box, and still let the error reach the console.
    let data = null;
    let failure = null;
    try {
      data = await getCountrySummary(iso3);
    } catch (error) {
      failure = error;
    }
    if (isStale()) return;

    if (!data || (!data.dataAvailability.wikidata && !data.dataAvailability.worldBank)) {
      showLoadError(data);
      if (failure) throw failure;
      return;
    }

    try {
      const chrome = buildChrome(iso3, { data });
      AnthemPlayer.load(iso3, data.anthem);
      panel.replaceChildren(chrome);
    } catch (error) {
      showLoadError(null);
      throw error;
    }
    announce(describeLoadOutcome(data.nameCommon, data.failedSources, { retried: isRetry }));
  }

  function buildChrome(iso3, { loading, error, data } = {}) {
    const header = createEl('div', { className: 'panel-header' });
    const identity = createEl('div', { className: 'panel-identity' });
    if (data?.flagUrl) identity.appendChild(createEl('img', { className: 'panel-flag', attrs: { src: data.flagUrl, alt: '', width: '32', height: '24' } }));
    // "India (IND)" — from the bundled index straight away, so the heading is never the bare code
    // (as it was while loading, or when every request failed).
    const name = data?.nameCommon || peekEntryByIso3(iso3)?.names?.common;
    identity.appendChild(createEl('h2', { className: 'panel-name', text: formatCountryTitle(name, iso3) }));

    const actions = createEl('div', { className: 'panel-actions' });
    const fullscreenBtn = createEl('button', {
      className: 'icon-btn',
      attrs: {
        type: 'button',
        'data-role': 'fullscreen-toggle',
        'aria-label': getState().fullscreen ? 'Exit fullscreen' : 'Fullscreen',
        'aria-pressed': String(getState().fullscreen),
      },
      text: getState().fullscreen ? '⤤' : '⤢',
    });
    fullscreenBtn.addEventListener('click', () => setState({ fullscreen: !getState().fullscreen }));
    const closeBtn = createEl('button', { className: 'icon-btn', attrs: { type: 'button', 'aria-label': 'Close panel' }, text: '×' });
    // detail === 0 marks a keyboard-activated click (Enter/Space); a mouse or touch close should
    // not move focus (it would pop up the on-screen keyboard on phones).
    closeBtn.addEventListener('click', (event) => closePanel({ restoreFocus: event.detail === 0 }));
    actions.append(fullscreenBtn, closeBtn);
    header.append(identity, actions);

    const body = createEl('div', { className: 'panel-body' });
    if (loading) body.appendChild(createSkeleton(6));
    else if (error) body.appendChild(error);
    else if (data) body.appendChild(buildContent(iso3, data));

    const wrap = createEl('div', { className: 'panel-inner' });
    wrap.append(header, body);
    return wrap;
  }

  function buildContent(iso3, data) {
    const frag = document.createDocumentFragment();

    // Some source failed even after retries: say so, rather than let "Not available" pass for a fact.
    if (data.failedSources?.length) {
      frag.appendChild(
        createPartialDataNotice(data.failedSources, () => loadAndRender(iso3, { isRetry: true }))
      );
    }

    const anthemMount = createEl('div', { className: 'panel-anthem-mount' });
    frag.appendChild(anthemMount);

    const facts = createEl('dl', { className: 'panel-facts' });
    const addFact = (label, value) => {
      facts.appendChild(createEl('dt', { text: label }));
      facts.appendChild(createEl('dd', { text: value }));
    };

    addFact('Official name', orNotAvailable(data.nameOfficial));
    addFact('Capital', orNotAvailable(data.capital?.name));
    addFact('Continent', formatList(data.continents, { emptyText: 'Not available' }));
    addFact('Population', formatStat(data.population?.value, 'people', data.population?.year));
    addFact('Area', data.areaKm2 != null ? `${formatArea(data.areaKm2).km2} (${formatArea(data.areaKm2).mi2})` : 'Not available');
    addFact('Languages', formatList(data.languages));
    addFact('Currency', formatList(data.currencies));
    addFact('Time zone(s)', formatList(data.timeZones));

    frag.appendChild(facts);

    const moreLink = createEl('a', {
      className: 'panel-more-link',
      attrs: { href: countryHash(iso3) },
      text: 'More details →',
    });
    frag.appendChild(moreLink);

    // Deferred so the anthem mount point exists in the DOM before mounting into it.
    queueMicrotask(() => AnthemPlayer.mountInto(anthemMount));

    return frag;
  }

  // A fullscreen toggle alone doesn't change which country is loaded, so render()
  // deliberately skips rebuilding the whole panel for it (see the early-return above)
  // — but the button's own label/icon are baked into the DOM at build time, so without
  // this they'd go stale (stuck on "Fullscreen" after the panel had already expanded).
  function syncFullscreenButton(fullscreen) {
    const btn = panel.querySelector('[data-role="fullscreen-toggle"]');
    if (!btn) return;
    btn.setAttribute('aria-label', fullscreen ? 'Exit fullscreen' : 'Fullscreen');
    btn.setAttribute('aria-pressed', String(fullscreen));
    btn.textContent = fullscreen ? '⤤' : '⤢';
  }

  // The closed panel is visibility:hidden, so a browser drops focus to <body> if it was on a
  // control inside. When the user is on the keyboard, put focus somewhere sensible instead:
  // the search box, the documented keyboard path to pick the next country.
  function closePanel({ restoreFocus = false } = {}) {
    AnthemPlayer.stop();
    setState({ selectedIso3: null, panelOpen: false, fullscreen: false });
    if (restoreFocus) document.querySelector('.search-input')?.focus();
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const { panelOpen, fullscreen } = getState();
    if (!panelOpen) return;
    if (fullscreen) setState({ fullscreen: false });
    else closePanel({ restoreFocus: true });
  });

  subscribe(render);
  render();

  return { close: () => closePanel() };
}

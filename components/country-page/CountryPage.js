import { getCountryFullDetails } from '../../lib/dataService.js';
import { fetchTouristSpotsByName } from '../../lib/wikidataClient.js';
import { navigate, MAP_HASH } from '../../lib/router.js';
import { createEl, announce } from '../../lib/domUtils.js';
import { peekEntryByIso3 } from '../../lib/searchIndex.js';
import { formatStat, formatArea, formatList, formatDate, orNotAvailable, formatCountryTitle } from '../../lib/format.js';
import { createSkeleton } from '../shared/LoadingSkeleton.js';
import { createErrorRetry, createNotFound } from '../shared/ErrorRetry.js';
import { createPartialDataNotice, describeLoadOutcome } from '../shared/PartialDataNotice.js';
import { createCountryMap } from './CountryLeafletMap.js';
import { renderPopulationPyramid } from './PopulationPyramid.js';
import * as AnthemPlayer from '../anthem-player/AnthemPlayer.js';

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'geography', label: 'Geography' },
  { id: 'highlights', label: 'Highlights' },
  { id: 'history', label: 'History' },
  { id: 'government', label: 'Government' },
  { id: 'culture', label: 'Culture' },
  { id: 'population', label: 'Population' },
];

/** @param {HTMLElement} container */
export function createCountryPage(container) {
  let currentIso3 = null;
  // Bumped every time the page is (re)built, left or destroyed: work still in flight for an older build (a map or
  // chart still loading, a slow data load) must not touch the DOM, the scroll-spy or the shared anthem player.
  let buildToken = 0;
  let showingCompletePage = false; // the current build finished, with nothing failed (see leave())
  let leafletMap = null;
  let sectionObserver = null;

  function teardownScrollSpy() {
    sectionObserver?._removeScrollListener?.();
    sectionObserver?.disconnect();
    sectionObserver = null;
  }

  function render(iso3) {
    if (iso3 === currentIso3) return;
    currentIso3 = iso3;
    build(iso3);
  }

  // A Try again calls this again: nothing needs clearing first, because a result that is missing something
  // is never remembered (and what did load is kept, so only the failed sources are re-requested).
  function build(iso3, { isRetry = false } = {}) {
    const token = ++buildToken;
    showingCompletePage = false;
    leafletMap?.destroy();
    leafletMap = null;
    teardownScrollSpy();
    // Start loading third-party scripts early so they overlap the data wait (Phase 2).
    import('./CountryLeafletMap.js').catch(() => {});
    import('./PopulationPyramid.js').catch(() => {});
    const loadingWrap = createEl('div', { className: 'country-page-loading' });
    loadingWrap.appendChild(createSkeleton(8));
    container.replaceChildren(loadingWrap);
    // The Try again button that was just pressed is gone: keep the keyboard user's place rather than drop them on <body>.
    if (isRetry) {
      container.closest('#view-country')?.focus({ preventScroll: true });
      // The skeleton is silent to a screen reader: say what is happening, or Try again is followed by up to 20 s of nothing.
      announce(`Trying again to load ${peekEntryByIso3(iso3)?.names?.common ?? iso3}`);
    }
    load(iso3, token, isRetry);
  }

  async function load(iso3, token, isRetry) {
    const isCurrent = () => token === buildToken; // false once the user navigated away or asked again
    // A code that is not a country at all (a typed-in #/country/ZZZ) is not an outage: there is nothing to retry.
    const showLoadError = (data) => container.replaceChildren(
      data?.isKnownCountry === false
        ? createNotFound(`There is no country with the code ${iso3}.`)
        : createErrorRetry('Could not load this country right now.', () => build(iso3, { isRetry: true }))
    ); // both are role="alert": they announce themselves

    // getCountryFullDetails returns immediately with { summary, sections } — each a Promise.
    // Awaiting summary gives us enough data to render the page shell; extras fill in progressively.
    const { summary: summaryPromise, sections } = getCountryFullDetails(iso3);

    // A service outage never lands here (it comes back as failed sources); a rejection is a BUG. Either way the
    // page must not sit on its skeleton for ever — so show the error box, and still let the error reach the console.
    let data = null;
    let failure = null;
    try {
      data = await summaryPromise;
    } catch (error) {
      failure = error;
    }
    if (!isCurrent()) return;

    if (!data || (!data.dataAvailability.wikidata && !data.dataAvailability.worldBank)) {
      showLoadError(data);
      if (failure) throw failure;
      return;
    }

    try {
      const page = buildPage(iso3, data);
      AnthemPlayer.load(iso3, data.anthem);
      container.replaceChildren(page);
    } catch (error) {
      showLoadError(null);
      throw error;
    }
    setupSectionScrollSpy();

    // Async section fills: each updates specific DOM nodes as its data arrives.
    // isCurrent() is checked before every DOM write; the map and the chart handle their own in-place errors.
    const extraFailedSources = new Set();

    const fillOps = [
      mountLeafletMap(data, isCurrent),

      sections.religions.then((rel) => {
        if (!isCurrent()) return;
        const dd = container.querySelector('[data-fill="religions"]');
        if (dd) dd.textContent = rel ?? 'Not available';
      }),

      sections.states.then(({ value, failedSources }) => {
        if (!isCurrent()) return;
        failedSources.forEach((s) => extraFailedSources.add(s));
        const territories = value ?? data.statesTerritories;
        const dd = container.querySelector('[data-fill="states"]');
        if (dd) dd.textContent = `${territories.count} (${formatList(territories.list, { max: 8 })})`;
      }),

      sections.cities.then((cities) => {
        if (!isCurrent()) return;
        const dd = container.querySelector('[data-fill="cities"]');
        if (!dd) return;
        const capitalFallback = data.capital ? [{ name: data.capital.name }] : [];
        dd.textContent = formatList((cities.length > 0 ? cities : capitalFallback).map((c) => c.name));
      }),

      sections.attractions.then(async (spots) => {
        if (!isCurrent()) return;

        // Always supplement country-level spots with the capital city's attractions.
        // Merge both lists, sort globally by page-view popularity (_views), then take top 10.
        // This ensures iconic city landmarks (Eiffel Tower, Kremlin) surface even when the
        // country-level Wikivoyage page emphasizes regions over specific monuments.
        let allSpots = [...spots];
        if (data.capital?.name) {
          const capitalSpots = await fetchTouristSpotsByName(data.capital.name);
          if (!isCurrent()) return;
          if (capitalSpots.length > 0) {
            const seen = new Set(spots.map((s) => s.name));
            allSpots = [...spots, ...capitalSpots.filter((s) => !seen.has(s.name))];
          }
        }
        const finalSpots = allSpots
          .sort((a, b) => (b._views ?? 0) - (a._views ?? 0))
          .slice(0, 10)
          // eslint-disable-next-line no-unused-vars
          .map(({ _views, ...rest }) => rest);

        const dd = container.querySelector('[data-fill="attractions"]');
        if (dd) dd.textContent = formatList(finalSpots.map((s) => s.name));

        const mount = container.querySelector('[data-fill="highlights-cards"]');
        if (!mount) return;
        if (!finalSpots.length) {
          mount.replaceChildren(createEl('p', { className: 'section-prose', text: 'No highlights data available for this country.' }));
          return;
        }
        mount.replaceChildren(buildHighlightCards(finalSpots));
      }),

      sections.topics.then(({ geographyNarrative, historyNarrative, governmentNarrative, cultureNarrative, sportsNarrative, failedSources }) => {
        if (!isCurrent()) return;
        failedSources.forEach((s) => extraFailedSources.add(s));
        const fill = (sel, text) => { const el = container.querySelector(sel); if (el) el.textContent = text ?? 'Not available'; };
        fill('[data-fill="geography-narrative"]', geographyNarrative);
        fill('[data-fill="history-narrative"]', historyNarrative);
        fill('[data-fill="government-narrative"]', governmentNarrative);
        fill('[data-fill="culture-narrative"]', cultureNarrative);
        fill('[data-fill="sports-narrative"]', sportsNarrative);
      }),

      sections.pyramid.then(async ({ rows, status, failedSources }) => {
        if (!isCurrent()) return;
        failedSources.forEach((s) => extraFailedSources.add(s));
        await drawPyramid({ ...data, pyramid: rows, pyramidStatus: status });
      }),
    ];

    await Promise.allSettled(fillOps);
    if (!isCurrent()) return;

    // Update the notice area with any section-level failures discovered after the initial render.
    const newFailed = [...extraFailedSources].filter((s) => !(data.failedSources ?? []).includes(s));
    if (newFailed.length > 0) {
      const allFailed = [...new Set([...(data.failedSources ?? []), ...extraFailedSources])];
      const noticeArea = container.querySelector('[data-role="notice-area"]');
      if (noticeArea) {
        noticeArea.replaceChildren(createPartialDataNotice(allFailed, () => build(iso3, { isRetry: true })));
      }
    }

    showingCompletePage = extraFailedSources.size === 0 && !(data.failedSources?.length);
    const allFailedSources = [...new Set([...(data.failedSources ?? []), ...extraFailedSources])];
    announce(describeLoadOutcome(data.nameCommon, allFailedSources, { retried: isRetry, lead: 'country page loaded' }));
  }

  async function drawPyramid(data) {
    const mount = container.querySelector('#pyramid-mount');
    if (mount) await renderPopulationPyramid(mount, data.pyramid, { status: data.pyramidStatus, countryName: data.nameCommon });
  }

  function buildPage(iso3, data) {
    const page = createEl('div', { className: 'country-page' });
    page.append(buildHeader(iso3, data));
    const noticeArea = createEl('div', { attrs: { 'data-role': 'notice-area' } });
    if (data.failedSources?.length) {
      noticeArea.appendChild(createPartialDataNotice(data.failedSources, () => build(iso3, { isRetry: true })));
    }
    page.appendChild(noticeArea);
    // Map lives full-width between header and section tabs — matches reference layout
    page.appendChild(buildMapArea());
    page.append(buildSectionNav(), buildSections(data));
    return page;
  }

  function buildHeader(iso3, data) {
    const header = createEl('header', { className: 'country-header' });

    // Breadcrumb bar: back button + continent / country path
    const breadcrumb = createEl('div', { className: 'country-breadcrumb' });
    // See comment in prior version: history.back() is unreliable for in-app navigation.
    const backBtn = createEl('button', { className: 'back-to-map-btn', attrs: { type: 'button' }, text: '← World Map' });
    backBtn.addEventListener('click', () => navigate(MAP_HASH));
    const breadcrumbPath = createEl('div', { className: 'breadcrumb-path' });
    const crumbs = [...(data.continents || []).slice(0, 1), `${data.nameCommon}${iso3 ? ` (${iso3})` : ''}`];
    crumbs.forEach((text, i) => {
      if (i > 0) breadcrumbPath.appendChild(createEl('span', { className: 'breadcrumb-sep', text: '/' }));
      breadcrumbPath.appendChild(createEl('span', { className: i === crumbs.length - 1 ? 'breadcrumb-current' : 'breadcrumb-segment', text }));
    });
    breadcrumb.append(backBtn, breadcrumbPath);

    // Two-column hero grid: [content 2/3] [flag + anthem 1/3]
    const heroGrid = createEl('div', { className: 'country-hero-grid' });

    // Left column: title → official name → stats bento
    const content = createEl('div', { className: 'country-hero-content' });
    content.append(
      createEl('h1', { className: 'country-header-name', text: formatCountryTitle(data.nameCommon, iso3) }),
      createEl('p', { className: 'country-header-official', text: orNotAvailable(data.nameOfficial) }),
    );

    // 4 bento stat cards
    const statsGrid = createEl('div', { className: 'country-hero-stats' });
    const addCard = (label, value, sub) => {
      const card = createEl('div', { className: 'hero-stat-card' });
      card.append(
        createEl('div', { className: 'hero-stat-label', text: label }),
        createEl('div', { className: 'hero-stat-value', text: value }),
      );
      if (sub) card.appendChild(createEl('div', { className: 'hero-stat-sub', text: sub }));
      statsGrid.appendChild(card);
    };
    addCard('Capital', orNotAvailable(data.capital?.name), null);
    addCard('Population', formatStat(data.population?.value, null, data.population?.year), null);
    addCard('Area', data.areaKm2 != null ? formatArea(data.areaKm2).km2 : 'Not available', data.areaKm2 != null ? formatArea(data.areaKm2).mi2 : null);
    addCard('Currency', formatList(data.currencies) || 'N/A', null);
    content.appendChild(statsGrid);

    // Right column: flag card + anthem player
    const aside = createEl('div', { className: 'country-hero-aside' });
    if (data.flagUrl) {
      const flagCard = createEl('div', { className: 'country-flag-card' });
      flagCard.appendChild(createEl('img', {
        className: 'country-flag-img',
        attrs: { src: data.flagUrl, alt: `Flag of ${data.nameCommon}`, width: '120', height: '80', loading: 'eager' },
      }));
      const flagInfo = createEl('div', { className: 'country-flag-info' });
      flagInfo.append(
        createEl('div', { className: 'country-flag-label', text: 'National Flag' }),
        createEl('div', { className: 'country-flag-name', text: data.nameCommon }),
      );
      flagCard.appendChild(flagInfo);
      aside.appendChild(flagCard);
    }
    const anthemMount = createEl('div', { className: 'country-header-anthem' });
    aside.appendChild(anthemMount);

    heroGrid.append(content, aside);
    header.append(breadcrumb, heroGrid);
    queueMicrotask(() => AnthemPlayer.mountInto(anthemMount));
    return header;
  }

  function buildSectionNav() {
    const wrap = createEl('div', { className: 'country-section-nav-wrap' });
    const nav = createEl('nav', { className: 'country-section-nav', attrs: { 'aria-label': 'Country page sections' } });
    const list = createEl('ul');
    for (const sec of SECTIONS) {
      const li = createEl('li');
      li.appendChild(createEl('a', { attrs: { href: `#${sec.id}`, 'data-section-link': sec.id }, text: sec.label }));
      list.appendChild(li);
    }
    nav.appendChild(list);
    wrap.appendChild(nav);
    return wrap;
  }

  function buildMapArea() {
    return createEl('div', { className: 'country-map-area', attrs: { id: 'country-map-mount' } });
  }

  // The map comes from a third-party script (Leaflet): if it cannot load, say so in its place — with its own
  // Try again — rather than let the failure abort the rest of the page.
  async function mountLeafletMap(data, isCurrent) {
    const mount = container.querySelector('#country-map-mount');
    if (!mount) return;
    try {
      const map = await createCountryMap(mount, data);
      if (isCurrent()) leafletMap = map;
      else map.destroy(); // the page was rebuilt while the map loaded: do not leak it into a detached node
    } catch {
      if (isCurrent()) mount.replaceChildren(createErrorRetry('The map could not be loaded just now.', () => mountLeafletMap(data, isCurrent)));
    }
  }

  function buildSections(data) {
    const wrap = createEl('div', { className: 'country-details' });
    wrap.append(
      buildOverview(data),
      buildGeography(data),
      buildHighlights(data),
      buildHistory(data),
      buildGovernment(data),
      buildCulture(data),
      buildPopulation(data)
    );
    return wrap;
  }

  function section(id, title, ...content) {
    const el = createEl('section', { className: 'country-section', attrs: { id } });
    el.append(createEl('h2', { text: title }), ...content);
    return el;
  }

  function factList(pairs) {
    const dl = createEl('dl', { className: 'section-facts' });
    for (const [label, val, ddAttrs] of pairs) {
      dl.append(createEl('dt', { text: label }), createEl('dd', { text: val, ...(ddAttrs ? { attrs: ddAttrs } : {}) }));
    }
    return dl;
  }

  function buildOverview(data) {
    return section(
      'overview',
      'Overview',
      factList([
        ['Official name', orNotAvailable(data.nameOfficial)],
        ['Continent', formatList(data.continents)],
        ['Capital', orNotAvailable(data.capital?.name)],
        ['Geographical coordinates', data.centerCoord ? `${data.centerCoord.lat.toFixed(2)}°, ${data.centerCoord.lng.toFixed(2)}°` : 'Not available'],
        ['Area', data.areaKm2 != null ? `${formatArea(data.areaKm2).km2} (${formatArea(data.areaKm2).mi2})` : 'Not available'],
        ['Time zone(s)', formatList(data.timeZones)],
        ['Currency', formatList(data.currencies)],
        ['Official/main languages', formatList(data.languages)],
        ['Major religions', orNotAvailable(data.religions), { 'data-fill': 'religions' }],
      ])
    );
  }

  function buildGeography(data) {
    return section(
      'geography',
      'Geography',
      createEl('p', { className: 'section-prose', attrs: { 'data-fill': 'geography-narrative' }, text: orNotAvailable(data.geographyNarrative) }),
      factList([
        ['States/territories', `${data.statesTerritories.count} (${formatList(data.statesTerritories.list, { max: 8 })})`, { 'data-fill': 'states' }],
        ['Major cities', formatList((data.majorCities || []).map((c) => c.name)), { 'data-fill': 'cities' }],
        ['Top tourist spots', formatList((data.touristSpots || []).map((c) => c.name)), { 'data-fill': 'attractions' }],
      ]),
    );
  }

  function buildHighlights(data) {
    const mount = createEl('div', { attrs: { 'data-fill': 'highlights-cards' } });
    const initialCount = data.touristSpots?.length ?? 0;
    mount.appendChild(createEl('p', {
      className: 'section-prose highlights-loading',
      text: initialCount > 0 ? `${initialCount} highlight${initialCount > 1 ? 's' : ''} — fetching images…` : 'Loading…',
    }));
    return section('highlights', 'Top Highlights', mount);
  }

  function buildHighlightCards(spots) {
    const grid = createEl('div', { className: 'highlights-grid' });
    for (const spot of spots) {
      const card = createEl('article', { className: 'highlight-card' });
      const imgWrap = createEl('div', { className: 'highlight-card-img-wrap' });
      if (spot.imageUrl) {
        const img = createEl('img', { className: 'highlight-card-img', attrs: { src: spot.imageUrl, alt: spot.name, loading: 'lazy', decoding: 'async', width: '400', height: '300' } });
        imgWrap.appendChild(img);
      } else {
        imgWrap.classList.add('no-image');
      }
      const body = createEl('div', { className: 'highlight-card-body' });
      body.appendChild(createEl('h3', { className: 'highlight-card-name', text: spot.name }));
      if (spot.wikiUrl) {
        body.appendChild(createEl('a', {
          className: 'highlight-card-link',
          attrs: { href: spot.wikiUrl, target: '_blank', rel: 'noopener noreferrer' },
          text: 'Learn more on Wikipedia →',
        }));
      }
      card.append(imgWrap, body);
      grid.appendChild(card);
    }
    return grid;
  }

  function buildHistory(data) {
    return section(
      'history',
      'History',
      createEl('p', { className: 'section-prose', attrs: { 'data-fill': 'history-narrative' }, text: orNotAvailable(data.historyNarrative) }),
      factList([['Formed', formatDate(data.formationDate)]])
    );
  }

  function buildGovernment(data) {
    const cards = createEl('div', { className: 'government-facts' });
    for (const [label, val] of [
      ['System of government', orNotAvailable(data.governmentForm)],
      ['Head of state', orNotAvailable(data.headOfState)],
      ['Head of government', orNotAvailable(data.headOfGovernment)],
    ]) {
      const card = createEl('div', { className: 'gov-fact' });
      card.append(
        createEl('div', { className: 'gov-fact-label', text: label }),
        createEl('div', { className: 'gov-fact-value', text: val }),
      );
      cards.appendChild(card);
    }
    return section(
      'government',
      'Government',
      cards,
      createEl('p', { className: 'section-prose', attrs: { 'data-fill': 'government-narrative' }, text: orNotAvailable(data.governmentNarrative) })
    );
  }

  function buildCulture(data) {
    const grid = createEl('div', { className: 'culture-grid' });

    const culturePanel = createEl('div', { className: 'culture-panel' });
    culturePanel.append(
      createEl('h3', { text: 'Culture' }),
      createEl('p', { className: 'section-prose', attrs: { 'data-fill': 'culture-narrative' }, text: orNotAvailable(data.cultureNarrative) }),
    );

    const sportsPanel = createEl('div', { className: 'culture-panel' });
    sportsPanel.append(
      createEl('h3', { text: 'Sports' }),
      createEl('p', { className: 'section-prose', attrs: { 'data-fill': 'sports-narrative' }, text: orNotAvailable(data.sportsNarrative) }),
    );

    grid.append(culturePanel, sportsPanel);
    return section('culture', 'Culture', grid);
  }

  function buildPopulation(data) {
    const ratio = data.malePopulation?.value && data.femalePopulation?.value
      ? (data.malePopulation.value / data.femalePopulation.value).toFixed(2)
      : null;

    const statsGrid = createEl('div', { className: 'population-stats' });
    for (const [label, val] of [
      ['Population', formatStat(data.population?.value, 'people', data.population?.year)],
      ['Density', formatStat(data.density?.value, 'people/km²', data.density?.year)],
      ['Birth rate', formatStat(data.birthRate?.value, 'per 1,000', data.birthRate?.year)],
      ['Death rate', formatStat(data.deathRate?.value, 'per 1,000', data.deathRate?.year)],
      ['Net migration', formatStat(data.netMigration?.value, 'people', data.netMigration?.year)],
      ['Male / female ratio', ratio ? `${ratio} : 1` : 'Not available'],
      ['Life expectancy', formatStat(data.lifeExpectancy?.value, 'years', data.lifeExpectancy?.year)],
      ['Growth rate', formatStat(data.growthRate?.value, '% / year', data.growthRate?.year)],
    ]) {
      const stat = createEl('div', { className: 'pop-stat' });
      stat.append(
        createEl('div', { className: 'pop-stat-label', text: label }),
        createEl('div', { className: 'pop-stat-value', text: val }),
      );
      statsGrid.appendChild(stat);
    }

    return section(
      'population',
      'Population',
      statsGrid,
      createEl('h3', { text: 'Age distribution' }),
      createEl('div', { attrs: { id: 'pyramid-mount', style: 'height:420px' } }),
    );
  }

  function setupSectionScrollSpy() {
    const sections = SECTIONS.map((s) => container.querySelector(`#${s.id}`)).filter(Boolean);
    const links = container.querySelectorAll('[data-section-link]');
    // The scrollable ancestor is #view-country (overflow-y: auto), not this component's
    // own mount div — an IntersectionObserver root that never itself scrolls doesn't
    // track scroll position at all, so the nav stayed stuck on whichever section
    // happened to intersect at initial render.
    const scrollRoot = container.closest('#view-country');
    const setActive = (id) => links.forEach((link) => link.classList.toggle('active', link.dataset.sectionLink === id));

    sectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { root: scrollRoot, rootMargin: '-35% 0px -50% 0px' }
    );
    sections.forEach((s) => sectionObserver.observe(s));

    // The last section can't always reach the intersection band above purely by
    // scrolling — there's no more content below it to scroll past — so once the user
    // has scrolled to (near) the bottom, force it active regardless of what the
    // observer last reported.
    const lastSectionId = sections.at(-1)?.id;
    function handleScrollEnd() {
      if (!lastSectionId || !scrollRoot) return;
      const atBottom = scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 4;
      if (atBottom) setActive(lastSectionId);
    }
    scrollRoot?.addEventListener('scroll', handleScrollEnd, { passive: true });
    sectionObserver._removeScrollListener = () => scrollRoot?.removeEventListener('scroll', handleScrollEnd);
  }

  return {
    render,
    /**
     * The user went back to the map. A load still in flight must stop touching the page and the shared anthem
     * player (it used to finish under another country's panel and start ITS anthem); and a page that never finished,
     * or was showing a Try again, is rebuilt — a fresh attempt — on the next visit rather than shown stale.
     */
    leave() {
      buildToken++;
      if (!showingCompletePage) currentIso3 = null;
    },
    destroy() {
      buildToken++; // whatever is still loading must not touch the page any more
      leafletMap?.destroy();
      teardownScrollSpy();
    },
  };
}

import { fetchWikidataCore, fetchWikidataLists, fetchStatesTerritories, fetchReligions, fetchMajorCitiesDynamic, fetchTouristAttractions } from './wikidataClient.js';
import { fetchWorldBankDemographics, fetchWorldBankPyramid } from './worldBankClient.js';
import { fetchCountryTopicSummaries } from './wikipediaClient.js';
import { getEntryByIso3 } from './searchIndex.js';

// Performance helpers — safe in both browser and Node 16+; no-ops when the API is absent.
const _perf = typeof performance !== 'undefined' ? performance : null;
const perfMark = _perf ? (n) => { try { _perf.mark(n); } catch (_) {} } : () => {};
const perfMeasure = _perf ? (n, s, e) => { try { _perf.measure(n, s, e); } catch (_) {} } : () => {};
const perfNow = _perf ? () => _perf.now() : () => Date.now();

function value(result, fallback) {
  return result?.status === 'fulfilled' && result.value != null ? result.value : fallback;
}

// A settled promise from fetchWorldBankDemographics/fetchWikidataCore is NOT the same
// as "got real data" — both catch their own per-field network errors and resolve with
// an object full of nulls rather than rejecting, by design (one dead indicator
// shouldn't fail the other eight). Confirmed live: blocking every World Bank request
// still left `dataAvailability.worldBank` reporting true under the old
// `status === 'fulfilled'` check, so the panel silently showed "Not available" instead
// of the actual error+Retry UI for what actually was a total failure.
function hasAnyValue(obj) {
  return Object.values(obj).some((v) => (Array.isArray(v) ? v.length > 0 : v != null));
}

// How long one source may keep the panel waiting. A healthy read takes 1-3 s; a struggling service can
// take minutes to run through its retries, and the rest of the country should not wait for it.
const SOURCE_DEADLINE_MS = 20_000;
const ISO3_PATTERN = /^[A-Za-z]{3}$/;

// Codes end up in URLs and SPARQL text, so anything that is not three letters is refused at the door.
function toCode(iso3) {
  if (typeof iso3 !== 'string' || !ISO3_PATTERN.test(iso3)) throw new TypeError(`Not an ISO 3166-1 alpha-3 country code: ${String(iso3)}`);
  return iso3.toUpperCase();
}

// Wraps a reader so that a bad code, or a bug inside it, is a rejected promise rather than a throw.
const forCountry = (read) => (iso3) => {
  try {
    return read(toCode(iso3));
  } catch (error) {
    return Promise.reject(error);
  }
};

// A source can also hand back a result that is only partly there: a World Bank read with a failed
// indicator, a Wikidata read whose anthem recording lookup failed, a Query Service extra that was refused.
// All of them mark themselves (see the clients).
const partsOf = (result) => [...(result?.failedIndicators ?? []), ...(result?.incompleteParts ?? [])];
const isIncomplete = (result) => partsOf(result).length > 0;

/**
 * Each source's answer, per country: shared while in flight, and remembered only when COMPLETE. A failed
 * or partial answer is forgotten at once, so asking again re-requests just that source and keeps the
 * others — Try again on a Wikidata failure does not re-download the World Bank's 43 indicators.
 *
 * A request that a caller has already GIVEN UP waiting for (its deadline passed: see `abandon`) is not shared
 * with the next ask, which would only wait out another deadline on the same hung request: that ask starts a
 * request of its own, and whichever answers completely first is the one kept.
 */
function createSourceMemo() {
  const byCountry = new Map(); // code -> Map<source, {promise, settled, abandoned}>
  return {
    load(source, code, fetcher, onNewFetch) {
      if (!byCountry.has(code)) byCountry.set(code, new Map());
      const entries = byCountry.get(code);
      const current = entries.get(source);
      if (current && (current.settled || !current.abandoned)) return current.promise;

      const entry = { promise: null, settled: false, abandoned: false };
      onNewFetch?.(); // called synchronously when a fresh fetch starts (not when reusing in-flight)
      entry.promise = (async () => fetcher())(); // a fetcher that throws synchronously becomes a rejection
      entries.set(source, entry);
      const forgetThis = () => { if (entries.get(source) === entry) entries.delete(source); }; // not a newer attempt's entry
      entry.promise.then(
        (result) => {
          entry.settled = true;
          if (isIncomplete(result)) forgetThis();
          else if (!entries.get(source)?.settled) entries.set(source, entry); // the first complete answer wins
        },
        () => {
          entry.settled = true;
          forgetThis();
        }
      );
      return entry.promise;
    },
    /** A caller stopped waiting for this request: the next ask should not be handed the same one. */
    abandon(source, code, promise) {
      const entry = byCountry.get(code)?.get(source);
      if (entry?.promise === promise) entry.abandoned = true;
    },
    clear(code) {
      if (code) byCountry.delete(code);
      else byCountry.clear();
    },
  };
}

// Stops WAITING for `promise` after `ms` (and says so through `onExpire`); the request itself carries on, and its
// answer, if it ever comes, can still be kept by the memo for a later attempt.
function withDeadline(promise, ms, what, onExpire) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      onExpire?.();
      reject(new Error(`${what} did not answer within ${ms} ms`));
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The data service, built over its fetchers so the caching policy can be tested without a network.
 *
 * Caching policy — the part that matters for reliability: a result is remembered only if it is
 * COMPLETE. A summary or country page in which some source failed (Wikidata busy, a World Bank
 * indicator timed out) is shown to the user with whatever did load, but is dropped from the cache, so
 * the next visit — or the Retry button — tries again, and only for the sources that failed (see
 * createSourceMemo). Remembering it (as this used to) turned one transient failure into "Not available"
 * for that country for the rest of the visit.
 * @param {object} deps the fetchers (see the default wiring below)
 * @param {{deadlineMs?: number, report?: (problem: {source: string, code: string, error?: unknown, incompleteParts?: string[]}) => void}} [options]
 */
export function createDataService(deps, { deadlineMs = SOURCE_DEADLINE_MS, report = () => {} } = {}) {
  const summaryCache = new Map();
  const fullCache = new Map();
  const memo = createSourceMemo();
  const perfTimings = []; // [{source, code, queueMs, settleMs, status}] — collected for every source call

  // One source: shared, remembered when complete, waited for at most `deadlineMs`, and — when it failed or came
  // back partial — reported with its reason to `report` (an outage and a bug both look like a failed source).
  const source = (name, code, fetcher) => {
    const t0 = perfNow();
    perfMark(`ds:${code}:${name}:start`);
    let queueMs; // undefined when reusing an in-flight request; 0+ when starting a fresh one
    const request = memo.load(name, code, fetcher, () => {
      queueMs = Math.round(perfNow() - t0);
      perfMark(`ds:${code}:${name}:fetch`);
    });
    return withDeadline(request, deadlineMs, name, () => memo.abandon(name, code, request)).then(
      (result) => {
        const settleMs = Math.round(perfNow() - t0);
        perfMark(`ds:${code}:${name}:settle`);
        if (queueMs !== undefined) perfMeasure(`ds:queue:${code}:${name}`, `ds:${code}:${name}:start`, `ds:${code}:${name}:fetch`);
        perfMeasure(`ds:settle:${code}:${name}`, `ds:${code}:${name}:start`, `ds:${code}:${name}:settle`);
        perfTimings.push({ source: name, code, queueMs: queueMs ?? 0, settleMs, status: isIncomplete(result) ? 'partial' : 'ok' });
        if (isIncomplete(result)) report({ source: name, code, incompleteParts: partsOf(result) });
        return result;
      },
      (error) => {
        const settleMs = Math.round(perfNow() - t0);
        perfTimings.push({ source: name, code, queueMs: queueMs ?? 0, settleMs, status: 'error' });
        report({ source: name, code, error });
        throw error;
      }
    );
  };
  // A cache entry is dropped only if it is still the one we stored: a clear + fresh fetch may have replaced it.
  const forgetIfCurrent = (cache, code, promise) => { if (cache.get(code) === promise) cache.delete(code); };

  /**
   * Fast path: everything the side panel needs (Wikidata core + lists, World Bank scalar
   * demographics, the bundled search-index entry). Deliberately excludes the population pyramid,
   * subdivisions, religion/attraction/city lookups and the Wikipedia topic summaries — those are
   * heavier and only the full country page needs them, so a side-panel open never waits on them.
   * @param {string} iso3
   */
  const getCountrySummary = forCountry((code) => {
    if (summaryCache.has(code)) return summaryCache.get(code);
    const promise = Promise.allSettled([
      source('core', code, () => deps.fetchWikidataCore(code)),
      source('lists', code, () => deps.fetchWikidataLists(code)),
      source('demographics', code, () => deps.fetchWorldBankDemographics(code)),
      source('index', code, () => deps.getEntryByIso3(code)),
    ]).then((results) => {
      const summary = normalizeSummary(code, results);
      if (summary.failedSources.length > 0) forgetIfCurrent(summaryCache, code, promise);
      return summary;
    });
    promise.catch(() => forgetIfCurrent(summaryCache, code, promise)); // a bug in the merge must not be remembered either
    summaryCache.set(code, promise);
    return promise;
  });

  /**
   * Full path for the country page: the summary plus the population pyramid, the subdivisions, the religion
   * percentages, the major cities and tourist attractions (each falling back to the capital, or to nothing,
   * when the Query Service is throttled), and five Wikipedia topic narratives.
   * @param {string} iso3
   */
  const getCountryFullDetails = forCountry((code) => {
    if (fullCache.has(code)) return fullCache.get(code);
    const promise = (async () => {
      // None of these needs anything from the summary (the topic narratives only need the country's name,
      // which is in the bundled index), so they start together with it rather than after it. The summary is
      // started first so its requests are first in line at the hosts they share.
      const summary = getCountrySummary(code);
      const extras = Promise.allSettled([
        source('religions', code, () => deps.fetchReligions(code)),
        source('cities', code, () => deps.fetchMajorCitiesDynamic(code)),
        source('attractions', code, async () => deps.fetchTouristAttractions(code, (await deps.getEntryByIso3(code))?.names?.common ?? null)),
        source('pyramid', code, () => deps.fetchWorldBankPyramid(code)),
        source('topics', code, async () => deps.fetchCountryTopicSummaries((await deps.getEntryByIso3(code))?.names?.common ?? code)),
        source('states', code, () => deps.fetchStatesTerritories(code)),
      ]);
      const extraResults = await extras;
      const details = mergeFullDetails(await summary, extraResults);
      // The optional extras (the Query Service reads) have fallbacks and raise no notice — but a failure of one is
      // still not an answer to keep, so it does not get the assembled page remembered either.
      const extrasIncomplete = extraResults.some((result) => result.status === 'rejected' || isIncomplete(result.value));
      if (details.failedSources.length > 0 || extrasIncomplete) forgetIfCurrent(fullCache, code, promise);
      return details;
    })();
    promise.catch(() => forgetIfCurrent(fullCache, code, promise));
    fullCache.set(code, promise);
    return promise;
  });

  /**
   * Forgets everything remembered about one country — even complete results — or about all of them when
   * called with no argument, so the next read fetches from scratch. The Retry buttons do NOT need this:
   * failed and partial results are never remembered in the first place.
   * @param {string} [iso3]
   */
  function clearCountryDataCache(iso3) {
    if (!iso3) {
      summaryCache.clear();
      fullCache.clear();
      memo.clear();
      return;
    }
    const code = toCode(iso3);
    summaryCache.delete(code);
    fullCache.delete(code);
    memo.clear(code);
  }

  /**
   * Progressive variant of getCountryFullDetails: returns synchronously with { summary, sections },
   * where each section is a Promise for that section's data. Consumers can render as each promise
   * settles rather than waiting for everything. The underlying source memo ensures network requests
   * are shared with concurrent getCountryFullDetails calls.
   */
  const getCountryFullDetailsProgressive = forCountry((code) => {
    const summaryPromise = getCountrySummary(code);

    // Kick off all extras concurrently — summary sources are first in line at shared hosts
    const rawReligions = source('religions', code, () => deps.fetchReligions(code));
    const rawCities = source('cities', code, () => deps.fetchMajorCitiesDynamic(code));
    const rawAttractions = source('attractions', code, async () => deps.fetchTouristAttractions(code, (await deps.getEntryByIso3(code))?.names?.common ?? null));
    const rawPyramid = source('pyramid', code, () => deps.fetchWorldBankPyramid(code));
    const rawTopics = source('topics', code, async () =>
      deps.fetchCountryTopicSummaries((await deps.getEntryByIso3(code))?.names?.common ?? code)
    );
    const rawStates = source('states', code, () => deps.fetchStatesTerritories(code));

    const religions = rawReligions.then((r) => formatReligionList(r), () => null);
    const cities = rawCities.then((r) => r ?? [], () => []);
    const attractions = rawAttractions.then((r) => r ?? [], () => []);

    const topics = rawTopics.then(
      (t) => ({
        geographyNarrative: t?.geography?.extract ?? null,
        historyNarrative: t?.history?.extract ?? null,
        governmentNarrative: t?.government?.extract ?? null,
        cultureNarrative: t?.culture?.extract ?? null,
        sportsNarrative: t?.sports?.extract ?? null,
        failedSources: (t?.incompleteParts?.length ?? 0) > 0 ? ['wikipedia'] : [],
      }),
      () => ({
        geographyNarrative: null, historyNarrative: null, governmentNarrative: null,
        cultureNarrative: null, sportsNarrative: null, failedSources: ['wikipedia'],
      })
    );

    const pyramid = rawPyramid.then(
      (rows) => {
        const rows_ = rows ?? [];
        const pyramidFailed = (rows?.failedIndicators?.length ?? 0) > 0;
        return {
          rows: rows_,
          status: hasPyramidData(rows_) ? 'ok' : pyramidFailed ? 'failed' : 'no-data',
          failedSources: pyramidFailed ? ['worldbank'] : [],
        };
      },
      () => ({ rows: [], status: 'failed', failedSources: ['worldbank'] })
    );

    const states = rawStates.then(
      (r) => ({ value: r ?? { count: 0, list: [] }, failedSources: [] }),
      () => ({ value: null, failedSources: ['wikidata'] })
    );

    return { summary: summaryPromise, sections: { religions, cities, attractions, topics, pyramid, states } };
  });

  return {
    getCountrySummary,
    getCountryFullDetails,
    getCountryFullDetailsProgressive,
    clearCountryDataCache,
    /** Returns timing rows for all sources, optionally filtered to one country code. */
    getPerfTimings: (code) => code
      ? perfTimings.filter((t) => t.code === code.toUpperCase())
      : [...perfTimings],
    /** Removes timing rows — for one country when a code is given, or all rows when omitted. */
    clearPerfTimings: (code) => {
      if (code) {
        const upper = code.toUpperCase();
        for (let i = perfTimings.length - 1; i >= 0; i--) if (perfTimings[i].code === upper) perfTimings.splice(i, 1);
      } else {
        perfTimings.length = 0;
      }
    },
  };
}

// Where a failed or partial source is written down for whoever is debugging. An outage and a bug both show up as
// a failed source (and a Try again); this line is what tells them apart.
function reportProblem({ source, code, error, incompleteParts }) {
  console.warn(`Country Explorer: ${source} for ${code} ${error ? 'failed' : 'came back incomplete'}`, error ?? incompleteParts);
}

const defaultService = createDataService({
  fetchWikidataCore,
  fetchWikidataLists,
  fetchStatesTerritories,
  fetchReligions,
  fetchMajorCitiesDynamic,
  fetchTouristAttractions,
  fetchWorldBankDemographics,
  fetchWorldBankPyramid,
  fetchCountryTopicSummaries,
  getEntryByIso3,
}, { report: reportProblem });

// When ?perf is in the URL, print a timing table to the console after each country load.
function withPerfPrint(fn, label) {
  return async (iso3) => {
    const result = await fn(iso3);
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('perf')) {
      const code = typeof iso3 === 'string' ? iso3.toUpperCase() : String(iso3);
      const rows = defaultService.getPerfTimings(code);
      if (rows.length > 0) {
        console.log(`[perf:ds] ${label} ${code}`);
        const table = {};
        for (const { source, queueMs, settleMs, status } of rows) table[source] = { 'queue ms': queueMs, 'settle ms': settleMs, status };
        console.table(table);
        defaultService.clearPerfTimings(code);
      }
    }
    return result;
  };
}

// Progressive variant: prints after all section promises settle.
function withPerfPrintProgressive(fn, label) {
  return (iso3) => {
    const result = fn(iso3);
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('perf')) {
      const code = typeof iso3 === 'string' ? iso3.toUpperCase() : String(iso3);
      Promise.allSettled([result.summary, ...Object.values(result.sections)]).then(() => {
        const rows = defaultService.getPerfTimings(code);
        if (rows.length > 0) {
          console.log(`[perf:ds] ${label} ${code}`);
          const table = {};
          for (const { source: src, queueMs, settleMs, status } of rows) table[src] = { 'queue ms': queueMs, 'settle ms': settleMs, status };
          console.table(table);
          defaultService.clearPerfTimings(code);
        }
      });
    }
    return result;
  };
}

export const getCountrySummary = withPerfPrint(defaultService.getCountrySummary, 'summary');
export const getCountryFullDetails = withPerfPrintProgressive(defaultService.getCountryFullDetailsProgressive, 'fullDetails');
export const clearCountryDataCache = defaultService.clearCountryDataCache;

/**
 * Pure merge step for the fast path, split out for unit testing with fake
 * settled-promise results instead of live network calls.
 * @param {string} iso3
 * @param {[PromiseSettledResult, PromiseSettledResult, PromiseSettledResult, PromiseSettledResult]} results
 */
export function normalizeSummary(iso3, [coreResult, listsResult, demoResult, indexResult]) {
  const core = value(coreResult, {});
  const lists = value(listsResult, {});
  const demographics = value(demoResult, {});
  const indexEntry = value(indexResult, null);

  // Which sources FAILED (as opposed to simply having no data for this place): the UI offers a Retry
  // for these, and the service does not cache the result.
  const failedSources = [];
  if (coreResult?.status === 'rejected' || listsResult?.status === 'rejected' || (core.incompleteParts?.length ?? 0) > 0) failedSources.push('wikidata');
  if (demoResult?.status === 'rejected' || (demographics.failedIndicators?.length ?? 0) > 0) failedSources.push('worldbank');

  return {
    iso3,
    iso2: indexEntry?.iso2 ?? null,
    // Only when the index LOADED and has no such code is it not a country (a typed-in #/country/ZZZ); an index that
    // failed to load says nothing either way.
    isKnownCountry: indexResult?.status !== 'fulfilled' || indexEntry !== null,
    nameCommon: indexEntry?.names?.common ?? iso3,
    nameOfficial: core.officialName ?? indexEntry?.names?.official ?? null,
    capital: core.capital ?? null,
    centerCoord: core.centerCoord ?? indexEntry?.coord ?? null,
    areaKm2: core.areaKm2 ?? null,
    currencies: core.currencies ?? [],
    continents: core.continents ?? [],
    flagUrl: core.flagUrl ?? null,
    formationDate: core.formationDate ?? null,
    governmentForm: core.governmentForm ?? null,
    headOfState: core.headOfState ?? null,
    headOfGovernment: core.headOfGovernment ?? null,
    anthem: core.anthem ?? null,
    languages: lists.languages ?? [],
    timeZones: lists.timeZones ?? [],
    statesTerritories: lists.statesTerritories ?? { count: 0, list: [] },
    // The World Bank is the usual source; Wikidata's own figure covers places it lacks (the Vatican).
    population: demographics.population ?? core.population ?? null,
    density: demographics.density ?? null,
    birthRate: demographics.birthRate ?? null,
    deathRate: demographics.deathRate ?? null,
    growthRate: demographics.growthRate ?? null,
    netMigration: demographics.netMigration ?? null,
    lifeExpectancy: demographics.lifeExpectancy ?? null,
    malePopulation: demographics.malePopulation ?? null,
    femalePopulation: demographics.femalePopulation ?? null,
    failedSources,
    dataAvailability: {
      wikidata: hasAnyValue(core) || hasAnyValue(lists),
      worldBank: hasAnyValue(demographics),
    },
  };
}

export function formatReligionList(religions) {
  if (!religions || religions.length === 0) return null;
  return religions
    .map((r) => (r.percent != null ? `${r.religion} (${r.percent.toFixed(1)}%)` : r.religion))
    .join(', ');
}

function hasPyramidData(rows) {
  return rows.some((row) => row.male || row.female);
}

function placesOrFallback(dynamicPlaces, capitalFallback) {
  if (dynamicPlaces && dynamicPlaces.length > 0) return dynamicPlaces;
  return capitalFallback ? [capitalFallback] : [];
}

/**
 * Pure merge step for the full path, split out for unit testing.
 * @param {object} summary the already-normalized summary object
 * @param {PromiseSettledResult[]} results in the order: religions, major cities, tourist attractions, population
 *   pyramid, Wikipedia topics, states/territories (the last is optional)
 */
export function mergeFullDetails(summary, [religionsR, citiesR, attractionsR, pyramidR, topicsR, statesR]) {
  const dynamicReligions = value(religionsR, null);
  const dynamicCities = value(citiesR, []);
  const dynamicAttractions = value(attractionsR, []);
  const pyramid = value(pyramidR, []);
  const topics = value(topicsR, {});

  // Three different situations that used to look identical ("Not available"): there is age data;
  // the World Bank has none for this place (Vatican City); or the requests failed.
  const pyramidFailed = pyramidR?.status === 'rejected' || (pyramid.failedIndicators?.length ?? 0) > 0;
  const failedSources = new Set(summary.failedSources ?? []);
  if (pyramidFailed) failedSources.add('worldbank');
  if (statesR?.status === 'rejected') failedSources.add('wikidata');
  // A topic whose lookup FAILED (as opposed to having no article) is a failed source, not an empty narrative.
  if (topicsR?.status === 'rejected' || (topics.incompleteParts?.length ?? 0) > 0) failedSources.add('wikipedia');

  const capitalAsPlace = summary.capital ? { name: summary.capital.name, coord: summary.capital.coord } : null;

  return {
    ...summary,
    pyramid,
    pyramidStatus: hasPyramidData(pyramid) ? 'ok' : pyramidFailed ? 'failed' : 'no-data',
    statesTerritories: value(statesR, null) ?? summary.statesTerritories ?? { count: 0, list: [] },
    failedSources: [...failedSources],
    religions: formatReligionList(dynamicReligions),
    geographyNarrative: topics.geography?.extract ?? null,
    historyNarrative: topics.history?.extract ?? null,
    governmentNarrative: topics.government?.extract ?? null,
    cultureNarrative: topics.culture?.extract ?? null,
    sportsNarrative: topics.sports?.extract ?? null,
    majorCities: placesOrFallback(dynamicCities, capitalAsPlace),
    touristSpots: placesOrFallback(dynamicAttractions, null),
    dataAvailability: {
      ...summary.dataAvailability,
      wikipedia: Object.values(topics).some(Boolean),
    },
  };
}

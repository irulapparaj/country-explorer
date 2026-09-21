import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSummary, mergeFullDetails, formatReligionList, createDataService } from '../../lib/dataService.js';

const fulfilled = (value) => ({ status: 'fulfilled', value });
const rejected = () => ({ status: 'rejected', reason: new Error('network down') });

test('normalizeSummary merges Wikidata, World Bank, and the search index into one flat shape', () => {
  const result = normalizeSummary('IND', [
    fulfilled({ officialName: 'Republic of India', capital: { name: 'New Delhi' }, currencies: ['Indian rupee'] }),
    fulfilled({ languages: ['Hindi', 'English'], timeZones: [] }),
    fulfilled({ population: { value: 1_400_000_000, year: 2024 } }),
    fulfilled({ iso2: 'IN', names: { common: 'India', official: 'Republic of India' }, coord: { lat: 22.8, lng: 83 } }),
  ]);

  assert.equal(result.nameOfficial, 'Republic of India');
  assert.equal(result.capital.name, 'New Delhi');
  assert.deepEqual(result.currencies, ['Indian rupee']);
  assert.deepEqual(result.languages, ['Hindi', 'English']);
  assert.equal(result.population.value, 1_400_000_000);
  assert.equal(result.nameCommon, 'India');
  assert.deepEqual(result.dataAvailability, { wikidata: true, worldBank: true });
});

test('normalizeSummary degrades individual fields instead of throwing when a source fails', () => {
  const result = normalizeSummary('ATA', [rejected(), rejected(), rejected(), fulfilled(null)]);
  assert.equal(result.nameOfficial, null);
  assert.equal(result.capital, null);
  assert.deepEqual(result.currencies, []);
  assert.deepEqual(result.dataAvailability, { wikidata: false, worldBank: false });
});

// Regression test for a real bug found during development: fetchWorldBankDemographics
// (and fetchWikidataCore's own internal fallbacks) catch their own per-field network
// errors and *resolve* with an object full of nulls rather than rejecting — a plain
// `status === 'fulfilled'` check on the outer promise reported worldBank data as
// available even with every single indicator request blocked, which meant the panel
// silently showed "Not available" everywhere instead of the actual error+Retry UI a
// total failure should trigger.
test('normalizeSummary treats a "fulfilled but every field is null" result as unavailable, not successful', () => {
  const allNullDemographics = {
    population: null, density: null, birthRate: null, deathRate: null, growthRate: null,
    netMigration: null, lifeExpectancy: null, malePopulation: null, femalePopulation: null,
  };
  const result = normalizeSummary('FRA', [rejected(), rejected(), fulfilled(allNullDemographics), fulfilled(null)]);
  assert.deepEqual(result.dataAvailability, { wikidata: false, worldBank: false });
});

test('normalizeSummary falls back to the ISO3 code as the display name with no search-index entry', () => {
  assert.equal(normalizeSummary('XYZ', [rejected(), rejected(), rejected(), rejected()]).nameCommon, 'XYZ');
});

test('formatReligionList shows a percentage only when one is known, and returns null for an empty/missing list', () => {
  assert.equal(
    formatReligionList([{ religion: 'Hinduism', percent: 80.5 }, { religion: 'Buddhism', percent: null }]),
    'Hinduism (80.5%), Buddhism'
  );
  assert.equal(formatReligionList(null), null);
  assert.equal(formatReligionList([]), null);
});

const baseSummary = { nameCommon: 'India', capital: { name: 'New Delhi', coord: { lat: 28.6, lng: 77.2 } }, dataAvailability: { wikidata: true, worldBank: true } };

test('mergeFullDetails formats the live Wikidata religion percentages', () => {
  const result = mergeFullDetails(baseSummary, [
    fulfilled([{ religion: 'Hinduism', percent: 80.5 }]),
    fulfilled([]),
    fulfilled([]),
    fulfilled([]),
    fulfilled({}),
  ]);
  assert.equal(result.religions, 'Hinduism (80.5%)');
});

test('mergeFullDetails leaves religions null when the live query finds nothing (there is no other source)', () => {
  const result = mergeFullDetails(baseSummary, [
    fulfilled(null),
    fulfilled([]),
    fulfilled([]),
    fulfilled([]),
    fulfilled({}),
  ]);
  assert.equal(result.religions, null);
});

test('mergeFullDetails prefers dynamic cities/attractions, then just the capital', () => {
  const dynamic = mergeFullDetails(baseSummary, [
    fulfilled(null), fulfilled([{ name: 'Mumbai', coord: { lat: 1, lng: 1 } }]), fulfilled([]), fulfilled([]), fulfilled({}),
  ]);
  assert.deepEqual(dynamic.majorCities, [{ name: 'Mumbai', coord: { lat: 1, lng: 1 } }]);

  const capitalOnly = mergeFullDetails(baseSummary, [
    fulfilled(null), fulfilled([]), fulfilled([]), fulfilled([]), fulfilled({}),
  ]);
  assert.deepEqual(capitalOnly.majorCities, [{ name: 'New Delhi', coord: { lat: 28.6, lng: 77.2 } }]);
  assert.deepEqual(capitalOnly.touristSpots, [], 'attractions have no capital to stand in for them');
});

test('mergeFullDetails leaves a narrative null when Wikipedia has no article for that topic', () => {
  const result = mergeFullDetails(baseSummary, [
    fulfilled(null), fulfilled([]), fulfilled([]), fulfilled([]),
    fulfilled({ geography: null }),
  ]);
  assert.equal(result.geographyNarrative, null);
});

test('mergeFullDetails uses the live Wikipedia geography summary when one resolved', () => {
  const result = mergeFullDetails(baseSummary, [
    fulfilled(null), fulfilled([]), fulfilled([]), fulfilled([]),
    fulfilled({ geography: { extract: 'Live Wikipedia geography summary.' } }),
  ]);
  assert.equal(result.geographyNarrative, 'Live Wikipedia geography summary.');
});


// ======================================================================================================
// Failure tracking, the population fallback, and the cache policy (the reported "Not available" bug:
// one transient failure used to be remembered for the whole visit).
// ======================================================================================================

const wbData = (overrides = {}, failed = []) => {
  const data = { population: null, density: null, birthRate: null, deathRate: null, growthRate: null, netMigration: null, lifeExpectancy: null, malePopulation: null, femalePopulation: null, ...overrides };
  Object.defineProperty(data, 'failedIndicators', { value: failed, enumerable: false });
  return data;
};
const withIncomplete = (facts, parts) => Object.defineProperty(facts, 'incompleteParts', { value: parts, enumerable: false });
const indexEntry = { iso2: 'BR', names: { common: 'Brazil', official: 'Brazil' }, coord: { lat: -10, lng: -55 } };

test('normalizeSummary lists which sources FAILED, apart from those that merely have no data', () => {
  const fine = normalizeSummary('BRA', [fulfilled({ officialName: 'X' }), fulfilled({ languages: ['P'] }), fulfilled(wbData({ population: { value: 1, year: 2024 } })), fulfilled(indexEntry)]);
  assert.deepEqual(fine.failedSources, []);

  assert.deepEqual(normalizeSummary('BRA', [rejected(), fulfilled({}), fulfilled(wbData()), fulfilled(indexEntry)]).failedSources, ['wikidata']);
  assert.deepEqual(normalizeSummary('BRA', [fulfilled({}), rejected(), fulfilled(wbData()), fulfilled(indexEntry)]).failedSources, ['wikidata']);
  assert.deepEqual(normalizeSummary('BRA', [rejected(), rejected(), fulfilled(wbData()), fulfilled(indexEntry)]).failedSources, ['wikidata'], 'listed once');
  assert.deepEqual(normalizeSummary('BRA', [fulfilled({}), fulfilled({}), rejected(), fulfilled(indexEntry)]).failedSources, ['worldbank']);
  assert.deepEqual(normalizeSummary('BRA', [rejected(), rejected(), rejected(), fulfilled(indexEntry)]).failedSources, ['wikidata', 'worldbank']);
});

test('one failed World Bank indicator marks the source as failed even though the rest arrived', () => {
  const result = normalizeSummary('BRA', [fulfilled({}), fulfilled({}), fulfilled(wbData({ population: { value: 5, year: 2024 } }, ['lifeExpectancy'])), fulfilled(indexEntry)]);
  assert.deepEqual(result.failedSources, ['worldbank']);
  assert.equal(result.population.value, 5);
});

test('the World Bank simply lacking data (Vatican City) is NOT a failure', () => {
  const result = normalizeSummary('VAT', [fulfilled({ officialName: 'Vatican City State' }), fulfilled({}), fulfilled(wbData()), fulfilled(indexEntry)]);
  assert.deepEqual(result.failedSources, []);
});

// Vatican City: the World Bank rejects its code, so without a fallback its population was "Not available".
test('population falls back to Wikidata\'s figure when the World Bank has none, and the World Bank still wins when it has one', () => {
  const wikidataPopulation = { value: 882, year: 2024 };
  const fallback = normalizeSummary('VAT', [fulfilled({ population: wikidataPopulation }), fulfilled({}), fulfilled(wbData()), fulfilled(indexEntry)]);
  assert.deepEqual(fallback.population, wikidataPopulation);
  const preferred = normalizeSummary('BRA', [fulfilled({ population: wikidataPopulation }), fulfilled({}), fulfilled(wbData({ population: { value: 212_812_405, year: 2025 } })), fulfilled(indexEntry)]);
  assert.equal(preferred.population.value, 212_812_405);
  assert.equal(normalizeSummary('XXX', [fulfilled({}), fulfilled({}), fulfilled(wbData()), fulfilled(null)]).population, null);
});

test('a Wikidata-only population still counts as Wikidata data being available', () => {
  const result = normalizeSummary('VAT', [fulfilled({ population: { value: 882, year: 2024 } }), fulfilled({}), fulfilled(wbData()), fulfilled(indexEntry)]);
  assert.equal(result.dataAvailability.wikidata, true);
});

// ---- the cache: failures are shown, never remembered -------------------------------------------------

function fakeDeps(overrides = {}) {
  const calls = { core: 0, lists: 0, demographics: 0, states: 0, pyramid: 0 };
  const deps = {
    calls,
    fetchWikidataCore: async () => { calls.core++; return { officialName: 'Federative Republic of Brazil', capital: { name: 'Brasília', coord: null }, areaKm2: 8515767 }; },
    fetchWikidataLists: async () => { calls.lists++; return { languages: ['Portuguese'], timeZones: ['UTC−03:00'] }; },
    fetchWorldBankDemographics: async () => { calls.demographics++; return wbData({ population: { value: 212_812_405, year: 2025 } }); },
    getEntryByIso3: async () => indexEntry,
    fetchStatesTerritories: async () => { calls.states++; return { count: 27, list: ['Acre'] }; },
    fetchReligions: async () => null,
    fetchMajorCitiesDynamic: async () => [],
    fetchTouristAttractions: async () => [],
    fetchWorldBankPyramid: async () => { calls.pyramid++; return Object.assign([{ band: '0004', male: { value: 1, year: 2024 }, female: { value: 1, year: 2024 } }], {}); },
    fetchCountryTopicSummaries: async () => ({}),
    ...overrides,
  };
  return deps;
}

test('a successful summary is cached: a second visit does not refetch', async () => {
  const deps = fakeDeps();
  const service = createDataService(deps);
  const first = await service.getCountrySummary('BRA');
  await service.getCountrySummary('bra');
  assert.equal(deps.calls.core, 1);
  assert.equal(deps.calls.demographics, 1);
  assert.deepEqual(first.failedSources, []);
});

test('simultaneous requests for one country share a single fetch', async () => {
  const deps = fakeDeps();
  const service = createDataService(deps);
  await Promise.all([service.getCountrySummary('BRA'), service.getCountrySummary('BRA'), service.getCountrySummary('BRA')]);
  assert.equal(deps.calls.core, 1);
});

// The reported bug: Brazil's summary hit a transient failure, was cached with empty fields, and the
// panel showed "Not available" for that country until the page was reloaded.
test('a summary with a failed source is returned but NOT remembered: the next visit tries again and recovers', async () => {
  let attempt = 0;
  const deps = fakeDeps({
    fetchWikidataCore: async () => {
      attempt++;
      if (attempt === 1) throw new Error('429 from Wikidata');
      return { officialName: 'Federative Republic of Brazil', capital: { name: 'Brasília', coord: null } };
    },
  });
  const service = createDataService(deps);

  const first = await service.getCountrySummary('BRA');
  assert.deepEqual(first.failedSources, ['wikidata']);
  assert.equal(first.capital, null, 'the panel still gets what did load (population) but no capital yet');
  assert.equal(first.population.value, 212_812_405);

  const second = await service.getCountrySummary('BRA');
  assert.deepEqual(second.failedSources, []);
  assert.equal(second.capital.name, 'Brasília');
  assert.equal(attempt, 2);

  await service.getCountrySummary('BRA');
  assert.equal(attempt, 2, 'and once it is complete it IS cached');
});

test('a partial World Bank failure is retried on the next visit too', async () => {
  let attempt = 0;
  const deps = fakeDeps({ fetchWorldBankDemographics: async () => { attempt++; return attempt === 1 ? wbData({ population: { value: 1, year: 2024 } }, ['lifeExpectancy']) : wbData({ population: { value: 1, year: 2024 }, lifeExpectancy: { value: 75, year: 2023 } }); } });
  const service = createDataService(deps);
  assert.deepEqual((await service.getCountrySummary('BRA')).failedSources, ['worldbank']);
  const again = await service.getCountrySummary('BRA');
  assert.deepEqual(again.failedSources, []);
  assert.equal(again.lifeExpectancy.value, 75);
});

test('clearCountryDataCache forgets one country (or all) so Retry really refetches', async () => {
  const deps = fakeDeps();
  const service = createDataService(deps);
  await service.getCountrySummary('BRA');
  await service.getCountrySummary('FRA');
  service.clearCountryDataCache('BRA');
  await service.getCountrySummary('BRA');
  await service.getCountrySummary('FRA');
  assert.equal(deps.calls.core, 3); // BRA twice, FRA once
  service.clearCountryDataCache();
  await service.getCountrySummary('FRA');
  assert.equal(deps.calls.core, 4);
});

test('full details add the states list and the pyramid, and are cached when complete', async () => {
  const deps = fakeDeps();
  const service = createDataService(deps);
  const details = await service.getCountryFullDetails('BRA');
  assert.deepEqual(details.statesTerritories, { count: 27, list: ['Acre'] });
  assert.equal(details.pyramidStatus, 'ok');
  assert.deepEqual(details.failedSources, []);
  await service.getCountryFullDetails('BRA');
  assert.equal(deps.calls.states, 1);
  assert.equal(deps.calls.pyramid, 1);
});

test('full details that lost their states list or pyramid to a failure are not remembered either', async () => {
  let attempt = 0;
  const deps = fakeDeps({ fetchStatesTerritories: async () => { attempt++; if (attempt === 1) throw new Error('busy'); return { count: 27, list: ['Acre'] }; } });
  const service = createDataService(deps);
  const first = await service.getCountryFullDetails('BRA');
  assert.deepEqual(first.failedSources, ['wikidata']);
  assert.deepEqual(first.statesTerritories, { count: 0, list: [] });
  const second = await service.getCountryFullDetails('BRA');
  assert.deepEqual(second.failedSources, []);
  assert.equal(second.statesTerritories.count, 27);
});

// ---- the population pyramid: three different situations, three different answers -----------------

const row = (male, female) => ({ band: '0004', male: male && { value: male, year: 2024 }, female: female && { value: female, year: 2024 } });
const withFailed = (rows, failed) => Object.defineProperty(rows, 'failedIndicators', { value: failed, enumerable: false });
const mergeWithPyramid = (pyramidResult) => mergeFullDetails(baseSummary, [fulfilled(null), fulfilled([]), fulfilled([]), pyramidResult, fulfilled({})]);

test('pyramidStatus: "ok" when there is age data', () => {
  assert.equal(mergeWithPyramid(fulfilled([row(10, 12), row(null, null)])).pyramidStatus, 'ok');
});

test('pyramidStatus: "no-data" when the World Bank has none for the place (Vatican City) — not a failure', () => {
  const result = mergeWithPyramid(fulfilled(withFailed([row(null, null), row(null, null)], [])));
  assert.equal(result.pyramidStatus, 'no-data');
  assert.deepEqual(result.failedSources, []);
});

test('pyramidStatus: "failed" when the requests failed, and the source is reported so a Retry is offered', () => {
  const failedRows = mergeWithPyramid(fulfilled(withFailed([row(null, null)], ['SP.POP.0004.MA', 'SP.POP.0004.FE'])));
  assert.equal(failedRows.pyramidStatus, 'failed');
  assert.deepEqual(failedRows.failedSources, ['worldbank']);
  const rejectedPyramid = mergeWithPyramid(rejected());
  assert.equal(rejectedPyramid.pyramidStatus, 'failed');
});

test('pyramidStatus: a chart with a few missing bars is "ok" but still flags the failure for Retry', () => {
  const result = mergeWithPyramid(fulfilled(withFailed([row(10, 12), row(null, null)], ['SP.POP.0509.MA'])));
  assert.equal(result.pyramidStatus, 'ok');
  assert.deepEqual(result.failedSources, ['worldbank']);
});

test('mergeFullDetails still works when the optional states result is missing', () => {
  const result = mergeFullDetails(baseSummary, [fulfilled(null), fulfilled([]), fulfilled([]), fulfilled([]), fulfilled({})]);
  assert.deepEqual(result.statesTerritories, { count: 0, list: [] });
});

// ======================================================================================================
// Incomplete Wikidata reads, per-source memory, deadlines, ordering, validation
// ======================================================================================================

test('normalizeSummary: a Wikidata read that lost part of itself (anthem recording, capital position) counts as failed', () => {
  const partial = withIncomplete({ officialName: 'Russia', anthem: { title: 'Anthem', oggUrl: null, mp3Url: null, license: null } }, ['anthem recording']);
  const result = normalizeSummary('RUS', [fulfilled(partial), fulfilled({}), fulfilled(wbData({ population: { value: 1, year: 2024 } })), fulfilled(indexEntry)]);
  assert.deepEqual(result.failedSources, ['wikidata']);
  assert.equal(result.anthem.title, 'Anthem', 'and what did arrive is still shown');
  const complete = normalizeSummary('RUS', [fulfilled(withIncomplete({ officialName: 'Russia' }, [])), fulfilled({}), fulfilled(wbData()), fulfilled(indexEntry)]);
  assert.deepEqual(complete.failedSources, []);
});

test('an incomplete Wikidata read is returned but not remembered: the next visit completes it', async () => {
  let attempt = 0;
  const deps = fakeDeps({
    fetchWikidataCore: async () => {
      attempt++;
      return withIncomplete({ officialName: 'Russia', anthem: { title: 'Anthem', oggUrl: attempt === 1 ? null : 'https://x/a.ogg', mp3Url: null, license: null } }, attempt === 1 ? ['anthem recording'] : []);
    },
  });
  const service = createDataService(deps);
  const first = await service.getCountrySummary('RUS');
  assert.deepEqual(first.failedSources, ['wikidata']);
  assert.equal(first.anthem.oggUrl, null);
  const second = await service.getCountrySummary('RUS');
  assert.deepEqual(second.failedSources, []);
  assert.equal(second.anthem.oggUrl, 'https://x/a.ogg');
  await service.getCountrySummary('RUS');
  assert.equal(attempt, 2, 'complete now, so cached');
});

// ---- per-source memory: "Try again" asks again only for what failed ------------------------------------

// Found by review: a Wikidata-only failure re-downloaded all 43 World Bank indicators on Try again.
test('after a Wikidata failure, the next attempt re-requests Wikidata only — the World Bank answer is kept', async () => {
  let attempt = 0;
  const deps = fakeDeps({ fetchWikidataCore: async () => { attempt++; if (attempt === 1) throw new Error('429'); return { officialName: 'Brazil' }; } });
  const service = createDataService(deps);
  assert.deepEqual((await service.getCountrySummary('BRA')).failedSources, ['wikidata']);
  assert.deepEqual((await service.getCountrySummary('BRA')).failedSources, []);
  assert.equal(attempt, 2);
  assert.equal(deps.calls.demographics, 1, 'the World Bank was asked once');
  assert.equal(deps.calls.lists, 1, 'and so was the (successful) Wikidata lists read');
});

test('on the country page, a failed pyramid is re-requested alone; states, cities and the summary are not', async () => {
  let pyramidAttempt = 0;
  const deps = fakeDeps({
    fetchWorldBankPyramid: async () => {
      pyramidAttempt++;
      if (pyramidAttempt === 1) throw new Error('busy');
      return [{ band: '0004', male: { value: 1, year: 2024 }, female: { value: 1, year: 2024 } }];
    },
  });
  const service = createDataService(deps);
  const first = await service.getCountryFullDetails('BRA');
  assert.deepEqual(first.failedSources, ['worldbank']);
  assert.equal(first.pyramidStatus, 'failed');
  const second = await service.getCountryFullDetails('BRA');
  assert.deepEqual(second.failedSources, []);
  assert.equal(second.pyramidStatus, 'ok');
  assert.deepEqual({ core: deps.calls.core, lists: deps.calls.lists, demographics: deps.calls.demographics, states: deps.calls.states, pyramid: pyramidAttempt }, { core: 1, lists: 1, demographics: 1, states: 1, pyramid: 2 });
});

test('the summary\'s sources are not refetched for the country page (or the reverse)', async () => {
  const deps = fakeDeps();
  const service = createDataService(deps);
  await service.getCountrySummary('BRA');
  await service.getCountryFullDetails('BRA');
  assert.deepEqual({ core: deps.calls.core, lists: deps.calls.lists, demographics: deps.calls.demographics }, { core: 1, lists: 1, demographics: 1 });
});

test('a partial result (a World Bank indicator failed) is re-requested; a complete one is not', async () => {
  let attempt = 0;
  const deps = fakeDeps({ fetchWorldBankDemographics: async () => { attempt++; return wbData({ population: { value: 1, year: 2024 } }, attempt === 1 ? ['lifeExpectancy'] : []); } });
  const service = createDataService(deps);
  await service.getCountrySummary('BRA');
  await service.getCountrySummary('BRA');
  await service.getCountrySummary('BRA');
  assert.equal(attempt, 2);
});

test('clearCountryDataCache forgets the per-source answers too, not just the assembled result', async () => {
  const deps = fakeDeps();
  const service = createDataService(deps);
  await service.getCountryFullDetails('BRA');
  service.clearCountryDataCache('BRA');
  await service.getCountryFullDetails('BRA');
  assert.deepEqual({ core: deps.calls.core, demographics: deps.calls.demographics, pyramid: deps.calls.pyramid }, { core: 2, demographics: 2, pyramid: 2 });
});

// Mutation testing by review: removing the identity guard left every test green. This is the case it exists
// for: a slow attempt that fails AFTER the cache was cleared and a newer, good attempt was stored must not
// delete the newer one. (The per-source memory would mask a re-fetch, so what is checked is that the very
// same assembled result is still the cached one.)
test('a slow attempt that fails after a clear + fresh success does not evict the fresh result', async () => {
  let attempt = 0;
  let failFirst;
  const deps = fakeDeps({
    fetchWikidataCore: async () => {
      attempt++;
      if (attempt === 1) return new Promise((resolve, reject) => { failFirst = () => reject(new Error('finally failed')); });
      return { officialName: 'Brazil' };
    },
  });
  const service = createDataService(deps);
  const slow = service.getCountrySummary('BRA'); // attempt 1: still pending
  service.clearCountryDataCache('BRA');
  const fresh = await service.getCountrySummary('BRA'); // attempt 2: succeeds and is cached
  assert.deepEqual(fresh.failedSources, []);
  failFirst();
  assert.deepEqual((await slow).failedSources, ['wikidata']);
  assert.equal(await service.getCountrySummary('BRA'), fresh, 'the fresh result is still the cached one');
});

test('the same holds for the country page: a late failure of an old attempt does not evict the newer result', async () => {
  let failFirst;
  let pyramidAttempt = 0;
  const deps = fakeDeps({
    fetchWorldBankPyramid: async () => {
      pyramidAttempt++;
      if (pyramidAttempt === 1) return new Promise((resolve, reject) => { failFirst = () => reject(new Error('finally failed')); });
      return [{ band: '0004', male: { value: 1, year: 2024 }, female: { value: 1, year: 2024 } }];
    },
  });
  const service = createDataService(deps);
  const slow = service.getCountryFullDetails('BRA');
  service.clearCountryDataCache('BRA');
  const fresh = await service.getCountryFullDetails('BRA');
  assert.deepEqual(fresh.failedSources, []);
  failFirst();
  assert.deepEqual((await slow).failedSources, ['worldbank']);
  assert.equal(await service.getCountryFullDetails('BRA'), fresh);
});

// ---- deadlines: one hung source must not hold the whole panel -------------------------------------------

test('a source that never answers is given up on at the deadline; the rest of the country still shows', async () => {
  const deps = fakeDeps({ fetchWikidataCore: () => new Promise(() => {}) });
  const service = createDataService(deps, { deadlineMs: 30 });
  const summary = await service.getCountrySummary('BRA');
  assert.deepEqual(summary.failedSources, ['wikidata']);
  assert.equal(summary.population.value, 212_812_405);
  assert.equal(summary.capital, null);
});

test('an answer that arrives after the deadline is kept, so Try again does not ask twice', async () => {
  let asked = 0;
  const deps = fakeDeps({ fetchWikidataCore: () => { asked++; return new Promise((resolve) => setTimeout(() => resolve({ officialName: 'Brazil', capital: { name: 'Brasília', coord: null } }), 80)); } });
  const service = createDataService(deps, { deadlineMs: 20 });
  assert.deepEqual((await service.getCountrySummary('BRA')).failedSources, ['wikidata']);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const again = await service.getCountrySummary('BRA');
  assert.deepEqual(again.failedSources, []);
  assert.equal(again.capital.name, 'Brasília');
  assert.equal(asked, 1);
});

// ---- ordering: independent sources do not wait for the summary --------------------------------------------

// Found by review: the pyramid, subdivisions, Wikipedia and Query Service reads all waited for the whole
// summary chain (up to ~2 minutes when Wikidata was struggling), though none of them needs anything from it.
test('the country page starts its independent sources at once, without waiting for the summary', async () => {
  let releaseCore;
  const deps = fakeDeps({ fetchWikidataCore: () => new Promise((resolve) => { releaseCore = () => resolve({ officialName: 'Brazil' }); }) });
  const service = createDataService(deps);
  const pending = service.getCountryFullDetails('BRA');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual({ states: deps.calls.states, pyramid: deps.calls.pyramid }, { states: 1, pyramid: 1 }, 'started while the core is still outstanding');
  releaseCore();
  const details = await pending;
  assert.equal(details.nameOfficial, 'Brazil');
});

test('the topic narratives are looked up under the country\'s common name from the bundled index', async () => {
  const askedFor = [];
  const deps = fakeDeps({ fetchCountryTopicSummaries: async (name) => { askedFor.push(name); return {}; } });
  await createDataService(deps).getCountryFullDetails('BRA');
  assert.deepEqual(askedFor, ['Brazil']);
});

// ---- the boundary: only real codes get in, and bugs are not remembered ----------------------------------

test('only three-letter country codes are accepted (they end up in URLs and queries); nothing is fetched otherwise', async () => {
  const deps = fakeDeps();
  const service = createDataService(deps);
  for (const bad of ['', 'BR', 'BRAZ', 'B1A', '../x', 'BR"', null, undefined, 123]) {
    await assert.rejects(service.getCountrySummary(bad), TypeError, String(bad));
    await assert.rejects(service.getCountryFullDetails(bad), TypeError, String(bad));
  }
  assert.deepEqual(deps.calls, { core: 0, lists: 0, demographics: 0, states: 0, pyramid: 0 });
  assert.equal((await service.getCountrySummary('bra')).iso3, 'BRA');
});

test('a fetcher that throws instead of returning a rejected promise is a failed source, not a crash', async () => {
  const deps = fakeDeps({ fetchWikidataCore: () => { throw new Error('sync boom'); } });
  const summary = await createDataService(deps).getCountrySummary('BRA');
  assert.deepEqual(summary.failedSources, ['wikidata']);
});

test('a rejected result is not cached forever: a one-off fault while assembling does not poison the next attempt', async () => {
  let reads = 0;
  // the source answers fine (and is remembered); it is the merge that trips over it, once
  const entry = { iso2: 'BR', coord: null, get names() { if (++reads === 1) throw new Error('bad index'); return { common: 'Brazil', official: 'Brazil' }; } };
  const service = createDataService(fakeDeps({ getEntryByIso3: async () => entry }));
  await assert.rejects(service.getCountrySummary('BRA'), /bad index/);
  assert.equal((await service.getCountrySummary('BRA')).nameCommon, 'Brazil');
  assert.equal((await service.getCountryFullDetails('BRA')).nameCommon, 'Brazil');
});

// ---- Wikipedia: a failed narrative lookup is reported like any other failed source -------------------------

const withIncompleteTopics = (topics, parts) => Object.defineProperty(topics, 'incompleteParts', { value: parts, enumerable: false });

test('mergeFullDetails: topics whose lookup failed (or a topics read that rejected) make Wikipedia a failed source', () => {
  const merge = (topicsResult) => mergeFullDetails(baseSummary, [fulfilled(null), fulfilled([]), fulfilled([]), fulfilled([]), topicsResult]);
  assert.deepEqual(merge(fulfilled(withIncompleteTopics({ culture: null, history: { extract: 'H' } }, ['culture']))).failedSources, ['wikipedia']);
  assert.deepEqual(merge(rejected()).failedSources, ['wikipedia']);
  assert.deepEqual(merge(fulfilled(withIncompleteTopics({ culture: null }, []))).failedSources, [], 'no article is not a failure');
  const partial = merge(fulfilled(withIncompleteTopics({ history: { extract: 'H' }, culture: null }, ['culture'])));
  assert.equal(partial.historyNarrative, 'H', 'what did arrive is still used');
});

test('a failed narrative lookup is not remembered: Try again re-requests the topics alone', async () => {
  let attempt = 0;
  const deps = fakeDeps({ fetchCountryTopicSummaries: async () => { attempt++; return withIncompleteTopics({ culture: attempt === 1 ? null : { extract: 'C' } }, attempt === 1 ? ['culture'] : []); } });
  const service = createDataService(deps);
  const first = await service.getCountryFullDetails('BRA');
  assert.deepEqual(first.failedSources, ['wikipedia']);
  const second = await service.getCountryFullDetails('BRA');
  assert.deepEqual(second.failedSources, []);
  assert.equal(second.cultureNarrative, 'C');
  assert.deepEqual({ core: deps.calls.core, demographics: deps.calls.demographics, pyramid: deps.calls.pyramid, topics: attempt }, { core: 1, demographics: 1, pyramid: 1, topics: 2 });
});

// ======================================================================================================
// Review round 3: the optional extras, stale requests, the failure hook, and mutation survivors
// ======================================================================================================

const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emptyButFailed = (empty, part = 'query service') => Object.defineProperty(empty, 'incompleteParts', { value: [part], enumerable: false });

// ---- M1: an optional Query Service extra failing is not "no data", and is not remembered ---------------------

// Found by review: with the Query Service answering 429, a country's page had failedSources=[], cities were just
// the capital, and after the service recovered there was no new request — the failure was remembered as an answer.
// The extras stay best-effort (no notice: they have fallbacks), but a failure of one is never kept.
test('a failed Query Service extra shows its fallback WITHOUT a notice, but is not remembered: the next read asks again', async () => {
  let attempt = 0;
  const deps = fakeDeps({
    fetchReligions: async () => (++attempt === 1 ? emptyButFailed([]) : [{ religion: 'Hinduism', percent: 80 }]),
    fetchMajorCitiesDynamic: async () => (attempt === 1 ? emptyButFailed([]) : [{ name: 'Mumbai', coord: { lat: 19, lng: 72 } }]),
  });
  const service = createDataService(deps);
  const first = await service.getCountryFullDetails('BRA');
  assert.deepEqual(first.failedSources, [], 'best-effort: no pointless Try again while the service is throttled');
  assert.equal(first.religions, null);
  assert.deepEqual(first.majorCities.map((c) => c.name), ['Brasília'], 'the capital stands in');

  const second = await service.getCountryFullDetails('BRA');
  assert.equal(second.religions, 'Hinduism (80.0%)');
  assert.deepEqual(second.majorCities.map((c) => c.name), ['Mumbai']);
  assert.deepEqual({ core: deps.calls.core, demographics: deps.calls.demographics, pyramid: deps.calls.pyramid }, { core: 1, demographics: 1, pyramid: 1 }, 'only the extras were asked again');
});

test('a complete set of extras IS remembered', async () => {
  const deps = fakeDeps({ fetchReligions: async () => null });
  const service = createDataService(deps);
  const first = await service.getCountryFullDetails('BRA');
  assert.equal(await service.getCountryFullDetails('BRA'), first);
});

// ---- M2: a request a caller has given up waiting for is not shared with the next ask -------------------------------

// Found by review: with a hung request, each Try again waited a whole deadline on the SAME request (asked stayed 1).
test('Try again after a request has hung past the deadline starts a NEW request instead of re-waiting on the hung one', async () => {
  let asked = 0;
  const deps = fakeDeps({ fetchWikidataCore: () => (++asked === 1 ? new Promise(() => {}) : Promise.resolve({ officialName: 'Brazil', capital: { name: 'Brasília', coord: null } })) });
  const service = createDataService(deps, { deadlineMs: 30 });
  assert.deepEqual((await service.getCountrySummary('BRA')).failedSources, ['wikidata']);
  const again = await service.getCountrySummary('BRA');
  assert.equal(asked, 2, 'a second request was made');
  assert.deepEqual(again.failedSources, []);
  assert.equal(again.capital.name, 'Brasília');
});

test('…but a request nobody has given up on yet is shared, not duplicated', async () => {
  let asked = 0;
  let release;
  const deps = fakeDeps({ fetchWikidataCore: () => { asked++; return new Promise((resolve) => { release = () => resolve({ officialName: 'Brazil' }); }); } });
  const service = createDataService(deps, { deadlineMs: 5_000 });
  const summary = service.getCountrySummary('BRA');
  const details = service.getCountryFullDetails('BRA'); // asks for the same sources while they are pending
  await later(10);
  release();
  await Promise.all([summary, details]);
  assert.equal(asked, 1);
});

test('the abandoned request that answers first is adopted, so a later ask does not repeat it', async () => {
  let asked = 0;
  const deps = fakeDeps({
    fetchWikidataCore: () => {
      asked++;
      if (asked === 1) return later(150).then(() => ({ officialName: 'Brazil', capital: { name: 'Brasília', coord: null } })); // slow, but it does answer
      return new Promise(() => {}); // the second attempt hangs
    },
  });
  const service = createDataService(deps, { deadlineMs: 40 });
  await service.getCountrySummary('BRA'); // gives up at 40 ms
  await service.getCountrySummary('BRA'); // attempt 2 starts (and hangs); gives up too
  assert.equal(asked, 2);
  await later(100); // …the first attempt answers at 150 ms, and is adopted
  const third = await service.getCountrySummary('BRA');
  assert.equal(asked, 2, 'no third request: the answer that did arrive was kept');
  assert.deepEqual(third.failedSources, []);
  assert.equal(third.capital.name, 'Brasília');
});

// The summary is kept incomplete on purpose (the World Bank fails twice), so that what is being checked is the
// per-source memory and not the assembled-summary cache in front of it.
test('an abandoned attempt that fails late does not evict a newer, good answer', async () => {
  let asked = 0;
  let worldBank = 0;
  const deps = fakeDeps({
    fetchWikidataCore: () => {
      asked++;
      if (asked === 1) return later(120).then(() => { throw new Error('finally failed'); });
      return Promise.resolve({ officialName: 'Brazil', capital: { name: 'Brasília', coord: null } });
    },
    fetchWorldBankDemographics: async () => { if (++worldBank < 3) throw new Error('busy'); return wbData({ population: { value: 1, year: 2024 } }); },
  });
  const service = createDataService(deps, { deadlineMs: 40 });
  await service.getCountrySummary('BRA'); // attempt 1 is abandoned at 40 ms
  const second = await service.getCountrySummary('BRA'); // attempt 2 answers at once; the World Bank is still down
  assert.deepEqual(second.failedSources, ['worldbank']);
  await later(120); // attempt 1 finally fails
  const third = await service.getCountrySummary('BRA');
  assert.deepEqual(third.failedSources, []);
  assert.equal(asked, 2, 'the good answer of attempt 2 survived the late failure of attempt 1');
});

// ---- the failure hook -----------------------------------------------------------------------------------------

test('a source that fails, or comes back partial, is reported to the hook with its reason — and a healthy read reports nothing', async () => {
  const reports = [];
  const boom = new Error('payload changed');
  const deps = fakeDeps({
    fetchWikidataCore: async () => { throw boom; },
    fetchWorldBankDemographics: async () => wbData({ population: { value: 1, year: 2024 } }, ['lifeExpectancy']),
  });
  await createDataService(deps, { report: (problem) => reports.push(problem) }).getCountrySummary('BRA');
  assert.deepEqual(reports.map(({ source, code }) => `${source}:${code}`).sort(), ['core:BRA', 'demographics:BRA']);
  assert.equal(reports.find((r) => r.source === 'core').error, boom);
  assert.deepEqual(reports.find((r) => r.source === 'demographics').incompleteParts, ['lifeExpectancy']);

  const quiet = [];
  await createDataService(fakeDeps(), { report: (problem) => quiet.push(problem) }).getCountryFullDetails('BRA');
  assert.deepEqual(quiet, []);
});

// ---- mutation survivors named by the review -------------------------------------------------------------------

test('the summary\'s sources are asked for before the country page\'s extras (they are first in line at shared hosts)', async () => {
  const order = [];
  const record = (name, result) => async () => { order.push(name); return result; };
  const deps = fakeDeps({
    fetchWikidataCore: record('core', { officialName: 'Brazil' }),
    fetchWikidataLists: record('lists', { languages: [], timeZones: [] }),
    fetchWorldBankDemographics: record('demographics', wbData()),
    fetchReligions: record('religions', null),
    fetchMajorCitiesDynamic: record('cities', []),
    fetchWorldBankPyramid: record('pyramid', []),
    fetchStatesTerritories: record('states', { count: 0, list: [] }),
  });
  await createDataService(deps).getCountryFullDetails('BRA');
  const last = Math.max(order.indexOf('core'), order.indexOf('lists'), order.indexOf('demographics'));
  const firstExtra = Math.min(order.indexOf('religions'), order.indexOf('cities'), order.indexOf('pyramid'), order.indexOf('states'));
  assert.ok(last < firstExtra, order.join(' '));
});

test('a rejected country-page assembly is not remembered (the full path, not just the summary)', async () => {
  let reads = 0;
  // A complete answer the MERGE trips over, once: the source is remembered, the assembled page must not be.
  const religions = [{ percent: 80, get religion() { if (++reads === 1) throw new Error('bad religion row'); return 'Catholicism'; } }];
  const service = createDataService(fakeDeps({ fetchReligions: async () => religions }));
  await assert.rejects(service.getCountryFullDetails('BRA'), /bad religion row/);
  assert.equal((await service.getCountryFullDetails('BRA')).religions, 'Catholicism (80.0%)');
});

test('Wikidata data counts as available when only the lists have anything (no core facts)', () => {
  const result = normalizeSummary('XXX', [fulfilled({}), fulfilled({ languages: ['Portuguese'] }), fulfilled(wbData()), fulfilled(indexEntry)]);
  assert.equal(result.dataAvailability.wikidata, true);
  assert.equal(normalizeSummary('XXX', [fulfilled({}), fulfilled({ languages: [] }), fulfilled(wbData()), fulfilled(indexEntry)]).dataAvailability.wikidata, false);
});

// ---- an unknown code is not an outage -----------------------------------------------------------------------------

test('a code that is not in the index says so (no country to load), rather than looking like a failure worth retrying', () => {
  const unknown = normalizeSummary('ZZZ', [rejected(), rejected(), fulfilled(wbData()), fulfilled(null)]);
  assert.equal(unknown.isKnownCountry, false);
  assert.equal(normalizeSummary('BRA', [rejected(), rejected(), fulfilled(wbData()), fulfilled(indexEntry)]).isKnownCountry, true);
  assert.equal(normalizeSummary('BRA', [rejected(), rejected(), fulfilled(wbData()), rejected()]).isKnownCountry, true, 'if the index itself failed to load we cannot claim the code is unknown');
});

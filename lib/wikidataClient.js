// Live Wikidata access — no key, CORS-enabled.
//
// A country's own facts (name, capital, area, currencies, continents, languages, time zones, flag,
// heads of state, anthem, population) are read straight off its Wikidata item through the ACTION API
// (www.wikidata.org/w/api.php: wbgetentities / wbgetclaims). They used to come from two big SPARQL
// queries against the Wikidata Query Service, and that service is the wrong tool for the job: it is
// throttled per client, and under load even a one-fact query takes 30-60 s or is refused with 429 —
// so a country's panel showed "Not available" for the capital, area, time zones and anthem while the
// World Bank half (population) loaded fine. The Action API is cached, fast (~1-3 s) and does not
// share that queue. The Query Service is still used, but only for the optional, list-shaped extras on
// the full country page (major cities, attractions, religions), each with a local fallback.
//
// Every request retries transient failures (see http.js). A failure that survives the retries makes
// the read REJECT, so the caller can tell "the service failed" (offer a Retry) from "Wikidata has no
// such fact" (null / empty).

import { fetchJson } from './http.js';
import { createMediaWikiGet } from './mediaWikiApi.js';
import * as WD from './wikidataEntity.js';

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
const WD_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const BUNDLED_IDS_URL = 'data/wikidata-ids.json';

// Our app's canonical ISO alpha-3 (matches World Bank and the bundled search index)
// vs. the value actually carried by Wikidata's best-rank P298 statement, where they
// differ. Kosovo is the one confirmed case: Wikidata's best-rank P298 is "XKS", while
// World Bank and everyday usage use "XKX".
const WIKIDATA_ISO3_OVERRIDES = { XKX: 'XKS' };

function wikidataIso3(iso3) {
  return WIKIDATA_ISO3_OVERRIDES[iso3] || iso3;
}

const ACTION_API_TIMEOUT_MS = 12_000;
const LABEL_BATCH_SIZE = 50; // wbgetentities' limit for anonymous clients
const MAX_STATE_LABELS = 150; // enough for the biggest federations; the count is always the full one
const ENTITY_SHARE_MS = 20_000; // one country entity is ~1 MB: shared by the panel's reads, then dropped

function deriveTranscodedMp3Url(oggUrl) {
  const match = oggUrl.match(/\/commons\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+)$/);
  if (!match) return null;
  const [, h1, h2, name] = match;
  return `https://upload.wikimedia.org/wikipedia/commons/transcoded/${h1}/${h2}/${name}/${name}.mp3`;
}

function stripHtml(html) {
  if (!html) return null;
  const text = html.replace(/<[^>]*>/g, '').trim();
  return text || null;
}

export function commonsFilePath(fileName) {
  return fileName ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fileName)}` : null;
}

/**
 * The network layer: everything that talks to Wikidata's Action API or Commons. Built over an injected
 * `fetchJson` (and `sleep`) so the parts that only ever run on a live connection — transient-error
 * retry, label batching and caching, ISO-code lookup, Commons parsing — are testable with a fake.
 * Caches live in the instance, not in module globals.
 * @param {{fetchJson?: typeof fetchJson, sleep?: (ms: number) => Promise<void>, bundledIdsRetries?: number}} [deps]
 */
export function createWikidataApi({ fetchJson: fetchJsonImpl = fetchJson, sleep, bundledIdsRetries = 1 } = {}) {
  // Every Action API request (Wikidata's and Commons') goes through the shared helper, which retries what is
  // worth retrying and treats an HTTP-200 {error} body as the failure it is.
  const mediaWikiGet = createMediaWikiGet({ fetchJson: fetchJsonImpl, sleep });
  const actionApi = (params) => mediaWikiGet(`${WD_API}?${new URLSearchParams({ ...params, format: 'json', origin: '*' })}`, { timeoutMs: ACTION_API_TIMEOUT_MS });

  // ---- ISO code -> Wikidata item ---------------------------------------------------------------------
  let bundledIds = null;
  function loadBundledIds() {
    // data/wikidata-ids.json is built by scripts/build-wikidata-ids.mjs. If it cannot be read the search
    // below still works, just with one more request — and the failure is NOT remembered: the next
    // lookup tries the file again.
    if (!bundledIds) {
      const attempt = fetchJsonImpl(BUNDLED_IDS_URL, { retries: bundledIdsRetries, timeoutMs: 8000, sleep }).catch(() => {
        if (bundledIds === attempt) bundledIds = null;
        return {};
      });
      bundledIds = attempt;
    }
    return bundledIds;
  }

  async function resolveQid(iso3) {
    const bundled = (await loadBundledIds())[iso3];
    if (bundled) return bundled;
    const body = await actionApi({ action: 'query', list: 'search', srsearch: `haswbstatement:P298=${wikidataIso3(iso3)}`, srlimit: 5 });
    return body.query?.search?.[0]?.title ?? null;
  }

  // ---- labels, one shared cache: "Euro", "UTC+01:00", "South America" recur across countries ----------
  const labelPromises = new Map(); // qid -> Promise<string | null>

  function getLabels(ids) {
    const wanted = [...new Set(ids)];
    const missing = wanted.filter((id) => !labelPromises.has(id));
    for (let i = 0; i < missing.length; i += LABEL_BATCH_SIZE) {
      const chunk = missing.slice(i, i + LABEL_BATCH_SIZE);
      const batch = actionApi({ action: 'wbgetentities', ids: chunk.join('|'), props: 'labels|sitelinks', languages: 'en', sitefilter: 'enwiki' }).then((body) => body.entities ?? {});
      for (const id of chunk) {
        const promise = batch.then((entities) => {
          // An id the API left out of a 200 answer is an anomaly, not "no label": caching it would hide
          // the name for the rest of the visit.
          if (!Object.hasOwn(entities, id)) throw new Error(`Wikidata returned no entry for ${id}`);
          return WD.labelOf(entities[id]);
        });
        promise.catch(() => labelPromises.delete(id)); // a failed batch must not poison the cache: the next read asks again
        labelPromises.set(id, promise);
      }
    }
    return Promise.all(wanted.map((id) => labelPromises.get(id))).then((labels) => new Map(wanted.map((id, i) => [id, labels[i]])));
  }

  // ---- Commons (the anthem recording) -----------------------------------------------------------------
  async function getCommonsFileInfo(fileName) {
    const params = new URLSearchParams({ action: 'query', prop: 'imageinfo', titles: `File:${fileName}`, iiprop: 'url|extmetadata', format: 'json', origin: '*' });
    const body = await mediaWikiGet(`${COMMONS_API}?${params}`, { timeoutMs: 10_000, retries: 1 });
    // A query that finds no such file is an answer (null); an answer with no query result at all is a failure.
    if (!body?.query?.pages || typeof body.query.pages !== 'object') throw new Error('Commons returned no query result');
    const info = Object.values(body.query.pages)[0]?.imageinfo?.[0];
    if (!info?.url) return null;
    const oggUrl = info.url.split('?')[0];
    return {
      oggUrl,
      mp3Url: deriveTranscodedMp3Url(oggUrl),
      license: {
        shortName: info.extmetadata?.LicenseShortName?.value || null,
        credit: stripHtml(info.extmetadata?.Credit?.value),
      },
    };
  }

  return {
    resolveQid,
    getEntity: async (qid) => (await actionApi({ action: 'wbgetentities', ids: qid, props: 'claims' })).entities?.[qid] ?? null,
    getLabels,
    getClaims: (qid, property) => actionApi({ action: 'wbgetclaims', entity: qid, property }),
    getCommonsFileInfo,
  };
}

/** The real network implementation of what createWikidataFacts needs. */
export const wikidataApi = createWikidataApi();

// India's P2936 ("languages spoken/written/signed") lists 300+ regional and minority
// languages — real data, but not what the spec's "official/main languages" field wants.
// P37 (official language) alone is used whenever it's non-empty; P2936 only tops it up
// when the gap is small (confirmed case: USA's P37 already lists the territorial
// co-official languages but omits English, since English has no de jure federal status —
// P2936 adds exactly that one extra entry).
const LANGUAGE_TOP_UP_LIMIT = 6;
const LANGUAGE_FALLBACK_CAP = 15;

export function mergeLanguages(officialLangs, spokenLangs) {
  if (officialLangs.length === 0) return spokenLangs.slice(0, LANGUAGE_FALLBACK_CAP);
  const extra = spokenLangs.filter((l) => !officialLangs.includes(l));
  return extra.length > 0 && extra.length <= LANGUAGE_TOP_UP_LIMIT ? [...officialLangs, ...extra] : officialLangs;
}

const unique = (items) => [...new Set(items.filter(Boolean))];

/**
 * The country-facts reader, built over an `api` (the real one above, or a fake in tests).
 * @param {typeof wikidataApi} api
 */
export function createWikidataFacts(api) {
  const shared = new Map(); // iso3 -> Promise<entity>

  // The country item is ~1 MB, and core + lists + states all read it: fetch it once per visit to a
  // country and drop it shortly after, rather than holding a megabyte per country ever selected.
  function getCountryEntity(iso3) {
    if (!shared.has(iso3)) {
      const promise = (async () => {
        const qid = await api.resolveQid(iso3);
        if (!qid) throw new Error(`No Wikidata item found for ${iso3}`);
        const entity = await api.getEntity(qid);
        if (!entity) throw new Error(`Wikidata returned no item for ${qid}`);
        return entity;
      })();
      shared.set(iso3, promise);
      promise.then(
        () => setTimeout(() => shared.delete(iso3), ENTITY_SHARE_MS).unref?.(), // unref: a Node script must not idle for 20 s waiting on it
        () => shared.delete(iso3) // a failure is never remembered: the next attempt starts fresh
      );
    }
    return shared.get(iso3);
  }

  // The recording is looked up in up to two further requests. When one FAILS (as opposed to finding
  // nothing) the anthem is returned as far as it got and `onIncomplete` is told, so the caller can flag
  // the read as partial rather than let a throttled request be cached as "this country has no recording".
  async function readAnthem(anthemId, statement, label, onIncomplete) {
    // The recording may be attached to the statement itself (Russia's is) or to the anthem's own item.
    let fileName = WD.qualifierCommonsFile(statement, 'P51');
    if (!fileName) {
      const claims = await api.getClaims(anthemId, 'P51').catch(() => { onIncomplete('anthem recording'); return null; });
      fileName = WD.commonsFile(claims, 'P51');
    }
    const info = fileName ? await api.getCommonsFileInfo(fileName).catch(() => { onIncomplete('anthem recording'); return null; }) : null;
    return {
      title: label,
      oggUrl: info?.oggUrl || commonsFilePath(fileName), // Special:FilePath still resolves if the file-info lookup failed
      mp3Url: info?.mp3Url || null,
      license: info?.license || null,
    };
  }

  async function core(iso3) {
    const entity = await getCountryEntity(iso3);
    // Single-valued facts take the best statement; multi-valued ones (currencies, continents) take all.
    const capitalId = WD.bestEntityId(entity, 'P36');
    const currencyIds = WD.currentEntityIds(entity, 'P38');
    const continentIds = WD.currentEntityIds(entity, 'P30');
    const governmentFormId = WD.bestEntityId(entity, 'P122');
    const headOfStateId = WD.bestEntityId(entity, 'P35');
    const headOfGovernmentId = WD.bestEntityId(entity, 'P6');
    const anthemStatement = WD.bestStatement(entity, 'P85');
    const anthemId = anthemStatement?.mainsnak?.datavalue?.value?.id ?? null;

    // Sub-requests that may fail on their own leave the read usable but incomplete (see readAnthem).
    const incompleteParts = [];
    const markIncomplete = (part) => { if (!incompleteParts.includes(part)) incompleteParts.push(part); };

    const labelIds = unique([capitalId, ...currencyIds, ...continentIds, governmentFormId, headOfStateId, headOfGovernmentId, anthemId]);
    // readAnthem's network requests (P51 claim + file-info) have no dependency on the label batch,
    // so start it in parallel. The anthem title is patched in once labels resolve.
    const [labels, capitalCoord, anthemRaw] = await Promise.all([
      api.getLabels(labelIds),
      capitalId ? api.getClaims(capitalId, 'P625').then((claims) => WD.coordinate(claims, 'P625')).catch(() => { markIncomplete('capital coordinates'); return null; }) : null,
      anthemId ? readAnthem(anthemId, anthemStatement, null, markIncomplete) : null,
    ]);
    const label = (id) => (id ? labels.get(id) ?? null : null);
    const anthem = anthemRaw ? { ...anthemRaw, title: label(anthemId) } : null;

    // A meaningful number of presidential-republic Wikidata items only tag the office under P6 (head of
    // government); P35 (head of state) is left empty because the same person fills both roles. Confirmed
    // for the United States. Falling back to the P6 holder reads an existing fact (the offices are
    // combined), it does not invent one.
    const headOfState = headOfStateId ? label(headOfStateId) : label(headOfGovernmentId);

    const facts = {
      officialName: WD.englishText(entity, 'P1448'),
      capital: capitalId ? { name: label(capitalId), coord: capitalCoord } : null,
      centerCoord: WD.coordinate(entity, 'P625'),
      areaKm2: WD.areaKm2(entity),
      // A list, not one scalar: France genuinely has more than one current currency (the Euro, and the
      // CFP Franc for its Pacific territories).
      currencies: unique(currencyIds.map(label)),
      continents: unique(continentIds.map(label)),
      flagUrl: commonsFilePath(WD.commonsFile(entity, 'P41')),
      formationDate: WD.timeValue(entity, 'P571'),
      governmentForm: label(governmentFormId),
      headOfState,
      headOfGovernment: label(headOfGovernmentId),
      population: WD.latestQuantity(entity, 'P1082'), // the fallback for places the World Bank does not cover (the Vatican)
      anthem,
    };
    // Non-enumerable, like the World Bank's `failedIndicators`: it never shows up when the facts are
    // spread, iterated or checked for "has any value", but dataService can read it.
    return Object.defineProperty(facts, 'incompleteParts', { value: incompleteParts, enumerable: false });
  }

  async function lists(iso3) {
    const entity = await getCountryEntity(iso3);
    const officialIds = WD.currentEntityIds(entity, 'P37');
    const spokenIds = WD.currentEntityIds(entity, 'P2936');
    const timeZoneIds = WD.currentEntityIds(entity, 'P421');

    // Only fetch the spoken-language labels that mergeLanguages() could actually use: India's 300+
    // would be six wasted requests.
    const extraSpokenIds = spokenIds.filter((id) => !officialIds.includes(id));
    const spokenToFetch = officialIds.length === 0 ? spokenIds.slice(0, LANGUAGE_FALLBACK_CAP) : extraSpokenIds.length > 0 && extraSpokenIds.length <= LANGUAGE_TOP_UP_LIMIT ? extraSpokenIds : [];

    const labels = await api.getLabels(unique([...officialIds, ...spokenToFetch, ...timeZoneIds]));
    const named = (ids) => ids.map((id) => labels.get(id)).filter(Boolean);
    return {
      languages: mergeLanguages(named(officialIds), named(spokenToFetch)),
      timeZones: WD.sortTimeZones(unique(named(timeZoneIds))),
    };
  }

  // Page-only (the panel never shows it), so it is separate: a big federation's subdivision list
  // must not slow or fail the panel.
  async function statesTerritories(iso3) {
    const entity = await getCountryEntity(iso3);
    const ids = WD.currentEntityIds(entity, 'P150');
    const labels = ids.length > 0 ? await api.getLabels(ids.slice(0, MAX_STATE_LABELS)) : new Map();
    const list = unique([...labels.values()]).sort((a, b) => a.localeCompare(b));
    return { count: ids.length, list };
  }

  return { core, lists, statesTerritories };
}

const facts = createWikidataFacts(wikidataApi);
export const fetchWikidataCore = (iso3) => facts.core(iso3);
export const fetchWikidataLists = (iso3) => facts.lists(iso3);
export const fetchStatesTerritories = (iso3) => facts.statesTerritories(iso3);

// ---- Query Service: the optional extras on the full country page -------------------------------------
//
// Cities, attractions and religion are list-shaped and need joins the Action API cannot do. They are
// best-effort by design: each has a short timeout and a local-file / capital fallback, and none of
// them blocks or fails the country's main facts.

async function sparqlRows(query, { timeoutMs } = {}) {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/sparql-results+json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Wikidata query failed (${res.status})`);
    const body = await res.json();
    return body.results.bindings;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function str(binding, key) {
  return binding[key] ? binding[key].value : null;
}

function num(binding, key) {
  const v = str(binding, key);
  return v == null ? null : Number(v);
}

function coordOrNull(binding, latKey, lonKey) {
  const lat = num(binding, latKey);
  const lng = num(binding, lonKey);
  return lat != null && lng != null ? { lat, lng } : null;
}

const PLACE_QUERY_TIMEOUT_MS = 8000;

// A refused or failed query is NOT "there are none". The result is still empty (the caller falls back to the local
// file, then the capital) but marked, invisibly, so the data service knows not to remember it.
const failedQuery = (empty) => Object.defineProperty(empty, 'incompleteParts', { value: ['query service'], enumerable: false });

// Ranks by sitelink count (how many Wikipedia language editions cover a place) rather
// than population — cheap to sort by, and works as a reasonable "well-known" proxy.
function placesQuery(iso3, classQid, limit) {
  return `
SELECT ?place ?placeLabel ?lat ?lon (COUNT(DISTINCT ?sitelink) AS ?sitelinks) WHERE {
  ?country wdt:P298 "${iso3}" .
  ?place wdt:P31 wd:${classQid} .
  ?place wdt:P17 ?country .
  ?place rdfs:label ?placeLabel . FILTER(LANG(?placeLabel)="en")
  OPTIONAL {
    ?place p:P625 ?coordStmt . ?coordStmt psv:P625 ?coordNode .
    ?coordNode wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon .
  }
  ?sitelink schema:about ?place .
}
GROUP BY ?place ?placeLabel ?lat ?lon
ORDER BY DESC(?sitelinks)
LIMIT ${limit}`;
}

function parsePlaces(rows) {
  return rows
    .map((r) => ({ name: str(r, 'placeLabel'), coord: coordOrNull(r, 'lat', 'lon') }))
    .filter((p) => p.name && p.coord);
}

// Broad tourist-spot query: multi-class VALUES (tourist attraction, monument, archaeological site,
// castle, palace, museum, art museum) + requires P18 image so we get the Commons thumbnail without
// a second API round-trip.  Ordered by sitelink count so the most-documented places come first.
function touristSpotsQuery(iso3, limit) {
  return `
SELECT ?place ?placeLabel ?lat ?lon ?enwiki ?image (COUNT(DISTINCT ?sitelink) AS ?sitelinks) WHERE {
  VALUES ?type { wd:Q570116 wd:Q4989906 wd:Q839954 wd:Q23413 wd:Q16560 wd:Q44145 wd:Q33506 wd:Q207694 }
  ?country wdt:P298 "${iso3}" .
  ?place wdt:P31 ?type .
  ?place wdt:P17 ?country .
  ?place wdt:P18 ?image .
  ?place rdfs:label ?placeLabel . FILTER(LANG(?placeLabel)="en")
  OPTIONAL {
    ?place p:P625 ?coordStmt . ?coordStmt psv:P625 ?coordNode .
    ?coordNode wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon .
  }
  OPTIONAL {
    ?enwiki schema:about ?place ;
            schema:isPartOf <https://en.wikipedia.org/> .
  }
  ?sitelink schema:about ?place .
}
GROUP BY ?place ?placeLabel ?lat ?lon ?enwiki ?image
ORDER BY DESC(?sitelinks)
LIMIT ${limit}`;
}

function parseTouristSpots(rows) {
  return rows.map((r) => {
    const rawUrl = r.enwiki?.value ?? null;
    const wikiTitle = rawUrl ? decodeURIComponent(rawUrl.replace('https://en.wikipedia.org/wiki/', '')) : null;
    const rawImage = r.image?.value ?? null;
    // Commons FilePath URLs support ?width=N for thumbnails; force https
    const imageUrl = rawImage ? rawImage.replace(/^http:\/\//, 'https://') + '?width=400' : null;
    return { name: str(r, 'placeLabel'), coord: coordOrNull(r, 'lat', 'lon'), wikiUrl: rawUrl, wikiTitle, imageUrl };
  }).filter((p) => p.name);
}

// Large, heavily-documented countries (confirmed live: India, even with a LIMIT 8 and
// a non-transitive class filter) make a country-wide "every city" join expensive enough
// on the public Wikidata Query Service to time out. This degrades to an empty list
// rather than blocking the country page; dataService falls back to the local file's
// curated cities, then to the capital alone — the exact fallback chain the spec's own
// "capital plus the largest cities from Wikidata" wording anticipates.
export async function fetchMajorCitiesDynamic(iso3) {
  try {
    const rows = await sparqlRows(placesQuery(wikidataIso3(iso3), 'Q515', 8), { timeoutMs: PLACE_QUERY_TIMEOUT_MS });
    return parsePlaces(rows);
  } catch {
    return failedQuery([]);
  }
}

// Fetches tourist spots via Wikipedia's Category API (far more reliable than Wikidata SPARQL).
// Tries "Category:Tourist attractions in {name}" then the "in the {name}" variant that some
// countries use (United States, United Kingdom, etc.).
async function fetchTouristSpotsFromWikivoyage(name) {
  const wvApi = (params) =>
    fetch(`https://en.wikivoyage.org/w/api.php?${new URLSearchParams({ ...params, format: 'json', origin: '*' })}`, {
      signal: AbortSignal.timeout(8_000),
    });

  const findSeeSection = async (pageName) => {
    const res = await wvApi({ action: 'parse', page: pageName, prop: 'sections' });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.error) return null;
    return json.parse?.sections?.find((s) => s.line === 'See') ?? null;
  };

  const NON_ATTRACTION_WORDS = new Set([
    'Football', 'Soccer', 'Basketball', 'Tennis', 'Cricket', 'Rugby', 'Baseball', 'Hockey',
    'Golf', 'Volleyball', 'Cycling', 'Swimming', 'Athletics',
    'Also', 'Note', 'Warning', 'Tip', 'Budget', 'Money', 'Language', 'Weather', 'Climate',
    'Highlights', 'Activities', 'Overview', 'Introduction',
  ]);

  const extractAttractionNames = (wikitext) => {
    return [...wikitext.matchAll(/'{3}([^']+)'{3}/g)]
      .map((m) => m[1].replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1').replace(/^["']|["']$/g, '').trim())
      .filter((n) => n.length >= 4 && n.length <= 60 && /^[A-Z]/.test(n) && !NON_ATTRACTION_WORDS.has(n));
  };

  const lookupWikipediaImages = async (titles) => {
    if (!titles.length) return [];
    const params = new URLSearchParams({
      action: 'query',
      titles: titles.join('|'),
      prop: 'pageimages|info|pageviews',
      piprop: 'thumbnail',
      pithumbsize: '400',
      inprop: 'url',
      pvipdays: '30',
      format: 'json',
      origin: '*',
    });
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const json = await res.json();
    return Object.values(json.query?.pages ?? {})
      .filter((p) => p.title && !p.missing && p.thumbnail)
      .map((p) => ({
        _views: Object.values(p.pageviews ?? {}).reduce((s, v) => s + (v ?? 0), 0),
        name: p.title,
        coord: null,
        wikiUrl: p.fullurl ?? `https://en.wikipedia.org/wiki/${p.title.replace(/ /g, '_')}`,
        wikiTitle: p.title,
        imageUrl: p.thumbnail?.source ?? null,
      }));
  };

  try {
    const seeSec = await findSeeSection(name);
    if (!seeSec) return [];
    const res = await wvApi({ action: 'parse', page: name, section: seeSec.index, prop: 'wikitext' });
    if (!res.ok) return [];
    const json = await res.json();
    const wikitext = json.parse?.wikitext?.['*'] ?? '';
    const names = extractAttractionNames(wikitext);
    if (!names.length) return [];
    const pages = await lookupWikipediaImages(names.slice(0, 25));
    return pages.sort((a, b) => b._views - a._views).slice(0, 10);
  } catch {
    return [];
  }
}

async function fetchTouristSpotsFromWikipedia(name) {
  const fetchPages = async (category) => {
    const params = new URLSearchParams({
      action: 'query',
      generator: 'categorymembers',
      gcmtitle: category,
      gcmlimit: '50',
      gcmtype: 'page',
      prop: 'pageimages|info|pageviews',
      piprop: 'thumbnail',
      pithumbsize: '400',
      inprop: 'url',
      pvipdays: '30',
      format: 'json',
      origin: '*',
    });
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const json = await res.json();
    return Object.values(json.query?.pages ?? {})
      .filter((p) => p.title && !p.missing && p.thumbnail)
      .map((p) => ({
        _views: Object.values(p.pageviews ?? {}).reduce((s, v) => s + (v ?? 0), 0),
        name: p.title,
        coord: null,
        wikiUrl: p.fullurl ?? `https://en.wikipedia.org/wiki/${p.title.replace(/ /g, '_')}`,
        wikiTitle: p.title,
        imageUrl: p.thumbnail?.source ?? null,
      }));
  };
  try {
    let pages = await fetchPages(`Category:Tourist attractions in ${name}`);
    if (pages.length < 3) {
      const alt = await fetchPages(`Category:Tourist attractions in the ${name}`);
      if (alt.length > pages.length) pages = alt;
    }
    return pages.sort((a, b) => b._views - a._views).slice(0, 10);
  } catch {
    return [];
  }
}

// For targeted city/country name lookups from the country page (e.g. capital city supplementation).
// Tries Wikivoyage first (better curated for major cities), then Wikipedia category.
export async function fetchTouristSpotsByName(name) {
  if (!name) return [];
  const wvSpots = await fetchTouristSpotsFromWikivoyage(name);
  if (wvSpots.length >= 3) return wvSpots;
  return fetchTouristSpotsFromWikipedia(name);
}

// Wikivoyage "See" section is the primary source (human-curated, country-specific top spots).
// Wikipedia category is the secondary fallback (reliable images but category depth varies).
// Wikidata SPARQL is the last resort for countries with no Wikivoyage/Wikipedia coverage.
// countryName (e.g. "France") must be passed by the caller; without it only SPARQL is tried.
export async function fetchTouristAttractions(iso3, countryName) {
  if (countryName) {
    const wvSpots = await fetchTouristSpotsFromWikivoyage(countryName);
    if (wvSpots.length >= 3) return wvSpots;
    const wikiSpots = await fetchTouristSpotsFromWikipedia(countryName);
    if (wikiSpots.length > 0) return wikiSpots;
  }
  try {
    const rows = await sparqlRows(touristSpotsQuery(wikidataIso3(iso3), 10), { timeoutMs: 15_000 });
    return parseTouristSpots(rows);
  } catch {
    return failedQuery([]);
  }
}

// Batch-fetches Wikipedia page thumbnails for a list of article titles.
// Returns a Map of title → thumbnail URL; silently returns an empty Map on any failure.
export async function fetchWikipediaThumbnails(titles) {
  if (!titles || titles.length === 0) return new Map();
  const params = new URLSearchParams({
    action: 'query',
    titles: titles.join('|'),
    prop: 'pageimages',
    piprop: 'thumbnail',
    pithumbsize: '400',
    format: 'json',
    origin: '*',
  });
  try {
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return new Map();
    const json = await res.json();
    const map = new Map();
    for (const page of Object.values(json.query?.pages ?? {})) {
      if (page.thumbnail?.source && page.title) map.set(page.title, page.thumbnail.source);
    }
    return map;
  } catch {
    return new Map();
  }
}

function religionQuery(iso3) {
  return `
SELECT ?relLabel ?pct WHERE {
  ?item wdt:P298 "${iso3}" .
  ?item p:P140 ?stmt . ?stmt ps:P140 ?rel .
  OPTIONAL { ?stmt pq:P1107 ?pct . }
  ?rel rdfs:label ?relLabel . FILTER(LANG(?relLabel)="en")
}`;
}

// P140 (religion or worldview) with a P1107 (proportion) qualifier gives real
// percentages, but confirmed live to cover only ~30 of the 250+ ISO entries (India has
// it; the United States, France, Brazil, Nigeria, and Australia currently don't) — so
// this is a genuine bonus for the countries it covers, not a full replacement for the
// local file's religions field, which stays as the fallback.
export async function fetchReligions(iso3) {
  try {
    const rows = await sparqlRows(religionQuery(wikidataIso3(iso3)), { timeoutMs: 6000 });
    if (rows.length === 0) return null;
    return rows
      .map((r) => ({ religion: str(r, 'relLabel'), percent: num(r, 'pct') != null ? num(r, 'pct') * 100 : null }))
      .filter((r) => r.religion)
      .sort((a, b) => (b.percent || 0) - (a.percent || 0));
  } catch {
    return failedQuery([]); // empty like "none" for the caller, but a failure, not an answer
  }
}

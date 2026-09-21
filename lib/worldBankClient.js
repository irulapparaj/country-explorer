// Live World Bank Indicators API (v2) access — no key, CORS confirmed. Unlike Wikidata, the World Bank
// API accepts our canonical ISO alpha-3 codes directly, Kosovo (XKX) included, so there's no override
// map here.
//
// Two different kinds of "nothing" are kept apart here on purpose:
//   - the World Bank has NO DATA for this place (it answers 200 with a message body or an empty row:
//     Vatican City, Taiwan, small territories) -> the value is null and it is not a failure;
//   - the REQUEST FAILED (busy, offline, timed out — after retries) -> the value is null AND the
//     indicator is listed in `failedIndicators`, so the UI can offer a Retry instead of presenting a
//     transient hiccup as a fact about the country.
//
// Note: The multi-indicator sources/2 batch endpoint (v2/sources/2/country/.../series/.../data)
// does NOT include Access-Control-Allow-Origin headers and is therefore blocked by CORS when
// fetched from a web page. Only the per-indicator endpoint (v2/country/.../indicator/...) has
// CORS enabled — all batching must use that form.

import { fetchJson, createLimiter } from './http.js';

const BASE = 'https://api.worldbank.org/v2/country';
const TIMEOUT_MS = 12_000;

// A full country page asks for 43 indicators. Fired all at once they queue in the browser behind its
// per-host connection limit (~6 on HTTP/1.1) and, when the host is slow, retry together in a wave; a small
// cap keeps the load steady and each request's timeout counts only from when it is really sent.
const MAX_CONCURRENT_REQUESTS = 6;
const hostLimit = createLimiter(MAX_CONCURRENT_REQUESTS);

// What the API answers, with HTTP 200, for a country or indicator it does not know (checked live for a
// country it does not cover — Vatican City — and for a made-up one): {message: [{id: '120', key: 'Invalid value'}]}.
// Our indicator codes are fixed and valid, so for us it means "no data for this place".
const INVALID_VALUE_MESSAGE_ID = '120';

// mrnev=1 ("most recent non-empty value") skips years where this indicator wasn't
// reported, rather than returning a null for the latest calendar year. Confirmed live
// that different indicators resolve to different "latest" years for the same country
// (e.g. India: population=2025, density=2023) — every caller must keep the year
// alongside the value rather than assuming one shared "latest year" per country.
async function fetchIndicator(iso3, code, transport) {
  const body = await fetchJson(`${BASE}/${iso3}/indicator/${code}?format=json&per_page=1&mrnev=1`, { timeoutMs: TIMEOUT_MS, limit: hostLimit, ...transport });
  const messages = body?.[0]?.message;
  if (messages) {
    if (messages.some((message) => String(message?.id) === INVALID_VALUE_MESSAGE_ID)) return null; // no data for this place
    // Any other message is something we do not understand: report a failure rather than pass it off as
    // "no data" (and do not retry — it would only say the same again).
    throw new Error(`World Bank: ${messages[0]?.key ?? 'unexpected message'}`);
  }
  // What is left must be a page: [header, rows] — where rows is null or empty when there is nothing for this
  // place (Taiwan). Anything else is not a World Bank answer, and is a failure rather than "no data".
  if (!Array.isArray(body) || body.length < 2) throw new Error('World Bank: unexpected response');
  const row = body[1]?.[0];
  if (!row || row.value == null) return null;
  return { value: row.value, year: Number(row.date) };
}

// Attaches the names of the indicators whose request failed. Non-enumerable so it never shows up when
// the data is spread, iterated or checked for "has any value".
function withFailures(target, failed) {
  Object.defineProperty(target, 'failedIndicators', { value: failed, enumerable: false });
  return target;
}

const DEMOGRAPHIC_INDICATORS = {
  population: 'SP.POP.TOTL',
  density: 'EN.POP.DNST',
  birthRate: 'SP.DYN.CBRT.IN',
  deathRate: 'SP.DYN.CDRT.IN',
  growthRate: 'SP.POP.GROW',
  netMigration: 'SM.POP.NETM',
  lifeExpectancy: 'SP.DYN.LE00.IN',
  malePopulation: 'SP.POP.TOTL.MA.IN',
  femalePopulation: 'SP.POP.TOTL.FE.IN',
};

/**
 * @param {string} iso3
 * @param {{fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, limit?: ReturnType<typeof createLimiter>}} [transport] injected in tests
 * @returns {Promise<Record<string, {value: number, year: number} | null> & {failedIndicators: string[]}>}
 */
export async function fetchWorldBankDemographics(iso3, transport = {}) {
  const keys = Object.keys(DEMOGRAPHIC_INDICATORS);
  const results = await Promise.allSettled(keys.map((key) => fetchIndicator(iso3, DEMOGRAPHIC_INDICATORS[key], transport)));
  const values = Object.fromEntries(keys.map((key, i) => [key, results[i].status === 'fulfilled' ? results[i].value : null]));
  return withFailures(values, keys.filter((key, i) => results[i].status === 'rejected'));
}

// Five-year age bands as used by the World Bank's SP.POP.{band}.{MA|FE} indicator
// family; confirmed live for all of these plus the 80UP top band.
export const PYRAMID_BANDS = [
  '0004', '0509', '1014', '1519', '2024', '2529', '3034', '3539', '4044', '4549',
  '5054', '5559', '6064', '6569', '7074', '7579', '80UP',
];

/**
 * One row per age band with the male and female counts. Rows are all-null where the World Bank has
 * no age data for the place; `failedIndicators` names any indicator whose request failed.
 * @returns {Promise<Array<{band: string, male: object | null, female: object | null}> & {failedIndicators: string[]}>}
 */
export async function fetchWorldBankPyramid(iso3, transport = {}) {
  const codes = PYRAMID_BANDS.flatMap((band) => [`SP.POP.${band}.MA`, `SP.POP.${band}.FE`]);
  const results = await Promise.allSettled(codes.map((code) => fetchIndicator(iso3, code, transport)));
  const valueAt = (i) => (results[i].status === 'fulfilled' ? results[i].value : null);
  const rows = PYRAMID_BANDS.map((band, i) => ({ band, male: valueAt(i * 2), female: valueAt(i * 2 + 1) }));
  return withFailures(rows, codes.filter((code, i) => results[i].status === 'rejected'));
}

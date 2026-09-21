// Live Wikipedia access for narrative content the spec's local file was standing in
// for (culture, sports, geography/climate, government structure, history) — no key,
// CORS confirmed on both the search API and the REST summary API.
//
// Article titles for a country's sub-topic pages ("Culture of X", "Sport in X", ...)
// don't follow one uniform pattern (confirmed: "Sport in X" vs "Sports in X" both exist
// depending on the country), so titles are resolved through the search API rather than
// guessed and string-matched — one extra request, but it works for any country instead
// of a hardcoded naming convention.
//
// As everywhere in this app, "there is no such article" (null) and "the request failed" (a rejection)
// are kept apart: only the first is remembered, and the second is reported so the page can offer a retry.

import { fetchJson as defaultFetchJson, createLimiter, HttpError } from './http.js';
import { createMediaWikiGet } from './mediaWikiApi.js';

const SEARCH_API = 'https://en.wikipedia.org/w/api.php';
const SUMMARY_API = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const TIMEOUT_MS = 15000; // a hung request (no error, never resolving) blocks the whole page's loading state otherwise
const MAX_CONCURRENT_REQUESTS = 5;

const TOPIC_QUERIES = {
  culture: (name) => `Culture of ${name}`,
  sports: (name) => `Sport in ${name}`,
  geography: (name) => `Geography of ${name}`,
  government: (name) => `Politics of ${name}`,
  history: (name) => `History of ${name}`,
};

/**
 * @param {{fetchJson?: typeof defaultFetchJson, sleep?: (ms: number) => Promise<void>}} [deps] injected in tests
 */
export function createWikipediaClient({ fetchJson = defaultFetchJson, sleep } = {}) {
  const cache = new Map(); // query -> Promise<summary | null>
  const limit = createLimiter(MAX_CONCURRENT_REQUESTS);
  const get = (url) => fetchJson(url, { timeoutMs: TIMEOUT_MS, retries: 1, limit, sleep }); // the REST summary: plain HTTP statuses
  const searchGet = createMediaWikiGet({ fetchJson, sleep, limit }); // the Action API search: may answer 200 + {error}

  async function resolveTitle(query) {
    const body = await searchGet(`${SEARCH_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1&origin=*`, { timeoutMs: TIMEOUT_MS, retries: 1 });
    // An empty list is the genuine "no such article"; no list at all is a failure.
    if (!Array.isArray(body?.query?.search)) throw new Error('Wikipedia search returned no result list');
    return body.query.search[0]?.title || null;
  }

  async function fetchSummary(title) {
    let body;
    try {
      body = await get(`${SUMMARY_API}/${encodeURIComponent(title.replace(/ /g, '_'))}`);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null; // the page does not exist
      throw error;
    }
    if (body.type === 'disambiguation') return null;
    return {
      title: body.title,
      extract: body.extract || null,
      pageUrl: body.content_urls?.desktop?.page || null,
    };
  }

  /**
   * Resolves a topic article for a country (e.g. "Culture of Nigeria") via search, then
   * fetches its lead-section summary. Resolves to null when no matching article exists,
   * rather than guessing; REJECTS when the request itself failed (and does not remember that).
   * @param {string} query e.g. "Culture of Nigeria"
   */
  function fetchTopicSummary(query) {
    if (cache.has(query)) return cache.get(query);
    const promise = (async () => {
      const title = await resolveTitle(query);
      return title ? fetchSummary(title) : null;
    })();
    cache.set(query, promise);
    promise.catch(() => { if (cache.get(query) === promise) cache.delete(query); });
    return promise;
  }

  /**
   * Fetches all five country sub-topic summaries in parallel for the given common name
   * (e.g. "Nigeria", not the ISO code — article titles use the country's plain name).
   * The topics whose request FAILED are listed in a non-enumerable `incompleteParts`, so they stay out of
   * the data but the data service can tell "no article" from "could not be loaded".
   * @param {string} countryName
   */
  async function fetchCountryTopicSummaries(countryName) {
    const keys = Object.keys(TOPIC_QUERIES);
    const results = await Promise.allSettled(keys.map((key) => fetchTopicSummary(TOPIC_QUERIES[key](countryName))));
    const topics = Object.fromEntries(keys.map((key, i) => [key, results[i].status === 'fulfilled' ? results[i].value : null]));
    return Object.defineProperty(topics, 'incompleteParts', { value: keys.filter((key, i) => results[i].status === 'rejected'), enumerable: false });
  }

  return { fetchTopicSummary, fetchCountryTopicSummaries };
}

const defaultClient = createWikipediaClient();
export const fetchTopicSummary = defaultClient.fetchTopicSummary;
export const fetchCountryTopicSummaries = defaultClient.fetchCountryTopicSummaries;

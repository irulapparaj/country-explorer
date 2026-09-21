// MediaWiki's Action API — what Wikidata, Wikimedia Commons and Wikipedia all speak — reports being busy, and
// some other failures, as HTTP 200 with an {error: {code, info}} body. A caller that reads only the body it
// expects takes that for "nothing there", and once remembered it stays "nothing there" for the whole visit:
// exactly the failure-mistaken-for-missing-data this app is built to avoid. Every Action API request goes
// through here, so no caller can forget the check.

import { fetchJson as defaultFetchJson, retrying, isRetryable } from './http.js';

export class MediaWikiApiError extends Error {
  constructor(code, info) {
    super(`MediaWiki API error ${code}: ${info}`);
    this.name = 'MediaWikiApiError';
    this.code = code;
  }
}

// The codes worth another attempt; anything else (a bad request, a missing entity) will not improve on retry.
const isTransientApiCode = (code) => /^(maxlag|ratelimited|readonly)|^internal_api_error/.test(code ?? '');

/**
 * A GET against a MediaWiki Action API endpoint that retries what is worth retrying — network failures, 429/5xx
 * (see http.js) and the transient error codes above — and throws what is not. It knows nothing about the shape of
 * a good answer: callers check that themselves (an answer with no query result is also a failure).
 * @param {{fetchJson?: typeof defaultFetchJson, sleep?: (ms: number) => Promise<void>, limit?: Function}} [deps]
 * @returns {(url: string, options?: {timeoutMs?: number, retries?: number}) => Promise<any>}
 */
export function createMediaWikiGet({ fetchJson = defaultFetchJson, sleep, limit } = {}) {
  return function get(url, { timeoutMs, retries } = {}) {
    return retrying(
      async () => {
        const body = await fetchJson(url, { timeoutMs, retries: 0, sleep, limit }); // one attempt: retrying() wraps both kinds of failure
        if (body?.error) throw new MediaWikiApiError(body.error.code, body.error.info);
        return body;
      },
      { retries, sleep, isRetryable: (error) => (error instanceof MediaWikiApiError ? isTransientApiCode(error.code) : isRetryable(error)) }
    );
  };
}

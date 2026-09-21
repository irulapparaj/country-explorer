// Fetching with retry and backoff. The live APIs this app depends on (Wikidata, the World Bank) are
// shared public services that answer 429/5xx — or simply hang — when busy. A single attempt made
// every one of those hiccups permanent for the visit ("Not available" on Brazil and Russia), so
// transient failures are retried a couple of times before a request is allowed to fail.

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 400;
const MAX_RETRY_AFTER_MS = 5_000; // never let a server's "come back later" hang the page for minutes
const BACKOFF_JITTER = 0.25; // ±25%: dozens of parallel retries must not all come back in the same instant

export class HttpError extends Error {
  constructor(status, url, retryAfterMs = null) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** True for failures worth another attempt: busy/failing servers, dropped connections, timeouts. */
export function isRetryable(error) {
  if (error instanceof HttpError) return RETRYABLE_STATUSES.has(error.status);
  // fetch() rejects with a TypeError for network-level failures — including a 429 whose response
  // carries no CORS headers, which the browser hides behind exactly that error.
  if (error instanceof TypeError) return true;
  return error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// exponential backoff, spread by ±BACKOFF_JITTER around the nominal delay
const backoffDelay = (baseDelayMs, attempt, random) => baseDelayMs * 2 ** attempt * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * random());

/**
 * Runs `operation`, retrying it (jittered exponential backoff) when it throws something `isRetryable`
 * accepts. A server that says "retry after" longer than a page can wait for is taken at its word: the
 * error is thrown at once rather than retried into a server that has just said it is still throttling us.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {{retries?: number, baseDelayMs?: number, sleep?: (ms: number) => Promise<void>, random?: () => number, isRetryable?: (e: unknown) => boolean}} [options]
 * @returns {Promise<T>}
 */
export async function retrying(operation, { retries = DEFAULT_RETRIES, baseDelayMs = DEFAULT_BASE_DELAY_MS, sleep = defaultSleep, random = Math.random, isRetryable: shouldRetry = isRetryable } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error)) throw error;
      const serverAskedFor = error?.retryAfterMs;
      if (serverAskedFor != null && serverAskedFor > MAX_RETRY_AFTER_MS) throw error;
      await sleep(serverAskedFor ?? backoffDelay(baseDelayMs, attempt, random));
    }
  }
}

/**
 * Caps how many tasks run at once (e.g. requests to one host). Extra tasks wait their turn, in order.
 * @param {number} maxConcurrent
 * @returns {<T>(task: () => Promise<T> | T) => Promise<T>}
 */
export function createLimiter(maxConcurrent) {
  let active = 0;
  const waiting = [];
  // A finished task hands its slot straight to the next in line, so `active` never dips below the real
  // number of running tasks and a newcomer arriving at that moment cannot slip past the queue.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return async (task) => {
    if (active >= maxConcurrent) await new Promise((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function retryAfterMs(response) {
  const raw = response.headers?.get?.('retry-after');
  if (raw == null || raw === '') return null; // Number(null) is 0: a MISSING header must not read as "retry at once"
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/**
 * GET a URL and parse it as JSON, with a per-attempt timeout and retry on transient failures.
 * With a `limit` (see createLimiter) each ATTEMPT takes a slot: the timeout clock starts when the request
 * is actually sent rather than while it queues, and a request sleeping through its backoff holds no slot.
 * @param {string} url
 * @param {{timeoutMs?: number, retries?: number, baseDelayMs?: number,
 *   fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, random?: () => number,
 *   limit?: ReturnType<typeof createLimiter>}} [options]
 */
export function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, retries, baseDelayMs, fetchImpl = globalThis.fetch, sleep, random, limit } = {}) {
  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) throw new HttpError(response.status, url, retryAfterMs(response));
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  };
  return retrying(() => (limit ? limit(attempt) : attempt()), { retries, baseDelayMs, sleep, random });
}

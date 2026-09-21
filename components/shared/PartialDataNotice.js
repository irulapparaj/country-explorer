import { createEl } from '../../lib/domUtils.js';

const SOURCE_NAMES = { wikidata: 'Wikidata', worldbank: 'the World Bank', wikipedia: 'Wikipedia' };

/** "Wikidata", "Wikidata and the World Bank" — the sources that failed, in words. */
export function describeFailedSources(failedSources) {
  const names = [...new Set(failedSources)].map((source) => SOURCE_NAMES[source] ?? source);
  return names.length <= 1 ? (names[0] ?? 'a data source') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * What to tell a screen-reader user once a country has loaded. The notice on the page is a status node
 * inserted together with its text, which is not reliably announced — so the outcome, including a failure and
 * whether a Try again helped, is said through the shared live region as well.
 * @param {string} name the country's name
 * @param {string[] | undefined} failedSources
 * @param {{retried?: boolean, lead?: string}} [options] `lead` completes "Brazil …" when all went well
 */
export function describeLoadOutcome(name, failedSources, { retried = false, lead = 'selected' } = {}) {
  if (!failedSources?.length) return retried ? `${name}: all details loaded.` : `${name} ${lead}`;
  const from = describeFailedSources(failedSources);
  return retried
    ? `${name}: some details still could not be loaded from ${from}.`
    : `${name} ${lead}. Some details could not be loaded from ${from}. Use the Try again button to fetch them.`;
}

/**
 * The line shown when some of a country's data could not be loaded — a REQUEST FAILURE, which is
 * different from "no such fact exists". Without it, a busy service looked exactly like a country
 * with no capital, area or time zones ("Not available").
 * @param {string[]} failedSources e.g. ['wikidata', 'worldbank']
 * @param {() => void} onRetry
 */
export function createPartialDataNotice(failedSources, onRetry) {
  const notice = createEl('div', { className: 'partial-notice', attrs: { role: 'status' } });
  const message = createEl('span', {
    className: 'partial-notice-text',
    text: `Some details could not be loaded from ${describeFailedSources(failedSources)} just now.`,
  });
  const retry = createEl('button', { className: 'partial-notice-btn', attrs: { type: 'button' }, text: 'Try again' });
  retry.addEventListener('click', onRetry);
  notice.append(message, retry);
  return notice;
}

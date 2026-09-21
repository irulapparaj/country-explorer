import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWikipediaClient } from '../../lib/wikipediaClient.js';
import { HttpError } from '../../lib/http.js';

// A fake fetchJson answering the two Wikipedia endpoints. `articles` maps a search text to a page title;
// `pages` maps a title to its summary body; `failing` makes matching URLs throw.
function fakeWikipedia({ articles = {}, pages = {}, failing = () => null } = {}) {
  const requests = [];
  const fetchJson = async (url) => {
    requests.push(url);
    const failure = failing(url);
    if (failure) throw failure;
    if (url.includes('list=search')) {
      const query = decodeURIComponent(/srsearch=([^&]+)/.exec(url)[1]);
      return { query: { search: articles[query] ? [{ title: articles[query] }] : [] } };
    }
    const title = decodeURIComponent(url.split('/page/summary/')[1]).replace(/_/g, ' ');
    if (!pages[title]) throw new HttpError(404, url);
    return pages[title];
  };
  fetchJson.requests = requests;
  return fetchJson;
}

const culture = { title: 'Culture of Brazil', extract: 'Brazilian culture …', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Culture_of_Brazil' } } };
const busy = new HttpError(503, 'https://en.wikipedia.org/x');

test('a topic is found by search, then summarised', async () => {
  const client = createWikipediaClient({ fetchJson: fakeWikipedia({ articles: { 'Culture of Brazil': 'Culture of Brazil' }, pages: { 'Culture of Brazil': culture } }) });
  assert.deepEqual(await client.fetchTopicSummary('Culture of Brazil'), { title: 'Culture of Brazil', extract: 'Brazilian culture …', pageUrl: 'https://en.wikipedia.org/wiki/Culture_of_Brazil' });
});

test('"no such article" is an answer (null) and is remembered: the same question is not asked twice', async () => {
  const fetchJson = fakeWikipedia({ articles: {} });
  const client = createWikipediaClient({ fetchJson });
  assert.equal(await client.fetchTopicSummary('Sport in Nowhere'), null);
  assert.equal(await client.fetchTopicSummary('Sport in Nowhere'), null);
  assert.equal(fetchJson.requests.length, 1);
});

test('a missing page (404) and a disambiguation page both mean "no article", not a failure', async () => {
  const client = createWikipediaClient({ fetchJson: fakeWikipedia({ articles: { A: 'Gone', B: 'Mercury' }, pages: { Mercury: { type: 'disambiguation', title: 'Mercury' } } }) });
  assert.equal(await client.fetchTopicSummary('A'), null);
  assert.equal(await client.fetchTopicSummary('B'), null);
});

// Found by review: a failed lookup was cached as null for the rest of the visit and never reported, so
// Try again could not bring the narrative sections back.
test('a lookup that FAILS rejects, and is not remembered: asking again works once the service recovers', async () => {
  let down = true;
  const fetchJson = fakeWikipedia({ articles: { 'Culture of Brazil': 'Culture of Brazil' }, pages: { 'Culture of Brazil': culture }, failing: () => (down ? busy : null) });
  const client = createWikipediaClient({ fetchJson });
  await assert.rejects(client.fetchTopicSummary('Culture of Brazil'), (error) => error === busy);
  down = false;
  assert.equal((await client.fetchTopicSummary('Culture of Brazil')).title, 'Culture of Brazil');
});

test('all five topics come back keyed by name; a topic with no article is null and is not a failure', async () => {
  const client = createWikipediaClient({ fetchJson: fakeWikipedia({ articles: { 'Culture of Brazil': 'Culture of Brazil' }, pages: { 'Culture of Brazil': culture } }) });
  const topics = await client.fetchCountryTopicSummaries('Brazil');
  assert.deepEqual(Object.keys(topics), ['culture', 'sports', 'geography', 'government', 'history']);
  assert.equal(topics.culture.title, 'Culture of Brazil');
  assert.equal(topics.sports, null);
  assert.deepEqual(topics.incompleteParts, []);
});

test('topics that FAILED are named (invisibly, like the World Bank\'s failed indicators); the others still arrive', async () => {
  const fetchJson = fakeWikipedia({
    articles: { 'Culture of Brazil': 'Culture of Brazil', 'History of Brazil': 'History of Brazil' },
    pages: { 'Culture of Brazil': culture, 'History of Brazil': { title: 'History of Brazil', extract: 'x' } },
    failing: (url) => (url.includes('srsearch=Sport') ? busy : null),
  });
  const topics = await createWikipediaClient({ fetchJson }).fetchCountryTopicSummaries('Brazil');
  assert.equal(topics.culture.title, 'Culture of Brazil');
  assert.equal(topics.history.title, 'History of Brazil');
  assert.equal(topics.sports, null);
  assert.deepEqual(topics.incompleteParts, ['sports']);
  assert.equal(Object.keys(topics).includes('incompleteParts'), false);
});

// The same hole as at Commons: the search endpoint answers {error: ...} with HTTP 200, and that was read as
// "no article" — for all five topics, remembered for the visit, never reported. Found by review.
test('a busy-error from the search endpoint (HTTP 200) is retried once, then read normally', async () => {
  let attempts = 0;
  const inner = fakeWikipedia({ articles: { 'Culture of Brazil': 'Culture of Brazil' }, pages: { 'Culture of Brazil': culture } });
  const fetchJson = async (url, options) => (url.includes('list=search') && ++attempts < 2 ? { error: { code: 'internal_api_error_DBQueryError', info: 'busy' } } : inner(url, options));
  const client = createWikipediaClient({ fetchJson, sleep: async () => {} });
  assert.equal((await client.fetchTopicSummary('Culture of Brazil')).title, 'Culture of Brazil');
  assert.equal(attempts, 2);
});

test('an error the server will not clear FAILS the topic (not "no article"), is named, and is not remembered', async () => {
  let broken = true;
  const inner = fakeWikipedia({ articles: { 'Culture of Brazil': 'Culture of Brazil' }, pages: { 'Culture of Brazil': culture } });
  const fetchJson = async (url, options) => (broken && url.includes('list=search') ? { error: { code: 'maxlag', info: 'busy' } } : inner(url, options));
  const client = createWikipediaClient({ fetchJson, sleep: async () => {} });

  const topics = await client.fetchCountryTopicSummaries('Brazil');
  assert.deepEqual(topics.incompleteParts, ['culture', 'sports', 'geography', 'government', 'history']);
  assert.equal(topics.culture, null);

  broken = false; // the service recovers: nothing was remembered, so the very next read finds the article
  assert.equal((await client.fetchTopicSummary('Culture of Brazil')).title, 'Culture of Brazil');
});

test('a search answer with no result list at all is a failure too', async () => {
  for (const body of [{}, { query: {} }, { query: { search: null } }]) {
    const client = createWikipediaClient({ fetchJson: async () => body, sleep: async () => {} });
    await assert.rejects(client.fetchTopicSummary('Culture of Brazil'), /no result list/i, JSON.stringify(body));
  }
  // …while an empty list is the genuine "no such article"
  assert.equal(await createWikipediaClient({ fetchJson: async () => ({ query: { search: [] } }) }).fetchTopicSummary('Culture of Nowhere'), null);
});

// Mutation testing by review: reading ANY summary failure as "no article" left every test green, because the
// tests only ever broke the search request.
test('a summary request that fails (after a good search) is a failure, not "no article"', async () => {
  const inner = fakeWikipedia({ articles: { 'Culture of Brazil': 'Culture of Brazil' }, pages: { 'Culture of Brazil': culture } });
  const fetchJson = async (url, options) => { if (url.includes('/page/summary/')) throw busy; return inner(url, options); };
  await assert.rejects(createWikipediaClient({ fetchJson }).fetchTopicSummary('Culture of Brazil'), (error) => error === busy);
});

// Mutation testing by review: the cap could be 1 or 50 and the old test could not tell, because one country only
// ever has five topics in flight. Two countries at once ask for ten.
test('requests to Wikipedia are capped at five in flight, even with two countries loading at once', async () => {
  let running = 0;
  let peak = 0;
  const fetchJson = async (url, { limit }) => limit(async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 4));
    running--;
    return url.includes('list=search') ? { query: { search: [] } } : {};
  });
  const client = createWikipediaClient({ fetchJson });
  await Promise.all([client.fetchCountryTopicSummaries('Brazil'), client.fetchCountryTopicSummaries('France')]);
  assert.equal(peak, 5);
});

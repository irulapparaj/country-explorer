// Dev-time script (not part of the running app): rebuilds data/wikidata-ids.json, the map from each
// search-index ISO alpha-3 code to the Wikidata item (QID) of that country. Run with:
//   node scripts/build-wikidata-ids.mjs
//
// Why it exists: the app reads a country's facts straight off its Wikidata item through the Action
// API, which needs the QID. Looking it up per visit would add a request and a failure point; QIDs
// never change, so they are resolved once here (same approach as data/search-index.json and
// data/continents.json). The runtime falls back to the same search for any code missing from the file.
//
// How: search for items carrying the statement P298 (ISO 3166-1 alpha-3) = <code> (an exact statement
// match, not free text). A single hit is taken as is. Where several items carry the same code
// (Denmark / Kingdom of Denmark, Netherlands / Kingdom of the Netherlands, ...) each candidate is
// VERIFIED by reading its P298 statement directly, and the search's top hit — the country itself —
// wins among those that check out.
//
// It is deliberately slow (about one request per second): Wikimedia answers a burst of anonymous
// requests with 429, and a build script must not be the reason the live app gets throttled.

import fs from 'node:fs';

const API = 'https://www.wikidata.org/w/api.php';
const UA = 'CountryExplorer/0.1 (build-wikidata-ids script)';
// Our canonical code vs the one Wikidata's best-rank P298 statement carries (see wikidataClient.js).
const WIKIDATA_ISO3_OVERRIDES = { XKX: 'XKS' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SPACING_MS = 1000;

// Chosen by hand where the automatic pick would be wrong. NLD: the ISO code is carried (as a normal
// statement) only by the Kingdom of the Netherlands (Q29999), and DEPRECATED on Q55, the country of the
// Netherlands — but Q55 is the item the map's "Netherlands" corresponds to, and has the better facts:
// current population, UTC-offset time zones, the right continent and currencies (the Kingdom's item
// mixes in Aruba, Curaçao and Sint Maarten, which have their own entries here).
const PREFERRED_ITEMS = { NLD: 'Q55' };

async function getJson(url, attempts = 8) {
  let lastProblem = 'no attempt made';
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 429 || res.status >= 500) {
        lastProblem = `HTTP ${res.status}`;
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      lastProblem = error.message;
      await sleep(2000 * (i + 1));
    }
  }
  throw new Error(`Request kept failing (${lastProblem}): ${url}`);
}

async function hasIsoStatement(qid, code) {
  const body = await getJson(`${API}?action=wbgetclaims&entity=${qid}&property=P298&format=json`);
  return (body.claims?.P298 ?? []).some((c) => c.rank !== 'deprecated' && c.mainsnak?.datavalue?.value === code);
}

const index = JSON.parse(fs.readFileSync(new URL('../data/search-index.json', import.meta.url), 'utf8'));
const ids = {};
const problems = [];
for (const { iso3 } of [...index].sort((a, b) => a.iso3.localeCompare(b.iso3))) {
  const code = WIKIDATA_ISO3_OVERRIDES[iso3] || iso3;
  let candidates = [];
  try {
    const search = await getJson(`${API}?action=query&list=search&srsearch=${encodeURIComponent(`haswbstatement:P298=${code}`)}&srlimit=5&format=json`);
    candidates = (search.query?.search ?? []).map((hit) => hit.title);
  } catch (error) {
    problems.push(`${iso3} (${error.message})`); // keep going: one bad code must not discard the other 250
    continue;
  }
  let chosen = null;
  if (PREFERRED_ITEMS[iso3]) {
    chosen = PREFERRED_ITEMS[iso3];
  } else if (candidates.length === 1) {
    chosen = candidates[0];
  } else {
    for (const qid of candidates) {
      if (await hasIsoStatement(qid, code)) {
        chosen = qid;
        break;
      }
      await sleep(SPACING_MS);
    }
  }
  if (chosen) ids[iso3] = chosen;
  else problems.push(`${iso3} (candidates: ${candidates.join(', ') || 'none'})`);
  if (candidates.length > 1) console.log(`${iso3}: ${candidates.join(' vs ')} -> ${chosen}`);
  await sleep(SPACING_MS);
}

fs.writeFileSync(new URL('../data/wikidata-ids.json', import.meta.url), `${JSON.stringify(ids, null, 2)}\n`);
console.log(`Wrote ${Object.keys(ids).length} of ${index.length} countries.`);
if (problems.length) console.warn(`Unresolved: ${problems.join('; ')}`);

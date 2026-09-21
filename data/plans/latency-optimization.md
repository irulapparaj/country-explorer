Plan: four phases, cheapest and safest first
Phase 0 — Measure before changing anything (about half a day)
Add performance.mark/measure for each source in createDataService: queue time, first byte, and settle time. Print a one-line table when the URL has ?perf.
Add a Playwright perf spec that records four timings:
panel: first fact shown
panel: complete
page: first section shown
page: complete
Record p50/p95 for a fixed set of countries, including Brazil, Russia, India and Vatican City.
Targets: panel first facts < 1.5 s at p50; page first section < 1 s when the summary is already cached; page complete < 4 s.
I haven't measured anything yet. Every later phase should be judged against these numbers.

Phase 1 — Show data as it arrives (largest perceived win, no policy change)
Show each section as soon as its own data arrives, instead of waiting for everything.

Change the data service to return promises per section instead of one merged promise:

getCountryFullDetails(code) → {
  summary: Promise<Summary>,
  sections: { pyramid, religions, cities, attractions, topics, states }  // each a Promise
}
normalizeSummary and mergeFullDetails become one small pure merge per section, each unit-tested with fake settled results.
This also removes the positional-destructure hazard noted in ARCHITECTURE §5.
CountryPage draws the header and navigation from the summary, puts a skeleton in each section, and fills each section when its promise settles.
Each section keeps its own failed / not available / best-effort fallback state, so the §6 reliability rules hold per section.
PartialDataNotice combines the failures as sections settle.
The side panel does the same in two tiers:
Wikidata facts first.
World Bank demographics and the anthem fill in later.
failedSources and the rule that partial results are never cached stay exactly as they are.
Effect: the page's first paint depends on the summary instead of the slowest extra (SPARQL, the pyramid). For "More details" from an open panel, the summary is already cached, so first paint is effectively instant.

Phase 2 — Fewer round trips and fewer requests (makes the real data arrive sooner)
Change	Where	Requests before → after	Round trips on the critical path
Load wikidata-ids.json at boot, next to the search index	wikidataClient.js, main.js	same count	−1 on the first click
Take the anthem off the panel's critical path: resolve the recording separately and fill the player when it arrives	wikidataClient.core → split out anthem as its own memo source	same count	−2
Fetch the anthem item's P51 in the same wbgetentities batch as the labels (props=labels|claims for that one ID)	getLabels/core	−1	−1
Batch the World Bank indicators: indicator/A;B;C?source=2&date=<range>&per_page=…, then choose the latest non-empty year per indicator in a pure function	worldBankClient.js	43 → ~2–3	pyramid: ~6 waves → 1
Wikipedia: one action=query&titles=Culture of X|Sport in X|Sports in X|…&redirects&prop=extracts&exintro&explaintext, and use search only for topics that don't resolve	wikipediaClient.js	10 → 1 (+ fallbacks)	2 → 1
Send SPARQL through http.js with its own host limiter	wikidataClient.sparqlRows	—	fixes rule #4
Add <link rel="preconnect"> for www.wikidata.org, api.worldbank.org, en.wikipedia.org, commons and query.wikidata.org	index.html	—	saves one TLS handshake per host
Start loading Leaflet and Chart.js when the page render begins, not after the data	CountryPage.render	—	the library download overlaps the data wait
Check live before relying on these:

whether the multi-indicator World Bank call respects mrnev (if it doesn't, use a date range and pick the latest non-empty value on the client);
how many titles exintro accepts in one call;
whether many small wbgetclaims calls beat the single ~1 MB entity. Test that one with Phase 0 numbers only; it's a real trade-off.
Once Phase 2 is done, the country page drops from about 60 requests to about 15.

Phase 3 — Fetch before the user asks
This only makes sense after Phase 2, when a country costs a handful of requests instead of 60.

When a panel opens: once the summary has loaded, prefetch the full-page extras in idle time (requestIdleCallback), and also when the pointer hovers or focus lands on "More details". Also warm Leaflet and Chart.js.
On map hover: after about 300 ms on the same country (hoverTracker already knows which one), prefetch that country's summary. Search results get the same on highlight.
Safeguards:
one prefetch at a time;
prefetches go to the back of each host limiter's queue;
no retries for prefetches.
The memo already shares in-flight requests, so a prefetch that is still running is simply reused when the real request comes. Nothing new is needed to handle that.
Phase 4 — Remember data across visits (your call: this changes the project's premise)
ARCHITECTURE §2 says "anything a visitor reads… came off the wire in that session." These options go past that line, so each needs an explicit decision recorded in §7:

A. Stale-while-revalidate in IndexedDB, managed by the data service.
Store only complete results; the service already knows which ones those are.
Keep them for 24 h for Wikidata and 7 days for World Bank (the World Bank data is annual).
Show the cached copy immediately, refresh it live, and update the page if anything changed.
Do not do this with a Service Worker. It only sees HTTP, so it would cache MediaWiki's 200 + {error} responses and the World Bank's message bodies. That is exactly the "failure shown as missing data" bug §6 exists to prevent.
B. A build-time snapshot. A scripts/build-summaries.mjs job, refreshed by a nightly scheduled job, would write summary-only JSON (like continents.json). The panel would show it immediately and then refresh it live. This is the fastest option, but it is close to "hardcoded facts" and needs a visible "as of" date.
C. An edge proxy that combines and caches the API calls (e.g. a Cloudflare Worker). It is the best option for first-time visitors, but it breaks "no server". I'd rule it out unless that constraint changes.
My recommendation: do Phases 0–3 now. Together they should remove most of the perceived delay without touching any constraint. Take Option A only if Phase 0 shows repeat visits matter. B and C would change what the project is.

Risks and guardrails
Rate limiting: batching (Phase 2) lowers the 429 risk; prefetching (Phase 3) raises it. Phase 2 has to ship first.
Stale renders: progressive filling adds more places where a result can arrive after the user has moved on. Every section fill must check the isCurrent() token.
Tests: in mergeFullDetails, the six-argument call and every test that uses it become per-section merges. New pure logic (World Bank latest-value picking, Wikipedia title resolution) gets unit tests. Progressive filling and the §6 states per section get E2E specs.
Docs, updated in the same changes:
ARCHITECTURE §3.3 (country page flow), §5 (the data service's return shape), §6 (prefetch and deadline notes) and §7 (if Phase 4 goes ahead);
the data-source table in README.
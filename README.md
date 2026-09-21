# Country Explorer

An interactive world map and country almanac. Every fact on screen — population, capital,
government, culture, geography — is fetched live from free, open, no-key-required APIs at
the moment you select a country. Nothing about a country's real-world data is hardcoded.

## What's on the map

- **Three map styles** — *Political* (the original pastel country map), *Geographic* (every
  country takes its continent's color; borders inside a continent fade so each continent reads
  as one block) and *Elevation* (real terrain and ocean depth, with a key). A compact
  **Map options** card, top-left, switches between them.
- **Names** — *Major countries* (the biggest are named from the world view and more appear as
  you zoom), *All countries* (every country is a candidate at every zoom; a name may spill past
  a small country's outline but never overlaps another name), or *Continents only*.
- **Reference overlays** (on by default, each can be switched off) — a latitude/longitude grid
  that gets finer as you zoom, with degrees labeled along the map's left and bottom edges; the
  **Equator, Tropics of Cancer and Capricorn, and Arctic and Antarctic Circles**, drawn dashed
  and named; ocean and sea names; a **compass**; and both **polar regions** (Antarctica is drawn
  and selectable, and each polar cap is tinted).
- Selecting a country zooms to **all** of it — French Guiana, Alaska and Hawaii included — and
  centers it in the part of the map the (now compact) side panel does not cover.

## Running it

```sh
python3 -m http.server 8420
# then open http://localhost:8420/
```

If the page is not loading — or is showing *another project*, because several projects share port 8420 —
run `npm run restart-server` (or `sh scripts/restart-server.sh`). It stops whatever `python3 -m http.server`
holds the port (saying which folder it was serving; anything that is not an http.server is left alone),
starts a fresh one from this folder, and waits until it answers with this project's page.
`PORT=8500 npm run restart-server` uses another port and leaves 8420 alone. (`npm run test:e2e` reuses whatever
is already on 8420, so run this first if another project's server may be there.)

Any static file server works (`npx serve`, PHP's built-in server, etc.) — the one
requirement is that it's served over `http://`/`https://`, not opened as a `file://` URL.
The app is built as native ES modules (`<script type="module">`), and browsers refuse to
run `import`/`fetch` from a plain opened file for security reasons.

This is a genuinely zero-build project: `index.html` loads plain `.js` files directly, with
D3, Leaflet, Chart.js, and Fuse.js pulled from a CDN as classic `<script>` tags. There is
no bundler, no transpilation step, and nothing to `npm install` to run the site itself.

### Running the test suite (optional, dev-only)

`package.json`/`node_modules` exist **only** for the test suite below — the app itself
needs none of it.

```sh
npm install
npm run test:unit   # 382 tests, Node's built-in test runner, no network calls (under a second)
npm run test:e2e    # 156 tests x 3 browsers, Playwright, against a live local server + the real APIs
```

The E2E suite hits real Wikidata/World Bank/Wikipedia/OpenStreetMap endpoints by design —
that's the thing being tested. Expect occasional retries (`playwright.config.js` sets
`retries: 1`) from transient live-API latency or rate limiting; a test that fails on every
retry is a real bug, one that passes on retry is the live web being the live web. Wikidata and
Wikipedia answer `HTTP 429` (for a few minutes) when several workers hit them at once — as they did during
this project's own test runs. The app treats that as the *failure* it is (the panel says some details could
not be loaded), so tests waiting for real data then time out. Run with `--workers=2`, and re-run just the
ones that failed serially (`npx playwright test --workers=1 -g "<title>"`) once the API answers again
(`curl -s "https://www.wikidata.org/w/api.php?action=query&meta=siteinfo&format=json"` is a quick check).

## Data sources

| Field(s) | Source | Notes |
|---|---|---|
| Official name, capital (+coords), country center coords, area, currencies, continents, flag, formation date, government form, head of state/government, anthem title + audio, and population where the World Bank has none | **Wikidata**, read straight off the country's item through the **Action API** (`www.wikidata.org/w/api.php`: `wbgetentities`, `wbgetclaims`) | The item is found through `data/wikidata-ids.json` (ISO alpha-3 → item, built by `scripts/build-wikidata-ids.mjs`; a search on P298 is the fallback). About 4–5 fast requests per country. The anthem recording's file details come from the Commons API |
| Languages, time zones, states/territories | **Wikidata** (same item) | P37∪P2936 for languages (see Limitations); time zones shown as UTC offsets; the raw Wikidata subdivision list, not corrected against textbook counts (country page only) |
| Religions (with %) | **Wikidata** Query Service (SPARQL: P140 + P1107) | Sparse — confirmed on only ~30 of 250+ countries; everything else shows "Not available" |
| Major cities, tourist attractions (name + coordinates) | **Wikidata** Query Service (SPARQL) | Ranked by Wikipedia sitelink count; cities fall back to just the capital, attractions to nothing |
| Population, density, birth/death/growth rate, net migration, life expectancy, male/female population, 17-band population pyramid | **World Bank Indicators API v2** (`api.worldbank.org`) | Latest available year per indicator — different indicators can report different "latest" years for the same country, so every stat shows its own year |
| Culture, sports, geography/climate, government structure, history/colonization narrative | **Wikipedia** REST summary API, with the MediaWiki search API used to resolve each country's actual article title (e.g. "Sport in Nigeria" vs "Sports in Nigeria") | "Not available" when there is no article |
| Country page map tiles | **OpenStreetMap** via Leaflet | Standard OSM tile server, attribution shown per their terms |
| Search index (every ISO 3166-1 entry + Kosovo: names/aliases/codes/coordinates) | Bundled `data/search-index.json`, itself built from a live Wikidata query (see the authoring note in that decision below) | Not hand-typed — pulled from Wikidata once, curated only for a small number of documented overrides (see below) |
| World map boundaries | `world-atlas` `countries-50m.json` (jsdelivr CDN), Natural Earth data via TopoJSON | All 241 shapes, Antarctica included (it was excluded originally; the polar regions were missing) |
| Continent of every country (Geographic style, continent names) | **Wikidata** "continent" (P30), bundled as `data/continents.json` | Built by `scripts/build-continents.mjs`, not hand-typed. Countries Wikidata lists on several continents get the one holding most of their area — see limitations |
| Elevation and ocean depth (Elevation style) | **Mapzen "Terrarium" terrain tiles** on AWS Open Data (`s3.amazonaws.com/elevation-tiles-prod`), built from SRTM, GMTED and ETOPO1 | Live, no key, CORS-enabled. 16 base tiles load when you first pick Elevation; sharper tiles load for what's on screen as you zoom |

## Assumptions and known limitations

- **Four things the spec asks for are no longer shown at all.** The national fruit/tree/animal/bird,
  the 3–5 population challenges with mitigations, the 5–8 interesting facts and the History section's
  "independence: date and from whom" all came from hand-authored files
  (`data/country-details/<ISO3>.json`), which were deleted on 2026-09-21. No open API publishes any of
  them — Wikidata has a country's inception date but not whom it became independent *from* — so the
  Culture section no longer lists symbols and the Population Challenges and Interesting Facts sections
  are gone rather than standing empty for every country. Everything the page still shows is live data.
- **Religion coverage is real but sparse.** Wikidata's structured religion-with-percentage
  data (P140/P1107) exists for only ~30 of 250+ countries. Every other country shows "Not
  available" honestly rather than a guessed figure.
- **Tourist-attraction coverage is ~65%.** Confirmed live: 163 of ~250 ISO entries have at
  least one Wikidata item tagged as a tourist attraction. For the rest the map shows the
  capital marker alone.
- **The "largest cities" Wikidata query times out for some large, heavily-documented
  countries** (confirmed live for India, even with a small `LIMIT` and a non-transitive
  class filter) — the public Wikidata Query Service can't complete a country-wide city
  join fast enough. It's timeout-guarded (8s) and falls back to the capital alone, exactly the
  "capital plus the largest cities from Wikidata" fallback the spec describes.
- **Wikidata's own data has real, observed gaps and quirks**, all handled explicitly
  rather than papered over: some countries have no P421 timezone at all; P37 (official
  language) omits English for the USA (no federal de jure status), so it's topped up with
  P2936 only when the gap is small (confirmed: 300+ P2936 entries for India would
  otherwise swamp the field); P35 (head of state) has zero statements for some
  presidential republics (confirmed for the USA) — the head of government is shown for
  both fields in that case, since the roles are genuinely combined, not invented;
  occasionally a prominent, recently-edited entity's English label is blank on Wikidata
  even though dozens of other languages are populated — a fallback chain (primary API,
  then the entity's English Wikipedia article title) recovers it.
- **Kosovo's ISO alpha-3 differs by source.** The app's canonical code is `XKX` (matches
  World Bank and everyday usage); Wikidata's own best-rank code is `XKS`. A one-entry
  override map handles this only when querying Wikidata.
- **Antarctica's numeric code is patched into the search index.** Wikidata has no ISO
  numeric code for it, but the map data identifies the shape only by numeric id (`010`), so
  `data/search-index.json` carries `"isoNumeric": "010"` for `ATA` — the one hand edit to that
  file besides Kosovo's alpha-3 handling.
- **The France/Norway map-data bug** some Natural Earth-derived datasets have (a raw
  `ISO_A3 = "-99"` field for both) can't resurface here: shapes are joined to data only
  through the topology's numeric id against our own alpha-3 table, and that numeric id
  is unaffected by the bug.
- **Two different "which part of a country" rules.** *Labels* sit on a country's largest
  landmass (so France's name lands in France, not over French Guiana). *Zoom* covers every
  **significant** part — a polygon counts if it is at least 0.015% of the country's area
  (`MIN_TERRITORY_SHARE`, calibrated against the real topology: Hawaii's Big Island and
  Mayotte are in, Bouvet-sized specks are out) — and skips pieces on the far side of the
  ±180° antimeridian, which sit at the opposite edge of this non-wrapping map (New Zealand's
  Chatham Islands). Russia is the harder case: its largest polygon is a *single ring* that runs
  across ±180°, so pieces cannot be excluded whole — the ring's own far-side points (Chukotka's
  far tip, at the map's left edge) are dropped instead. That is what lets selecting Russia zoom and
  bring its Far East out from under the side panel. A side effect worth knowing: France, the Netherlands
  (Bonaire) and Portugal (Azores) now zoom out to fit their overseas territories, exactly as
  requested, so their mainland appears small.
- **Two map shapes can share one ISO code.** In world-atlas, Ashmore and Cartier Islands
  (3 km²) carries Australia's numeric id. The largest shape *is* the country (selection, zoom,
  label) and the rest are its parts, highlighted together. The map used to keep the last one,
  which sent Australia's zoom to a speck in the Timor Sea.
- **Why country facts come from the Action API, not SPARQL.** They used to come from two large
  Wikidata Query Service queries. That service is throttled per client, and under load even a
  one-fact query takes 30–60 s or is refused (HTTP 429), so a country's panel showed "Not available"
  for its capital, area, time zones and anthem while the World Bank half (population) loaded fine —
  reported for Brazil and Russia. The Action API answers the same questions in 1–3 s and is not in
  that queue. The Query Service is still used, but only for the optional extras on the country page
  (major cities, attractions, religion), each with a local fallback and a short timeout.
- **A failed request is never mistaken for a missing fact.** Every Wikidata, Commons, Wikipedia and World
  Bank request retries transient failures (429, 5xx, dropped connections, timeouts, and the MediaWiki API's
  habit of answering HTTP 200 with an `{error}` body — all in `lib/mediaWikiApi.js`) with jittered backoff
  (`lib/http.js`); a server that asks to be left alone for longer than a page can wait (`Retry-After` over
  5 s) is not retried at all. If a source still fails, the panel/page shows *"Some details could not be
  loaded from Wikidata just now. [Try again]"* beside whatever did load. Failed and partial results are
  **never remembered** (they used to be, for the whole session), and each source's answer is remembered on
  its own, so *Try again* asks again only for what failed — a Wikidata hiccup does not re-download the World
  Bank's 43 indicators. "Not available" is reserved for "the source answered and has no such value". That
  covers the partial cases too: an anthem whose recording lookup failed, a World Bank read with one failed
  indicator, a Wikipedia narrative whose search failed (versus one with no article) all count as failed
  sources, and an answer that is not the shape of an answer at all (an empty body, a page with no query
  result) is a failure rather than "nothing there". The World Bank client keeps the two apart the same way:
  its answer for a place it does not cover (HTTP 200 with a message, id 120 — Vatican City) is *no data*; any
  other message is a failure.
- **The optional extras are best-effort, with a difference.** Religion percentages, major cities and
  attractions all come from Wikidata's Query Service, which is throttled routinely, and fall back to what is
  on hand — the capital for cities, nothing for the other two — *without* a notice, since they are secondary
  and a Try again would usually fail again. But a refusal or timeout there is still not treated as "there are
  none": it is not remembered, so the next visit asks again.
- **Failures are written to the console** (`console.warn`, once per failed source, with the reason). An
  outage and a bug both look like "some details could not be loaded"; that line is what tells them apart.
- **How long the page can wait.** Requests to one host are capped (6 World Bank / 5 Wikipedia in flight),
  each attempt is timed from when it is actually sent, and no single source may keep the panel waiting
  longer than 20 s: the rest of the country shows without it. *Try again* on a request that has hung past that
  starts a new one (rather than waiting out the same hung request), and whichever answers completely first
  is kept. The independent sources of the country page (pyramid, subdivisions,
  Wikipedia, cities…) start together with the summary rather than after it.
- **Which Wikidata statements are believed** (`lib/wikidataEntity.js`). An item keeps its history:
  Brazil lists two capitals (Rio ended in 1960) and nine currencies, Russia two anthems, the Vatican
  eight population figures. Statements that are deprecated or have an end time are dropped. For
  multi-valued facts (languages, time zones, currencies, continents) *all* remaining values are shown,
  the ones ranked "preferred" first — rank means "primary", not "only", and treating it as "only" hid
  Brazil's English official name and 14 of Russia's 15 time zones. Single-valued facts (capital, head
  of state, area, population, flag, anthem) take the preferred statement, else the first current one.
  "Ended" means an end time that is in the past, or an end of *unknown value*; Wikidata's "no end"
  marker and a future end date do not end a statement. Dates are shown at the precision Wikidata has
  them (a year-only inception reads "1947", not "January 1, 1947") and as UTC calendar dates, so they
  do not slip a day west of Greenwich.
- **The Netherlands is Q55, not the Kingdom.** On Wikidata the ISO code NLD is a normal statement only
  on the Kingdom of the Netherlands (Q29999) and a *deprecated* one on the country (Q55), so a search by
  code returns the Kingdom. `data/wikidata-ids.json` pins Q55 (see `PREFERRED_ITEMS` in `scripts/build-wikidata-ids.mjs`;
  rebuild the file with `npm run build:ids`) and a unit test guards it, so the panel shows the country's
  own continent, currency and time zones rather than the Kingdom's.
- **Vatican City has no population pyramid, and none can be drawn honestly.** The World Bank rejects
  its code, and neither Wikidata nor the CIA World Factbook publishes an age-by-sex breakdown for it
  (only a total: 882 in 2024 on Wikidata, shown in its place). Rather than a bare "Not available", the
  page says exactly that. The same message appears for any place the World Bank lacks age data for; a
  *failed* request gets a different message and a Try again.
- **Time zones are shown as UTC offsets.** Wikidata labels a zone several ways ("UTC+01:00", "Central
  European Time", "Europe/Vatican"); when any label is an offset the named and IANA duplicates are
  dropped, and the zones are listed west to east.
- **Links within the country page are anchors, not routes.** Only `#/…` hashes are routes
  (`lib/router.js`); the section links (`#geography`…) and the skip link scroll the page and leave the view
  alone. (They used to be read as "the map view", so the first click threw you out of the country page.)
- **A code that is not a country** (a typed-in `#/country/ZZZ`) says so and offers nothing to retry, instead
  of "could not load" with a Try again that can never work.
- **Leaving a country page that is still loading cancels it**, and a page that never finished (or showed a
  Try again) is rebuilt on the next visit; a finished page is kept as it was.
- **The anthem stops the moment another country is selected**, not when that country's data arrives
  (which may be seconds away, or never if it fails to load). Try again on the same country does not
  interrupt what is playing. If every recording file for a country fails to load, the player says
  "Recording could not be loaded. Press play to try again." (Play stays available and asks for the files
  again); "Recording unavailable" is kept for a country that has no recording at all.
- **Hover is an overlay, not a transform.** The pop-out used to scale the real shape around
  the middle of its bounding box — for the USA, stretched across the whole map by the Aleutians —
  which tore Alaska away from Canada, and re-parented the shape, so it could get stuck
  highlighted. Now one tracked value says which country is hovered, and a copy of each of its
  pieces is scaled around its *own* center on a layer above the map. The real shapes never move.
  (The topology itself has no gaps: every real border is a shared arc.)
- **Geographic-style continents are a single choice per country.** Wikidata lists Russia,
  Turkey and Kazakhstan on both Europe and Asia; each takes the continent holding most of its
  area (Asia for all three — see `PRIMARY_CONTINENT_OVERRIDES` in
  `components/world-map/continents.js`). This is a coloring convention, not a border claim;
  the continent *names* are drawn at fixed positions, like ocean names.
- **Elevation resolution.** World view uses ~39 km tiles, so narrow features (a single ridge,
  a small lake) blur; zooming in fetches up to ~5 km tiles. Latitudes beyond ±85.05° (the
  Web-Mercator limit of the tile set) repeat the last row of data, which is why the very poles
  are approximate. Elevation is drawn behind the country outlines and clipped to them, so the
  crisp vector coastline wins over the raster's own 0 m contour.
- **Antarctica's side panel has gaps, honestly.** It is not a country, so Wikidata lists no capital,
  continent, language or currency for it and those read "Not available" (correctly: nothing failed, so
  there is no *Try again*). Its name, area, time zones and population (about 5,000, from Wikidata — the
  World Bank has none) do load, in a few seconds.
- **Map options are not remembered between visits** (in-memory only), and are not part of the
  shareable URL.
- **A handful of countries' shapes are sub-pixel even at maximum zoom** (Vatican City,
  Monaco, San Marino — calibrated against real measured pixel sizes, not guessed). These
  use the same fly-to-marker treatment as countries with no drawn shape at all (Tuvalu).
- **Country shapes are mouse/touch-clickable but not part of the Tab order.** An earlier
  attempt at making all 240 shapes individually focusable turned up a real accessibility
  bug (`role="img"` on the map SVG pruned every descendant, including tabindex'd paths,
  from the focus tree) — fixing the bug reopened a design question: 240 sequential Tab
  stops to reach, say, Australia is a well-known anti-pattern for choropleth maps. The
  search box is the deliberate, documented, fully-tested full-keyboard path to any
  country, drawn or not.
- **Flag images can take a few extra seconds to appear.** A flag is a file on Wikimedia Commons,
  reached through its `Special:FilePath` redirect, and that redirect chain is outside the app's control.
- **A country page makes on the order of 60 live requests** (the Wikidata item and its
  labels, subdivisions, religion + cities + attractions, 9 World Bank scalars, a 17-band
  population pyramid = 34 indicators, 5 Wikipedia topic lookups). This is inherent to fetching this much live, real content
  instead of hardcoding it — expect it to take several seconds, which is what the loading
  skeleton is for. Every request is timeout-guarded (12 s per attempt for Wikidata's Action API, the
  World Bank and the map's own data, 15 s for Wikipedia, 8 s for the optional Query
  Service extras; the map and chart scripts 20 s) and
  each source has the 20 s deadline above, so a slow or rate-limited service degrades to a *Try again*
  notice instead of hanging the page. (A CDN can also stall *part-way* through a download — headers
  arrive, the body never does; seen with the map's topology file in Firefox — which is why the map data
  is abandoned and re-requested after 12 s, up to twice, and then shows an error with *Try again* rather
  than a blank map.)
- **This project was tested against real, live traffic to these APIs**, not mocks or
  fixtures — the E2E suite genuinely exercises Wikidata/World Bank/Wikipedia/OpenStreetMap
  on every run. Several real bugs (see git history / development notes) were found exactly
  this way and would not have surfaced against a mocked or hand-authored dataset.

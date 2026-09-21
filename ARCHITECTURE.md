# Country Explorer — Architecture & Flow Reference

> **Purpose of this file:** the single, pre-digested description of what this project is and how it
> works, written for AI assistants and new developers. Read this **instead of scanning the repo**.
> Only open source files once this file tells you which ones matter for the task at hand.
>
> Companion files: `README.md` = product behaviour + the long catalogue of real-world data quirks.
> `WorldMapProjectPrompt.md` = the original spec. `CLAUDE.md` = rules for keeping *this* file current.

---

## 1. What the project is

An interactive world map + country almanac. Pick a country on the map (or via search) → a side panel
shows a quick summary → "More details" opens a full country page. **Every real-world fact is fetched
live** from free, key-less, CORS-enabled APIs (Wikidata, World Bank, Wikipedia, OpenStreetMap,
AWS terrain tiles). Nothing about a country is hardcoded apart from a handful of documented overrides —
the six hand-authored `data/country-details/*.json` files were deleted on 2026-09-21 (see §7).

**Hard constraints — do not break these:**

| Constraint | Why |
|---|---|
| **Zero build step.** `index.html` loads plain `.js` as native ES modules. No bundler, transpiler, or framework. | The app must run from any static file server. `npm install` is for the *test suite only*. |
| **No API keys, no server.** Pure static front end; all APIs are public and CORS-enabled. | Deployability + the project's premise. |
| **Must be served over http(s)**, not `file://`. | ES modules + `fetch` are blocked on `file://`. |
| **No hardcoded country facts.** | The premise of the project. Exceptions are listed in §7. |
| **A failed request is never shown as "no data".** | Core reliability rule — see §6. |

Third-party libs are CDN UMD globals: **D3 7.9**, **topojson-client 3.1**, **Fuse.js 7.2** (deferred in
`index.html`), plus **Leaflet** and **Chart.js 4.5** loaded lazily at runtime by the country page
(`lib/domUtils.js` → `loadScript`/`loadStylesheet`).

---

## 2. Repo map

```
index.html                 Single page. Loads CSS, 3 CDN globals, then lib/main.js (module entry).
lib/                       App-wide plumbing (no UI markup except domUtils helpers).
components/                UI, one folder per surface, each with its own .css.
data/                      Generated + hand-authored JSON shipped with the app.
scripts/                   Node build scripts for the generated data + dev server helper.
styles/                    reset.css, variables.css (design tokens), layout.css.
tests/unit/                node --test, pure modules only, no network (~392 tests).
tests/e2e/                 Playwright, 3 browsers, against a live server AND the real APIs.
_legacy/                   Old standalone prototypes. NOT loaded, not maintained. Ignore.
assets/icons/, components/country-page/sections/   Empty placeholders. Ignore.
```

### `lib/` — plumbing

| File | Responsibility |
|---|---|
| `main.js` | **Entry point / composition root.** Wires router + store + all four top-level components + the About modal, owns view switching and the search-box ↔ selection sync. Exposes `window.__worldMap` / `window.__navigate` as E2E hooks. |
| `router.js` | Hash routing. `#/` = map, `#/country/<ISO3>` = country page. **Only `#/…` hashes are routes**; `#geography` etc. are in-page anchors and must not change the view. |
| `store.js` | ~20-line observable store. Frozen state object, `getState`/`setState(patch)`/`subscribe`. Keys: `selectedIso3`, `panelOpen`, `fullscreen`, `mapTransform`, `offMapMarker`. |
| `dataService.js` | **The orchestrator.** Public reads: `getCountrySummary` (panel) and `getCountryFullDetails` (country page — wraps `getCountryFullDetailsProgressive`). Per-source memo + cache policy, per-source 20 s deadline, failure reporting. Every source it reads is live — it touches no bundled content. See §5–6. |
| `http.js` | Every network call goes through here: timeout per attempt, retry with jittered backoff (429/5xx/network), `Retry-After` honouring, per-host concurrency limiter, `HttpError`. |
| `mediaWikiApi.js` | Wrapper for the MediaWiki Action API (Wikidata, Commons, Wikipedia). Converts `HTTP 200 + {error}` bodies into real errors so "busy" is never read as "no data". |
| `wikidataClient.js` | Country facts via the **Action API** (`wbgetentities`/`wbgetclaims`), plus the optional **SPARQL** extras (religions, major cities, attractions) with short timeouts + fallbacks. |
| `wikidataEntity.js` | **Pure** readers over Wikidata entity JSON: which statements to believe (rank, deprecation, end-times), dates at their real precision, UTC offsets, etc. Heavily unit-tested. |
| `worldBankClient.js` | World Bank Indicators v2: 9 scalar demographics + 34-indicator population pyramid. Keeps "no data for this place" and "request failed" strictly apart. |
| `wikipediaClient.js` | Five narrative topics per country (culture, sports, geography, government, history). Resolves article titles via the search API rather than guessing them. |
| `searchIndex.js` | Loads/caches `data/search-index.json`; lookup by ISO3 and by **ISO numeric** (the map's only join key). |
| `format.js` | Display formatting (numbers, stats with year, area, UTC dates, lists, "Not available"). Pure. |
| `domUtils.js` | `createEl`, `announce` (live region), `prefersReducedMotion`, `loadScript`/`loadStylesheet`. |
| `mathUtils.js` | `clamp` — split out so DOM-free modules stay Node-testable. |

### `components/`

| Folder | Entry | Notes |
|---|---|---|
| `world-map/` | `WorldMap.js` (`createWorldMap`) | Largest surface. D3 + TopoJSON SVG map. Returns `{selectCountry, clearSelection, reset, zoomBy, getTransform, restoreTransform, setOptions, toScreen, isGeoPointInView}`. Split into ~18 modules — most are **pure** so they can be unit-tested (see §4). |
| `search/` | `SearchBar.js` | Fuse.js fuzzy search over the bundled index; the documented full-keyboard path to any country. |
| `side-panel/` | `SidePanel.js` | Subscribes to the store; loads `getCountrySummary`; Close/Esc, fullscreen toggle, "More details" link. |
| `country-page/` | `CountryPage.js` | Full page: header stats, section nav + scroll-spy, Leaflet map, Chart.js population pyramid, 6 content sections (overview, geography, history, government, culture, population). Uses progressive rendering — `buildPage` runs as soon as the summary resolves; each section fills via `data-fill` targets when its own Promise settles. |
| `anthem-player/` | `AnthemPlayer.js` | **Singleton** `<audio>` in `#anthem-player-root`, outside both view trees, so navigation never interrupts playback. `mountInto(container)` only moves the visible controls. |
| `about/` | `AboutModal.js` | "ⓘ About" pill button (bottom-right map overlay, slides with the side panel) + a `<dialog>` popup. No external data. Edit `AboutModal.js` to fill in bio/project details. |
| `shared/` | `LoadingSkeleton`, `ErrorRetry`, `PartialDataNotice` | Loading / error / partial-data UI + the screen-reader wording. |

### `data/` and `scripts/`

| File | Origin | Rebuild |
|---|---|---|
| `data/search-index.json` | All ISO 3166-1 entries + Kosovo: names, aliases, codes, coords. Pulled from Wikidata at authoring time. Hand edits: Kosovo alpha-3, Antarctica `isoNumeric: "010"`. | — (authored once) |
| `data/wikidata-ids.json` | ISO3 → Wikidata item id. Pins overrides (e.g. Netherlands = Q55, not the Kingdom). | `npm run build:ids` |
| `data/continents.json` | ISO3 → continent (Wikidata P30), one primary continent per country. | `npm run build:continents` |

There is **no hand-authored country content**. `data/` holds only generated lookup tables; anything a
visitor reads about a country came off the wire in that session.

---

## 3. Runtime flows

### 3.1 Boot

```
index.html → CSS + (D3, topojson, Fuse as deferred UMD globals) → lib/main.js
main.js: createCountryPage(mount)
         createWorldMap(mount, {onSelect})        → fetches world-atlas TopoJSON (CDN) + continents.json
         createSearchBar(mount, {onSelect})       → loads data/search-index.json
         createSidePanel(mount)                   → subscribes to store
         createAboutModal(mapView)               → mounts "ⓘ About" button + <dialog> (no data)
         subscribe(...)                           → keeps search box text + panel CSS in sync
         startRouter({onMapView, onCountryView})  → resolves the current hash immediately
```

`#view-map` and `#view-country` are two `<section>`s toggled with `hidden`; the map's zoom transform is
saved on the way into a country page and restored on the way back.

### 3.2 Selecting a country (map click or search)

```
click on shape ──► WorldMap resolves numeric ISO id ──► searchIndex.getEntryByIsoNumeric ──► iso3
                   (never a name/alpha-3 baked into the map data)
  ├─ WorldMap: highlight all parts, zoom to every significant territory, centre in the
  │            area the side panel does not cover
  └─ onSelect(iso3) ──► setState({selectedIso3, panelOpen: true, fullscreen: false})
                          ├─ SidePanel (subscriber) ──► getCountrySummary(iso3)
                          │     └─ skeleton → facts + flag + anthem controls (+ partial-data notice)
                          └─ main.js ──► search box shows the country's name
```

Search selects through `worldMap.selectCountry(...)` so the map and the panel can never disagree.
Closing the panel (Close / Esc) clears `selectedIso3`, which is the **only** place selection is cleared
from the store side.

### 3.3 Country page (Phase 1 — progressive rendering)

```
"More details" / deep link / refresh ──► hash #/country/XXX ──► router ──► main.js showCountryView
  save map transform · hide map view · setState({selectedIso3, panelOpen:true}) · countryPage.render(iso3)
      └─ getCountryFullDetails(iso3)  [wraps getCountryFullDetailsProgressive]
            returns synchronously: { summary: Promise, sections: { religions, cities,
                                     attractions, topics, pyramid, states } }
            ├─ summary  → shared memo with the panel; resolves in ~30 ms when panel was opened first
            └─ sections → each is an independent Promise, all started immediately in parallel

      On summary resolve (~30 ms from warm panel):
      └─ buildPage → header stats · section nav (scroll-spy) · section skeletons with [data-fill] targets
                   → Leaflet map (lazy) · Chart.js pyramid skeleton (lazy)

      As each section Promise settles (independently, seconds later):
      └─ isCurrent() guard checked before every DOM write — stale writes from a
         navigated-away build are silently dropped
      └─ fill [data-fill="religions"] · [data-fill="cities"] · [data-fill="attractions"]
         · [data-fill="geography-narrative"] etc. · population pyramid (Chart.js)
```

**Key constraint:** `buildPage` is called exactly once per `render()` call, as soon as `summary`
resolves. Every section fill is a separate async tail that runs later. `isCurrent()` compares a build
token stamped at render-start; if the token changed (user navigated away or reselected), the fill is
a no-op.

Navigating away calls `countryPage.leave()`, which cancels an in-flight build. A page that finished
cleanly is kept; one that failed or was abandoned is rebuilt on the next visit.

### 3.4 Map options

`MapControls` → `normalizeOptions` (validating, immutable) → `WorldMap.setOptions` → re-colour, relabel,
toggle overlays, mount/unmount the elevation raster layer, refresh the legend. Options are in-memory
only: not persisted, not in the URL.

---

## 4. Map internals (only read these when touching the map)

The rule here is **pure logic in its own module, DOM/D3/network in `WorldMap.js`** — that is why so
much of the map has real unit tests.

| Module | Pure? | Job |
|---|---|---|
| `countryColoring.js` | ✅ | Welsh-Powell greedy colouring so no two neighbours share a fill. |
| `countryGroups.js` | ✅ | Two shapes can share one ISO code → largest shape *is* the country, rest are its parts. |
| `mainLandmass.js` | ✅ | Label anchor = largest polygon; zoom bounds = every territory ≥ `MIN_TERRITORY_SHARE`, minus antimeridian pieces. |
| `labelPlacement.js` | ✅ | Greedy, non-overlapping label placement; `visibleAtZoom` drives the reveal-on-zoom tiers. |
| `viewport.js` | ✅ | `preserveAspectRatio="slice"` view-box ↔ screen maths, `fitTransform`, `shouldKeepZoom`, panel-aware available rect. |
| `graticule.js` / `oceanLabels.js` / `continents.js` / `legendSpecs.js` / `mapModes.js` | ✅ | Grid + special latitudes, water names, continent names/overrides, legend content, validated options. |
| `elevation.js` | ✅ | Terrarium tile decode, band table, slippy-tile maths, bilinear sampling, raster painter. |
| `hoverTracker.js` | ✅ | The single source of truth for "which country is hovered". |
| `WorldMap.js` | ❌ | SVG/D3 orchestration, zoom/pan, selection, data loading. |
| `hoverController.js` | ❌ | Draws the hover pop-out as an **overlay copy**; the real shapes are never transformed or re-parented. |
| `elevationLayer.js` | ❌ | Canvas + tile fetching for the elevation style. |
| `geoOverlays.js`, `frameLabels.js`, `MapLegend.js`, `MapControls.js`, `Compass.js` | ❌ | Overlay rendering and the HUD controls. |

Notable constants in `WorldMap.js`: `MIN_SCALE 1` / `MAX_SCALE 12`, `VIEWBOX 960×500`, `TOP_MARGIN 34`,
`DOMINANT_MAINLAND_SHARE 0.6`, `FOCUS_TOLERANCE 0.15`, `MIN_VISIBLE_PX_AT_MAX_SCALE 15` (below this a
country gets the off-map marker treatment), topology timeout 12 s × 2 retries.

---

## 5. Data layer contract

**`getCountrySummary(iso3)`** (side panel — fast path) merges 4 sources:
`wikidataCore` · `wikidataLists` · `worldBankDemographics` · bundled index entry → `normalizeSummary()`.

**`getCountryFullDetails(iso3)`** (country page) wraps `getCountryFullDetailsProgressive` and returns
**synchronously** before any network call completes:

```js
{
  summary: Promise,   // shared memo with the panel — resolves in ~30 ms when warm
  sections: {
    religions: Promise, cities: Promise, attractions: Promise,
    topics: Promise, pyramid: Promise, states: Promise,
  }
}
```

All six section Promises are started immediately in parallel with `summary`. `CountryPage.js` awaits
`summary` first (to paint the page shell + nav + skeletons), then fills each `[data-fill="…"]` target
as its section Promise settles independently.

`mergeFullDetails` is still used internally to assemble the sections object from the raw source promises.
**`mergeFullDetails` takes its settled results positionally** — adding or removing a source means
changing the destructure and every test call site.

`normalizeSummary` and `mergeFullDetails` are **exported pure functions** — test merge behaviour with fake
settled results, never with the network. `createDataService(deps, {deadlineMs, report})` exists so the whole
caching policy can be tested without a network; the module also exports a default wired instance.

What each source means for the product (coverage, quirks) lives in README.md §"Data sources"; the table
below is the wire-level reference: every endpoint, the exact properties/fields read, and a runnable call.

### 5.1 API catalogue

Examples use Brazil (`BRA`, item `Q155`; capital `Q2844`, anthem `Q134654`); swap the ids for any country.
`%7C` is the `|` separator the clients send. Wikimedia asks scripted clients to send a descriptive
`User-Agent` — add `-A 'your-tool/1.0'` if a call is refused. All verified live on 2026-09-21.

| API URL | Fields used | Curl invocation | File name |
|---|---|---|---|
| **Wikidata Action API** — `https://www.wikidata.org/w/api.php` `action=wbgetentities&props=claims` (country item, ~800 KB) | `P1448` official name · `P36` capital · `P625` centre coords · `P2046` area (km² unit only) · `P38` currencies · `P30` continents · `P41` flag file · `P571` inception · `P122` government form · `P35` head of state (falls back to `P6`) · `P6` head of government · `P85` anthem (+ its `P51` qualifier) · `P1082` population (fallback only) · `P37` official languages · `P2936` languages used · `P421` time zones · `P150` subdivisions. Statement choice uses rank, deprecation, qualifiers `P582` end time / `P585` point in time | `curl -s 'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q155&props=claims&format=json&origin=*'` | `lib/wikidataClient.js` (`getEntity`, `core`, `lists`, `statesTerritories`), `lib/wikidataEntity.js` |
| **Wikidata Action API** — `wbgetentities&props=labels%7Csitelinks` (≤50 ids per batch) | `labels.en.value` for capital, currencies, continents, government form, office holders, anthem, languages, time zones, subdivisions (≤150) | `curl -s 'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q2844%7CQ134654&props=labels%7Csitelinks&languages=en&sitefilter=enwiki&format=json&origin=*'` | `lib/wikidataClient.js` (`getLabels`) |
| **Wikidata Action API** — `wbgetclaims&property=P625` on the capital | `P625` latitude / longitude of the capital | `curl -s 'https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=Q2844&property=P625&format=json&origin=*'` | `lib/wikidataClient.js` (`core`) |
| **Wikidata Action API** — `wbgetclaims&property=P51` on the anthem (only when the P85 statement has no P51 qualifier) | `P51` audio file name | `curl -s 'https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=Q134654&property=P51&format=json&origin=*'` | `lib/wikidataClient.js` (`readAnthem`) |
| **Wikidata Action API** — `list=search&srsearch=haswbstatement:P298=…` (fallback when `data/wikidata-ids.json` has no entry) | `query.search[0].title` → item id | `curl -s 'https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=haswbstatement:P298=BRA&srlimit=5&format=json&origin=*'` | `lib/wikidataClient.js` (`resolveQid`) |
| **Wikidata Query Service** — `https://query.wikidata.org/sparql` (religions) | `P298` ISO code → `P140` religion + qualifier `P1107` proportion; English `rdfs:label` | `curl -s -G 'https://query.wikidata.org/sparql' -H 'Accept: application/sparql-results+json' --data-urlencode 'query=SELECT ?relLabel ?pct WHERE { ?item wdt:P298 "IND" . ?item p:P140 ?stmt . ?stmt ps:P140 ?rel . OPTIONAL { ?stmt pq:P1107 ?pct . } ?rel rdfs:label ?relLabel . FILTER(LANG(?relLabel)="en") }'` | `lib/wikidataClient.js` (`religionQuery`, `fetchReligions`) |
| **Wikidata Query Service** — major cities / tourist attractions | `P31`=`Q515` (city) or `Q570116` (tourist attraction) · `P17` country · `P625` coords · English label · ranked by sitelink count, `LIMIT 8` | same call as above with the query text from `placesQuery(iso3, 'Q515' \| 'Q570116', 8)` | `lib/wikidataClient.js` (`placesQuery`, `fetchMajorCitiesDynamic`, `fetchTouristAttractions`) |
| **Commons Action API** — `https://commons.wikimedia.org/w/api.php` `prop=imageinfo` | `imageinfo[0].url` (OGG), `extmetadata.LicenseShortName`, `extmetadata.Credit`; MP3 URL derived as `upload.wikimedia.org/…/transcoded/…/<file>.mp3` | `curl -s 'https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&titles=File:Hino-Nacional-Brasil-instrumental-mec.ogg&iiprop=url%7Cextmetadata&format=json&origin=*'` | `lib/wikidataClient.js` (`getCommonsFileInfo`) |
| **Commons file redirect** — `https://commons.wikimedia.org/wiki/Special:FilePath/<file>` | Flag image (`P41`); anthem audio fallback when the file-info lookup fails. Used as an `<img>`/`<audio>` src, not fetched as JSON | `curl -sIL 'https://commons.wikimedia.org/wiki/Special:FilePath/Flag%20of%20Brazil.svg'` | `lib/wikidataClient.js` (`commonsFilePath`) |
| **World Bank Indicators v2** — `https://api.worldbank.org/v2/country/<ISO3>/indicator/<code>?format=json&per_page=1&mrnev=1` (demographics, 9 requests) | `[1][0].value` + `[1][0].date` for `SP.POP.TOTL` population · `EN.POP.DNST` density · `SP.DYN.CBRT.IN` birth rate · `SP.DYN.CDRT.IN` death rate · `SP.POP.GROW` growth · `SM.POP.NETM` net migration · `SP.DYN.LE00.IN` life expectancy · `SP.POP.TOTL.MA.IN` / `SP.POP.TOTL.FE.IN` male / female. `[0].message[].id = "120"` = no data | `curl -s 'https://api.worldbank.org/v2/country/BRA/indicator/SP.POP.TOTL?format=json&per_page=1&mrnev=1'` | `lib/worldBankClient.js` (`fetchWorldBankDemographics`) |
| **World Bank Indicators v2** — population pyramid (34 requests) | `SP.POP.<band>.MA` / `SP.POP.<band>.FE` for 17 bands `0004` … `7579`, `80UP` (`PYRAMID_BANDS`) | `curl -s 'https://api.worldbank.org/v2/country/BRA/indicator/SP.POP.0004.MA?format=json&per_page=1&mrnev=1'` | `lib/worldBankClient.js` (`fetchWorldBankPyramid`) |
| **Wikipedia Action API** — `https://en.wikipedia.org/w/api.php` `list=search&srlimit=1` (5 requests) | `query.search[0].title` for "Culture of X", "Sport in X", "Geography of X", "Politics of X", "History of X" | `curl -s 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=Culture%20of%20Brazil&srlimit=1&format=json&origin=*'` | `lib/wikipediaClient.js` (`resolveTitle`, `TOPIC_QUERIES`) |
| **Wikipedia REST** — `https://en.wikipedia.org/api/rest_v1/page/summary/<title>` (5 requests) | `title`, `extract` (lead-section narrative), `content_urls.desktop.page`, `type` (`disambiguation` → no article) | `curl -s 'https://en.wikipedia.org/api/rest_v1/page/summary/Culture_of_Brazil'` | `lib/wikipediaClient.js` (`fetchSummary`) |
| **world-atlas TopoJSON** — `https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json` | Country geometries + numeric ISO `id` (the only join key to `search-index.json`) | `curl -s 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json' -o countries-50m.json` | `components/world-map/WorldMap.js` |
| **OpenStreetMap tiles** — `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` | Raster tiles for the country-page Leaflet map | `curl -s -A 'your-tool/1.0' 'https://a.tile.openstreetmap.org/4/5/8.png' -o tile.png` | `components/country-page/CountryLeafletMap.js` |
| **AWS Terrain Tiles** — `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | Terrarium RGB → elevation metres (`elevation.js` decode) for the Elevation map style | `curl -s 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/2/1/1.png' -o terrain.png` | `components/world-map/elevation.js`, `elevationLayer.js` |

Bundled lookups read over the same origin (no external API): `data/search-index.json` (names, ISO2/ISO3/numeric
codes, aliases, fallback coords — `lib/searchIndex.js`), `data/wikidata-ids.json` (ISO3 → item —
`lib/wikidataClient.js`), `data/continents.json` (map colouring — `components/world-map/`). Libraries and fonts
come from CDNs (§1), not APIs.

---

## 6. Reliability rules (the part most likely to be broken by a careless change)

1. **Three distinct outcomes, never collapsed into one:**
   - *failed* → show what loaded + "Some details could not be loaded… [Try again]" (`PartialDataNotice`).
   - *no data* → literal "Not available" (the source answered and has no such value).
   - *best-effort extra unavailable* → the fallback shows with **no** notice (cities fall back to the
     capital; attractions and religions to nothing), but the failure is still not remembered.
2. **Failed or partial results are never cached.** A result is remembered only when complete
   (`createSourceMemo`), per source, per country — so *Try again* re-requests only what failed.
3. **Partial answers mark themselves** with `failedIndicators` / `incompleteParts`; a settled promise is
   *not* proof of success (clients resolve with nulls rather than rejecting).
4. **Per-source deadline 20 s** (`SOURCE_DEADLINE_MS`); the abandoned request keeps running and its answer
   may still be kept, but a later ask starts its own request rather than waiting out a hung one.
5. **Per-attempt timeouts** (12 s Wikidata Action API / World Bank / map data, 15 s Wikipedia, 8 s local
   file and SPARQL extras, 20 s lazy scripts) + retry with jittered backoff in `http.js`.
6. **Every failure is `console.warn`ed once**, with its reason — that is how an outage is told from a bug.
7. **Stale-response guards everywhere:** panel and page compare a request token and the current selection
   before rendering; the anthem stops on selection change, not on data arrival.
8. **`readAnthem` runs in parallel with `getLabels` and `getClaims(capitalId, P625)`** (`wikidataClient.js`
   `core()`). The anthem's P51 claim fetch and Commons file-info call have no dependency on the label
   batch, so they are started in the same `Promise.all`. The anthem title (which needs labels) is patched
   in afterward: `anthem = anthemRaw ? { ...anthemRaw, title: label(anthemId) } : null`. This saves
   ~350 ms off the panel critical path for countries where the P51 audio file must be fetched separately.

---

## 7. Deliberate exceptions & conventions

- **No hand-authored country content.** `data/country-details/` was removed on 2026-09-21 along with
  everything it fed: the national-symbols block, the Population Challenges and Interesting Facts
  sections, the History section's "Independence (date, from whom)" row, and the local-file fallbacks for
  religions, the five narratives, major cities and tourist attractions. The spec
  (`WorldMapProjectPrompt.md` §Country details 3, 5, 7, 8) still asks for those four; **the project
  knowingly no longer meets them**, because no open API publishes them. Do not re-add a "Details coming
  soon" placeholder section — an empty section for every country is what this removal got rid of.
- Documented overrides: Kosovo `XKX`↔`XKS`, Antarctica numeric `010`, Netherlands `Q55`,
  `PRIMARY_CONTINENT_OVERRIDES` (RU/TR/KZ → Asia).
- Map shapes are joined to data **only** through the topology's numeric ISO id → `search-index.json`.
  Never parse names or `ISO_A3` out of the map data (that field is `-99` for France and Norway upstream).
- Country shapes are pointer-clickable but **not** in the Tab order; search is the keyboard path. This is
  a documented, tested decision — do not "fix" it by adding 240 tab stops.
- Immutability: store state and `normalizeOptions` results are frozen; patch-and-replace, never mutate.
- All user-facing text goes through `textContent` / `createEl`; the only HTML string path (Leaflet popups)
  escapes its input.

---

## 8. Where to change what

| Task | Files |
|---|---|
| Restore hand-authored content (reverses the 2026-09-21 removal) | new `data/` files + a `source(...)` entry in `getCountryFullDetails` + a positional slot in `mergeFullDetails` + section builders in `CountryPage.js` |
| Add/adjust a country fact from Wikidata | `lib/wikidataClient.js` + `lib/wikidataEntity.js` (statement rules) → `normalizeSummary`/`mergeFullDetails` → the rendering component |
| Add a World Bank statistic | `lib/worldBankClient.js` (indicator list) → `normalizeSummary` → `SidePanel.js` / `CountryPage.js` |
| Change retry/timeout/concurrency behaviour | `lib/http.js`, deadlines in `lib/dataService.js` |
| Change caching / Try-again behaviour | `createSourceMemo` + `createDataService` in `lib/dataService.js` |
| New country-page section | `CountryPage.js` (`buildSections` + a `buildX` + a `data-fill` target in `buildPage`), `country-page.css`, nav entry in `buildSectionNav`; add a matching key in `getCountryFullDetailsProgressive`'s `sections` return |
| Side-panel facts | `SidePanel.js` `buildContent`, `side-panel.css` |
| Map style / legend / overlays | `mapModes.js`, `legendSpecs.js`, `WorldMap.js` `applyOptions`, `MapControls.js` |
| Label behaviour | `labelPlacement.js` (pure rules) + `WorldMap.js` `renderLabels` |
| Zoom / framing / panel-aware centring | `viewport.js` + `mainLandmass.js` |
| Elevation rendering | `elevation.js` (pure) + `elevationLayer.js` |
| Routing | `lib/router.js` + `main.js` view switching |
| Design tokens, spacing, colour | `styles/variables.css` (then per-component CSS) |
| Regenerate bundled data | `scripts/build-wikidata-ids.mjs`, `scripts/build-continents.mjs` |

---

## 9. Running, testing, verifying

```sh
python3 -m http.server 8420          # then http://localhost:8420/
npm run restart-server               # if port 8420 is serving another project
npm run test:unit                    # node --test, 382 tests, no network, <1s
npm run test:e2e                     # Playwright, 3 browsers, LIVE APIs (use --workers=2 to avoid 429s)
```

E2E hits the real APIs on purpose; `retries: 1` absorbs transient rate limiting. A test failing on every
retry is a real bug. New **pure** logic must arrive with unit tests; new **behaviour** with an E2E spec.

---

## 10. Known limitations

Not repeated here. `README.md` §"Assumptions and known limitations" is the authoritative, detailed list
(sparse religion data, SPARQL timeouts, Wikidata statement quirks, the antimeridian/Russia zoom problem,
elevation resolution, Vatican City having no pyramid, ~60 live requests per country page, …). Read it
before "fixing" anything that looks like a bug in those areas — most are documented, tested decisions.

---

## 11. Latency baseline (Phase 1 + 2, measured 2026-09-21)

These are real-network numbers from `npm run test:perf` against `localhost:8420`, using the HAR-based
analysis of a Greenland click. They capture the **critical path** — the time until the first visible
content appears, not total load time.

### Panel (side panel)

| Segment | Duration | Notes |
|---|---|---|
| `wbgetentities` (country entity) | ~1 400 ms | Dominates the panel critical path; unavoidable Wikidata latency |
| `getLabels + getClaims(P625)` (parallel) | ~400 ms | Runs alongside each other after entity resolves |
| `readAnthem` (P51 + Commons file-info) | ~0 ms **extra** | Phase 2: now runs in `Promise.all` with labels — no longer sequential |
| **Panel first fact** | **~2 800 ms** | Constant regardless of country (WB data plays no role in the panel critical path) |

**VAT diagnostic:** Vatican City has no World Bank data (WB returns id-120 "no data" in 0 ms), yet its
panel first-fact time is identical to India (~2 810 ms). This proves the ~2.8 s floor is Wikidata
Action API latency, not World Bank. There is no easy fix.

### Country page first section (Phase 1 — progressive rendering)

| Stage | Target | Measured |
|---|---|---|
| Page shell + section nav + skeletons | ≤ 100 ms after "More details" | **~28–35 ms** (summary already warm from panel) |
| First section fills | seconds later, per section | SPARQL queries 6–8 s; WB pyramid varies |

Phase 1 moved `buildPage` before the section data arrives — the shell renders in ~30 ms instead of
waiting for all sections (~10+ s).

### World Bank pyramid (country page)

34 per-indicator requests (`SP.POP.<band>.MA/FE`). The WB batch endpoint
(`/v2/country/{iso3}/indicator/{code1};{code2}…`) lacks `Access-Control-Allow-Origin` headers and
is **CORS-blocked in browsers**. Only the per-indicator endpoint is CORS-enabled. For small
countries (e.g. Greenland) with sparse data, individual requests can take 2–10+ s each; the pyramid
section fills last.

### SPARQL (country page sections)

Cities and religions queries are the slowest sections: 6–8 s in measured runs. SPARQL is query.wikidata.org
best-effort; no practical optimisation available from the client side.

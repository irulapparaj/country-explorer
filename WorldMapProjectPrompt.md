# Country Explorer: Interactive World Map

You are an expert front-end developer. Build a responsive website with two views: an interactive world map, where users click or search for a country to see a quick summary in a side panel, and a full country page with a detailed map and complete information about that country.

## Tech
- Plain HTML, CSS, and JavaScript (no build step), built as a single-page app with hash routing: `#/` for the world map and `#/country/IND` (ISO alpha-3 code) for a country page, so every country page has its own shareable link.
- World map: D3.js (d3-geo and d3-zoom) with the Natural Earth projection, drawn as SVG so hover effects can use CSS transforms and shadows. Shapes: Natural Earth country boundaries at 50m resolution (world-atlas countries-50m TopoJSON; the 110m file leaves out many small countries).
- Country page map: Leaflet with OpenStreetMap tiles (free, no key; show the required attribution). Charts: Chart.js.
- Link map shapes to country data by ISO 3166-1 codes, never by name.

## World map
- Looks like a classic political world map: each country filled with its own soft color (neighboring countries never share a color, e.g., using topojson.neighbors with a small palette), thin borders, light-blue oceans, and no Antarctica.
- Country names: label the major countries at the world view and reveal more as the user zooms in. Show a name only when it fits inside its country, so labels never overlap, and place each label inside the country's largest landmass (so France's label doesn't land in Spain because of French Guiana). Border widths and label sizes stay constant while zooming.
- Starts on the whole world. Zoom with +/− buttons, scroll wheel, and pinch; pan by dragging; a "Reset view" button returns to the start. Limit the zoom range and keep the map from being dragged out of view.
- Every country drawn on the map is clickable. Dragging the map must never count as a click.
- Hover: the country brightens and pops out slightly: it's drawn above its neighbors, scales up a little around its center, and gets a soft drop shadow, animated over ~150 ms and reversed on mouse-out. A tooltip shows its name. On touch screens, a tap selects instead.
- Selected country (clicked or searched): a distinct highlight color and outline that stays until another country is selected or the panel is closed. The map smoothly zooms to it.
- Zoom to the country's main landmass, so countries with distant territories (France, USA, Russia) don't zoom out to the whole world, and center it in the part of the map not covered by the side panel.

## Search
- Covers every country and territory, major or minor (the full ISO 3166-1 list, plus Kosovo), including ones too small to be drawn on the map. Build the list from the bundled search index (see Data), not from the map shapes.
- Search bar floating at the top. As the user types, show a dropdown of matching countries (↑/↓ to move, Enter to select, Esc to close).
- Matching ignores case and accents and includes official names and common alternatives (USA, UK, UAE, Ivory Coast, Burma, Turkey/Türkiye).
- If nothing matches, show "No country named '[typed text]'. Did you mean [closest match]?" Find the closest match with fuzzy matching (e.g., Fuse.js or Levenshtein distance); clicking the suggestion selects that country. If nothing is reasonably close, show "No matching country found."
- Selecting a result behaves exactly like clicking the country on the map: highlight, zoom, and open the side panel.
- If the country isn't drawn on the map, or is too small to see at the current zoom (e.g., Vatican City, Tuvalu), the map flies to its location and marks it with a pulsing ring in the selection color plus its name. The marker stays until another country is selected or the panel is closed, and clicking it reopens the panel.

## Side panel (quick summary)
- Slides in from the right when a country is selected (about 40% of the width on desktop; a bottom sheet on phones).
- Header: flag and country name, with two buttons in the top-right corner: Fullscreen (expands the panel to fill the window; click again to restore) and Close (×).
- Content: the national anthem player, then key facts only: official name, capital, continent, population (with year), area, languages, currency, and time zone(s).
- A prominent "More details →" button, always visible at the bottom of the panel. Make it a real link to the country page, so it can also be opened in a new tab.
- Smooth animations (~300 ms, ease-out) for opening, closing, and fullscreen. Selecting another country while the panel is open swaps the content with a quick fade instead of closing and reopening. Respect the system's reduced-motion setting.
- Esc exits fullscreen first, then closes the panel. Closing clears the highlight.

## Country page ("More details")
- Opens with a smooth transition. A "← Back to map" button and the browser's Back button both return to the world map at the same view, with the country still selected and its panel open. Opening or refreshing a country link directly loads that page.
- Header: flag, country name, official name, the anthem player, and a row of key stats (capital, population, area, currency).
- Country map: a large interactive map (about 60% of the screen height), zoomed to the country's main landmass with its outline highlighted (or, for countries with no shape in the map data, centered on their coordinates). Show markers for the capital (distinct icon), major cities, and tourist spots, with a legend and a toggle for each group. Clicking a marker opens a popup with its name and a one-line description, and users can zoom into any city down to street level.
- The map must not hijack page scrolling: enable scroll-wheel zoom only after the user clicks the map.
- Below the map, every section under "Country details" in full, with a sticky section menu that highlights the current section while scrolling (a horizontally scrollable bar on phones).

## National anthem player
- Show the anthem's title with a Play/Pause button directly above it, plus a progress bar, elapsed/total time, and the recording's source/license in small text.
- Use one shared player for the whole site: playback continues when moving between the side panel and the country page, and stops when a different country is selected or the panel is closed.
- Use only public-domain or freely licensed recordings (Wikimedia Commons). If none exists, show the title with a disabled button and "Recording unavailable". Playback must work in all major browsers, including Safari.

## Country details (all shown on the country page)
1. Overview: official name, continent, capital, geographical coordinates, area (km² and mi²), time zone(s), currency, official/main languages, major religions (approx. %).
2. Geography: climate, major geographical features, states/territories (count plus an expandable list), major cities, top tourist spots.
3. History: when it formed, colonization (if any), independence (date and from whom, if applicable).
4. Government: system of government, current head of state and head of government, key government policies.
5. Culture & national symbols: culture (traditions, food, festivals, arts), important sports, national fruit, tree, animal, and bird (the anthem player sits in the page header).
6. Population: population, population density, birth rate, death rate, net migration rate (per 1,000 people), male-to-female ratio, life expectancy, population growth rate, and a population pyramid (horizontal bars by 5-year age group, males left, females right, with hover tooltips).
7. Population challenges: 3–5 major challenges and practical ways to overcome each.
8. Interesting facts: 5–8 facts.

## Data
- Use only free sources that need no API key:
  - Wikidata, looking the country up by its ISO alpha-3 code (property P298) and using only current values, since it also stores historical ones: official name, capital and its coordinates, the country's center coordinates, area, languages, currency, time zones, continent, flag, states/territories, formation date, system of government, current leaders, and the anthem's title and audio file (anthem P85 → audio P51).
  - World Bank Indicators API (v2): population, density, birth, death and growth rates, net migration, male and female population, life expectancy, and population by age group and sex for the pyramid. Use the latest year available.
  - A local data file keyed by ISO alpha-3 code for everything else (religions, climate, geographical features, major cities and tourist spots with coordinates and one-line descriptions, colonization, independence, government policies, culture, sports, national symbols, population challenges, interesting facts). Fill it in completely for these starter countries: India, United States, Brazil, France, Nigeria, Australia. Make adding more countries easy. For countries without an entry, those sections show "Details coming soon" and the country map shows the capital plus the largest cities from Wikidata.
- Also bundle a small search index of every country and territory: common and official names, alternate names and abbreviations, ISO codes, and approximate center coordinates, so search and the map highlight work instantly, even for places the map doesn't draw.
- Show units and the year for every statistic (e.g., "Birth rate: 16.1 per 1,000 people (2023)") and format large numbers with separators.
- Never invent facts, numbers, or URLs. Show "Not available" or "Not applicable" where needed, and label unofficial national symbols as "unofficial".
- Write about history, religion, and politics in a neutral, factual tone.
- Load a country's data only when it's selected, and cache it so the side panel and country page share it. Show loading skeletons while waiting and a friendly error with a Retry button if a request fails. Map shapes with no matching data (e.g., some disputed territories) show their name and "Limited data available" instead of breaking.

## Quality
- Clean, modern, readable design that works on desktop, tablet, and phone.
- Accessible: fully keyboard-usable, visible focus states, labels on icon-only buttons, good color contrast.
- A small footer credits the data sources.

## Deliverables
- Complete, working code with no placeholders or TODOs for the features above, the file structure, and instructions for running it through a simple local web server (some features break when the HTML file is opened directly).
- A short table showing which source feeds each field, plus any assumptions and known limitations.

## Before finishing, check that
- "Indai" suggests India, and "USA", "UK", and "Ivory Coast" find the right countries.
- Searching "Vatican City" or "Tuvalu" flies to its location, shows the pulsing marker, and opens its panel.
- The hover pop-out looks subtle on both a large country (Russia) and a small one (Belgium), with no flicker along borders.
- Neighboring countries never share a color, labels never overlap, and France's label sits in France.
- Clicking France and Norway opens the correct data (a known gap in some map datasets).
- Selecting France zooms to mainland France on both maps, not out to French Guiana in South America.
- Switching countries while the panel is open updates smoothly and stops the anthem.
- Fullscreen, Close, and Esc work as described, and both views work on a 375 px-wide phone screen.
- "More details" opens the right country page; refreshing it or opening the link in a new tab still works, and Back returns to the map exactly as the user left it.
- Scrolling down the country page never gets stuck zooming the map.
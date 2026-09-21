import { startRouter, navigate } from './router.js';
import { getState, setState, subscribe } from './store.js';
import { createWorldMap } from '../components/world-map/WorldMap.js';
import { createSearchBar } from '../components/search/SearchBar.js';
import { createSidePanel } from '../components/side-panel/SidePanel.js';
import { createCountryPage } from '../components/country-page/CountryPage.js';
import { createAboutModal } from '../components/about/AboutModal.js';
import { getEntryByIso3 } from './searchIndex.js';

const mapView = document.getElementById('view-map');
const countryView = document.getElementById('view-country');
const countryPage = createCountryPage(document.getElementById('country-page-mount'));

let savedMapTransform = null;

const worldMap = createWorldMap(document.getElementById('world-map-mount'), {
  onSelect(iso3) {
    const isReselect = iso3 === getState().selectedIso3;
    setState({ selectedIso3: iso3, panelOpen: true, fullscreen: false });
    // Selecting the country that is already selected changes no state, so the subscription below stays
    // quiet: put its name back in the box (over whatever has been typed since) explicitly.
    if (isReselect) syncSearchBoxWithSelection(iso3, { force: true });
  },
});

const searchBar = createSearchBar(document.getElementById('search-mount'), {
  onSelect(iso3, entry) {
    worldMap.selectCountry(iso3, { coord: entry.coord, name: entry.names.common });
  },
});

// The search box always names the selected country, however it was selected (map click, search,
// deep link) — replacing whatever was there. When the selection is cleared (panel closed) the
// name is cleared with it, but only if it is still the text WE put there: a query the user has
// since started typing is theirs and is left alone.
let namedIso3 = null;
let writtenName = null;
async function syncSearchBoxWithSelection(iso3, { force = false } = {}) {
  if (iso3 === namedIso3 && !force) return;
  namedIso3 = iso3;
  if (!iso3) {
    if (writtenName !== null && searchBar.getValue() === writtenName) searchBar.setValue('');
    writtenName = null;
    return;
  }
  // The name in the box is a nicety: if the index cannot be read (the map itself reports that failure) the box just keeps its text.
  const entry = await getEntryByIso3(iso3).catch(() => null);
  if (getState().selectedIso3 !== iso3 || !entry) return; // the user moved on while the index resolved
  writtenName = entry.names.common;
  searchBar.setValue(writtenName);
}

createSidePanel(document.getElementById('side-panel-mount'));
createAboutModal(mapView);

// The only place map selection ever gets cleared from the *store* side — a direct
// map click/search selection already updates WorldMap's own visuals synchronously
// before this fires, so this only matters for closing the panel (Close button / Esc).
subscribe((state) => {
  syncSearchBoxWithSelection(state.selectedIso3);
  if (!state.selectedIso3) worldMap.clearSelection();
  // The floating search bar centers on the whole map area by default, which overlaps
  // the panel's header (and hides the country name) once the panel takes up its ~40%
  // on desktop — shift its centering to the remaining map width while open.
  mapView.classList.toggle('panel-open', state.panelOpen);
});

function showMapView() {
  countryPage.leave(); // a country page still loading must not finish under whatever is selected on the map
  mapView.hidden = false;
  countryView.hidden = true;
  const { selectedIso3 } = getState();
  if (savedMapTransform) {
    worldMap.restoreTransform(savedMapTransform, selectedIso3);
  } else if (selectedIso3) {
    worldMap.selectCountry(selectedIso3, { animate: false });
  }
  savedMapTransform = null;
}

function showCountryView(iso3) {
  if (!mapView.hidden) savedMapTransform = worldMap.getTransform();
  mapView.hidden = true;
  countryView.hidden = false;
  // Per spec: reaching a country page — via "More details", a direct link, or a
  // refresh — means that country is "selected with its panel open" for when the user
  // returns to the map view, even if they never interacted with the map at all.
  setState({ selectedIso3: iso3, panelOpen: true });
  countryPage.render(iso3);
}

startRouter({ onMapView: showMapView, onCountryView: showCountryView });

window.__worldMap = worldMap; // dev/E2E hook
window.__navigate = navigate; // dev/E2E hook

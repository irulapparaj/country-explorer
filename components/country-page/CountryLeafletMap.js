import { loadScript, loadStylesheet, createEl } from '../../lib/domUtils.js';

const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

function divIcon(L, className) {
  return L.divIcon({ className: `country-map-marker ${className}`, iconSize: [16, 16] });
}

/**
 * Mounts a Leaflet/OpenStreetMap map into `container` for the country page: capital,
 * major cities, and tourist spots as separate toggleable layers, zoomed to the
 * capital/center. Scroll-wheel zoom stays off until the user clicks the map, so the
 * map never hijacks page scrolling.
 * @param {HTMLElement} container
 * @param {{capital: {name:string, coord:{lat,lng}}|null, centerCoord: {lat,lng}|null, majorCities: Array, touristSpots: Array}} data
 */
export async function createCountryMap(container, data) {
  loadStylesheet(LEAFLET_CSS);
  await loadScript(LEAFLET_JS);
  const L = window.L;

  container.replaceChildren();
  const mapEl = createEl('div', { className: 'country-leaflet-map', attrs: { role: 'application', 'aria-label': 'Country map with capital, cities, and tourist spots' } });
  const legendEl = createEl('div', { className: 'country-map-legend' });
  container.append(mapEl, legendEl);

  const center = data.capital?.coord || data.centerCoord || { lat: 0, lng: 0 };
  const map = L.map(mapEl, { scrollWheelZoom: false }).setView([center.lat, center.lng], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);

  mapEl.addEventListener('click', () => map.scrollWheelZoom.enable(), { once: true });

  const groupDefs = [
    { key: 'capital', label: 'Capital', className: 'marker-capital', points: data.capital ? [data.capital] : [] },
    { key: 'cities', label: 'Major cities', className: 'marker-city', points: data.majorCities || [] },
    { key: 'tourist', label: 'Tourist spots', className: 'marker-tourist', points: data.touristSpots || [] },
  ];

  const legend = createEl('ul', { className: 'country-map-legend-list' });
  for (const def of groupDefs) {
    const points = def.points.filter((p) => p.coord);
    if (points.length === 0) continue;
    const layer = L.layerGroup();
    for (const p of points) {
      const marker = L.marker([p.coord.lat, p.coord.lng], { icon: divIcon(L, def.className) });
      const popupHtml = `<strong>${escapeHtml(p.name)}</strong>${p.description ? `<br>${escapeHtml(p.description)}` : ''}`;
      marker.bindPopup(popupHtml);
      layer.addLayer(marker);
    }
    layer.addTo(map);

    const item = createEl('li', { className: 'country-map-legend-item' });
    const checkbox = createEl('input', { attrs: { type: 'checkbox', checked: '', id: `legend-${def.key}` } });
    checkbox.addEventListener('change', () => (checkbox.checked ? layer.addTo(map) : map.removeLayer(layer)));
    const swatch = createEl('span', { className: `legend-swatch ${def.className}` });
    const labelEl = createEl('label', { attrs: { for: `legend-${def.key}` }, text: def.label });
    item.append(checkbox, swatch, labelEl);
    legend.appendChild(item);
  }
  legendEl.appendChild(legend);

  return { destroy: () => map.remove() };
}

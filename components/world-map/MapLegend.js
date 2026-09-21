import { createEl } from '../../lib/domUtils.js';

/**
 * The map key. Content comes from legendSpecs.js; this only renders it. Every value goes
 * through textContent / style properties, never innerHTML.
 * @param {HTMLElement} container
 */
export function createMapLegend(container) {
  const root = createEl('aside', { className: 'map-legend', attrs: { hidden: '' } });
  const statusEl = createEl('p', { className: 'map-legend-status', attrs: { role: 'status' } });
  container.appendChild(root);

  function renderItem(item) {
    const swatch = createEl('span', { className: `map-legend-swatch${item.swatchClass ? ` ${item.swatchClass}` : ''}` });
    if (item.color) swatch.style.backgroundColor = item.color;
    return createEl('li', { className: 'map-legend-item', children: [swatch, createEl('span', { text: item.label })] });
  }

  return {
    show(spec) {
      const children = [createEl('h2', { className: 'map-legend-title', text: spec.title })];
      for (const group of spec.groups) {
        const section = createEl('div', { className: 'map-legend-group' });
        if (group.heading) section.appendChild(createEl('h3', { className: 'map-legend-heading', text: group.heading }));
        const list = createEl('ul', { className: 'map-legend-list', attrs: { role: 'list' } });
        list.append(...group.items.map(renderItem));
        section.appendChild(list);
        children.push(section);
      }
      statusEl.textContent = '';
      children.push(statusEl);
      if (spec.note) children.push(createEl('p', { className: 'map-legend-note', text: spec.note }));
      root.replaceChildren(...children);
      root.setAttribute('aria-label', spec.ariaLabel);
      root.hidden = false;
    },
    hide() {
      root.hidden = true;
    },
    /** Loading / error text under the key (elevation tiles stream in after the key appears). */
    setStatus(text) {
      if (statusEl.textContent !== text) statusEl.textContent = text; // it is a live region: never re-announce the same text
    },
  };
}

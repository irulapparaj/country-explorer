import { loadSearchIndex } from '../../lib/searchIndex.js';
import { createEl } from '../../lib/domUtils.js';

const FUSE_OPTIONS = {
  includeScore: true,
  ignoreLocation: true,
  threshold: 0.4,
  keys: [
    { name: 'names.common', weight: 0.4 },
    { name: 'names.official', weight: 0.3 },
    { name: 'names.alt', weight: 0.3 },
    { name: 'iso2', weight: 0.2 },
    { name: 'iso3', weight: 0.2 },
  ],
};

// A result is "confident" below this score (Fuse: 0 = perfect match, 1 = no match at
// all) and shown directly in the dropdown; above it but still under the "hopeless"
// cutoff, it's offered as a "did you mean" suggestion instead.
const CONFIDENT_THRESHOLD = 0.35;
const HOPELESS_THRESHOLD = 0.6;

function normalize(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Mounts the floating search bar into `container`. Matches ignore case/accents and
 * cover common/official/alternate names and abbreviations (USA, UK, UAE, Ivory Coast,
 * Burma, Türkiye) via the bundled search index — not the map shapes, so it also
 * resolves countries/territories too small to be drawn.
 * @param {HTMLElement} container
 * @param {{onSelect: (iso3: string, entry: object) => void}} handlers
 */
export function createSearchBar(container, { onSelect }) {
  let fuse = null;
  let entries = [];
  let activeIndex = -1;
  let currentResults = [];
  let mode = 'idle'; // idle | results | suggestion | none

  const wrap = createEl('div', { className: 'search-bar' });
  const inputWrap = createEl('div', { className: 'search-input-wrap' });
  const input = createEl('input', {
    className: 'search-input',
    attrs: {
      type: 'text',
      placeholder: 'Search for a country or territory…',
      'aria-label': 'Search for a country or territory',
      'aria-expanded': 'false',
      'aria-controls': 'search-listbox',
      role: 'combobox',
      autocomplete: 'off',
    },
  });
  const clearBtn = createEl('button', {
    className: 'search-clear',
    attrs: { type: 'button', 'aria-label': 'Clear search', hidden: '' },
    text: '×',
  });
  const listbox = createEl('ul', { className: 'search-listbox', attrs: { id: 'search-listbox', role: 'listbox', hidden: '' } });
  const message = createEl('p', { className: 'search-message', attrs: { role: 'status' } });

  inputWrap.append(input, clearBtn);
  wrap.append(inputWrap, listbox, message);
  container.appendChild(wrap);

  loadSearchIndex().then((loaded) => {
    entries = loaded;
    fuse = new window.Fuse(entries, FUSE_OPTIONS);
    // A user who typed before the index finished loading otherwise gets stuck with an
    // empty dropdown forever — handleInput no-ops on a null fuse and nothing re-fires
    // it once the index arrives, since fill() only dispatches one 'input' event.
    if (input.value) handleInput();
  });

  // The dropdown's DOM and the combobox's ARIA state (aria-expanded, aria-activedescendant)
  // must always agree, so every path that hides or empties the list goes through here.
  function collapseListbox() {
    listbox.replaceChildren();
    listbox.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function closeResults() {
    mode = 'idle';
    activeIndex = -1;
    currentResults = [];
    collapseListbox();
    message.replaceChildren();
  }

  function renderResults(results) {
    listbox.replaceChildren();
    listbox.hidden = results.length === 0;
    input.setAttribute('aria-expanded', String(results.length > 0));
    results.forEach((entry, i) => {
      const li = createEl('li', {
        className: 'search-option',
        attrs: { role: 'option', id: `search-option-${i}`, 'aria-selected': String(i === activeIndex) },
        text: entry.names.common,
      });
      li.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        commitSelection(entry);
      });
      listbox.appendChild(li);
    });
  }

  function renderSuggestion(query, entry) {
    collapseListbox();
    message.replaceChildren();
    const text = createEl('span', { text: `No country named ‘${query}’. Did you mean ` });
    const btn = createEl('button', { className: 'search-suggestion-btn', attrs: { type: 'button' }, text: entry.names.common });
    btn.addEventListener('click', () => commitSelection(entry));
    message.append(text, btn, document.createTextNode('?'));
  }

  function renderNoMatch(query) {
    collapseListbox();
    message.textContent = `No matching country found for ‘${query}’.`;
  }

  function commitSelection(entry) {
    input.value = entry.names.common;
    closeResults();
    onSelect(entry.iso3, entry);
  }

  function handleInput() {
    const raw = input.value;
    clearBtn.hidden = raw.length === 0;
    activeIndex = -1;
    input.removeAttribute('aria-activedescendant'); // the highlighted option is gone with the index
    const query = normalize(raw);
    if (!query) {
      closeResults();
      return;
    }
    if (!fuse) return; // index still loading; the user can just keep typing

    const results = fuse.search(raw).slice(0, 8);
    const best = results[0];

    if (best && best.score <= CONFIDENT_THRESHOLD) {
      mode = 'results';
      currentResults = results.map((r) => r.item);
      renderResults(currentResults);
      message.replaceChildren();
    } else if (best && best.score <= HOPELESS_THRESHOLD) {
      mode = 'suggestion';
      currentResults = [];
      renderSuggestion(raw, best.item);
    } else {
      mode = 'none';
      currentResults = [];
      renderNoMatch(raw);
    }
  }

  function moveActive(delta) {
    if (mode !== 'results' || currentResults.length === 0) return;
    activeIndex = (activeIndex + delta + currentResults.length) % currentResults.length;
    renderResults(currentResults);
    input.setAttribute('aria-activedescendant', `search-option-${activeIndex}`);
  }

  input.addEventListener('input', handleInput);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Enter') {
      if (mode === 'results' && activeIndex >= 0) {
        commitSelection(currentResults[activeIndex]);
      } else if (mode === 'results' && currentResults.length > 0) {
        commitSelection(currentResults[0]);
      }
    } else if (event.key === 'Escape') {
      closeResults();
      input.blur();
    }
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.hidden = true;
    closeResults();
    input.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!wrap.contains(event.target)) closeResults();
  });

  return {
    /** Writes `text` into the box (replacing whatever is there) and closes any open dropdown —
     *  used when a country is selected somewhere other than the search box, e.g. a map click. */
    setValue: (text) => {
      input.value = text;
      clearBtn.hidden = text.length === 0;
      closeResults();
    },
    getValue: () => input.value,
    focus: () => input.focus(),
    clear: () => {
      input.value = '';
      clearBtn.hidden = true;
      closeResults();
    },
  };
}

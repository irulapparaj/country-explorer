import { createEl } from '../../lib/domUtils.js';
import { MAP_MODES, LABEL_MODES } from './mapModes.js';

let controlsCounter = 0;

/**
 * The compact "Map options" card: map style, which names to show, and the two overlay
 * toggles. Built from native radios/checkboxes so keyboard use (arrow keys within a
 * group, Space to toggle), focus and screen-reader semantics come from the platform.
 * @param {HTMLElement} container
 * @param {{options: object, onChange: (patch: object) => void}} config
 */
export function createMapControls(container, { options, onChange }) {
  const uid = `map-options-${++controlsCounter}`;
  const card = createEl('section', { className: 'map-options', attrs: { 'aria-label': 'Map options' } });

  const startCollapsed = window.matchMedia('(max-width: 768px)').matches;
  const toggle = createEl('button', {
    className: 'map-options-toggle',
    attrs: { type: 'button', 'aria-expanded': String(!startCollapsed), 'aria-controls': `${uid}-body` },
    children: [createEl('span', { text: 'Map options' }), createEl('span', { className: 'map-options-chevron', attrs: { 'aria-hidden': 'true' }, text: '▾' })],
  });
  const body = createEl('div', { className: 'map-options-body', attrs: { id: `${uid}-body` } });
  body.hidden = startCollapsed;
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    body.hidden = expanded;
  });

  const radios = new Map(); // `${key}:${value}` -> input

  // Shows `short` when given, and keeps the rest of the full label visually hidden so the
  // accessible name is still the full text.
  function choiceText({ label, short }) {
    if (!short || !label.startsWith(short)) return createEl('span', { text: label });
    return createEl('span', { children: [document.createTextNode(short), createEl('span', { className: 'visually-hidden', text: label.slice(short.length) })] });
  }

  function radioGroup(key, label, choices, className) {
    const labelId = `${uid}-${key}-label`;
    const group = createEl('div', { className: 'map-option-group' });
    group.appendChild(createEl('span', { className: 'map-option-label', attrs: { id: labelId }, text: label }));
    const wrap = createEl('div', { className: `seg ${className}`, attrs: { role: 'radiogroup', 'aria-labelledby': labelId } });
    for (const choice of choices) {
      const input = createEl('input', { attrs: { type: 'radio', name: `${uid}-${key}`, value: choice.id } });
      input.checked = options[key] === choice.id;
      input.addEventListener('change', () => input.checked && onChange({ [key]: choice.id }));
      radios.set(`${key}:${choice.id}`, input);
      wrap.appendChild(createEl('label', { className: 'seg-option', children: [input, choiceText(choice)] }));
    }
    group.appendChild(wrap);
    return group;
  }

  const checks = new Map();
  // `name` is the full accessible name; `text` is the shorter visible label (it is always a
  // part of the name, so speech-control users can say what they see).
  function checkbox(key, name, text, title) {
    const input = createEl('input', { attrs: { type: 'checkbox', 'aria-label': name } });
    input.checked = options[key];
    input.addEventListener('change', () => onChange({ [key]: input.checked }));
    checks.set(key, input);
    return createEl('label', { className: 'map-check', attrs: { title }, children: [input, createEl('span', { text })] });
  }

  const toggles = createEl('div', { className: 'map-option-group map-option-checks' });
  toggles.append(
    checkbox('showGrid', 'Grid and coordinates', 'Grid', 'Latitude and longitude lines, the equator, the tropics and the polar circles'),
    checkbox('showWaterNames', 'Ocean and sea names', 'Ocean and sea names', 'Names of the oceans, and of the seas as you zoom in')
  );

  body.append(
    radioGroup('mapMode', 'Map style', MAP_MODES, 'seg-row'),
    radioGroup('labelMode', 'Names', LABEL_MODES, 'seg-row'),
    toggles
  );
  card.append(toggle, body);
  container.appendChild(card);

  return {
    /** Reflects options changed from code (not from these inputs) back onto the controls. */
    sync(next) {
      for (const [id, input] of radios) {
        const [key, value] = id.split(':');
        input.checked = next[key] === value;
      }
      for (const [key, input] of checks) input.checked = next[key];
    },
  };
}

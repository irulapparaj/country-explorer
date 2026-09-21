import { createEl } from '../../lib/domUtils.js';

/**
 * @param {string} message
 * @param {() => void} onRetry
 */
export function createErrorRetry(message, onRetry) {
  const wrap = createEl('div', { className: 'error-retry', attrs: { role: 'alert' } });
  const text = createEl('p', { className: 'error-retry-message', text: message });
  const btn = createEl('button', { className: 'error-retry-btn', attrs: { type: 'button' }, text: 'Try again' });
  // Once asked, the button is spent: a second click while the retry is under way would start it twice (two maps
  // built into one place, the first leaked).
  btn.addEventListener('click', () => {
    btn.disabled = true;
    onRetry();
  });
  wrap.append(text, btn);
  return wrap;
}

/**
 * A message with nothing to retry: what was asked for does not exist (a typed-in country code that is not one).
 * @param {string} message
 */
export function createNotFound(message) {
  return createEl('div', { className: 'error-retry', attrs: { role: 'alert' }, children: [createEl('p', { className: 'error-retry-message', text: message })] });
}

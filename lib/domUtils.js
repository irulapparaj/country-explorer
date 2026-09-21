export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function announce(message) {
  const region = document.getElementById('live-region');
  if (!region) return;
  region.textContent = '';
  window.requestAnimationFrame(() => {
    region.textContent = message;
  });
}

export { clamp } from './mathUtils.js';

// Builds a DOM node from plain data only — every dynamic value goes through
// textContent, never innerHTML, so API/user text can never be interpreted as markup.
export function createEl(tag, { className, attrs, text, children } = {}) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value != null) el.setAttribute(key, value);
    }
  }
  if (text != null) el.textContent = text;
  if (children) {
    for (const child of children) {
      if (child) el.appendChild(child);
    }
  }
  return el;
}

const loadedScripts = new Map();
const SCRIPT_TIMEOUT_MS = 20_000; // a stalled CDN answers neither load nor error: without this the wait never ends

export function loadScript(src, { timeoutMs = SCRIPT_TIMEOUT_MS } = {}) {
  if (loadedScripts.has(src)) return loadedScripts.get(src);
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const fail = (reason) => {
      clearTimeout(timer);
      script.remove(); // the next attempt adds a fresh tag rather than leaving a dead one behind
      reject(new Error(`${reason}: ${src}`));
    };
    const timer = setTimeout(() => fail('Timed out loading script'), timeoutMs);
    script.src = src;
    script.defer = true;
    script.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    script.onerror = () => fail('Failed to load script');
    document.head.appendChild(script);
  });
  loadedScripts.set(src, promise);
  // A failed load is not remembered: one CDN hiccup must not disable the map or the chart until a reload.
  promise.catch(() => { if (loadedScripts.get(src) === promise) loadedScripts.delete(src); });
  return promise;
}

/**
 * Forgets that a script was loaded, so the next loadScript(src) fetches and runs it again — for a script that
 * loaded but was not the library it should have been (a CDN error page served as script).
 */
export function forgetScript(src) {
  loadedScripts.delete(src);
  for (const el of [...document.scripts]) if (el.src === src) el.remove();
}

const loadedStyles = new Set();

export function loadStylesheet(href) {
  if (loadedStyles.has(href)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  // A stylesheet that failed is not remembered as loaded: the next attempt (the map's Try again) adds a new link,
  // rather than building the map unstyled for good — a CDN outage usually takes the CSS and the script together.
  link.onerror = () => {
    link.remove();
    loadedStyles.delete(href);
  };
  document.head.appendChild(link);
  loadedStyles.add(href);
}

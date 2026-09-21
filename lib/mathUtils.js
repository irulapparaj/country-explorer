// Pure numeric helpers with no DOM dependency, so they can be imported by modules that
// are unit-tested in plain Node (lib/domUtils.js touches `window` and cannot be).
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Single source of truth for "which country is hovered". The previous implementation kept
// hover state as a CSS class on each country's own <path>, removed only by that path's own
// pointerleave — and re-parented the path on hover to raise it above its neighbors. A
// re-parented node swallows its pointerleave, so the class (and the pop-out it drove)
// stuck. With one tracked value, at most one country can ever be highlighted, a stale
// leave for a country that is no longer current is a no-op, and clear() is always safe.

/** @returns {{enter: (key: string) => {changed: boolean, previous: string|null}, leave: (key: string) => boolean, clear: () => boolean, readonly current: string|null}} */
export function createHoverTracker() {
  let current = null;
  return {
    enter(key) {
      const previous = current;
      current = key;
      return { changed: key !== previous, previous };
    },
    leave(key) {
      if (current !== key) return false;
      current = null;
      return true;
    },
    clear() {
      const hadHover = current !== null;
      current = null;
      return hadHover;
    },
    get current() {
      return current;
    },
  };
}

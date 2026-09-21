let state = Object.freeze({
  selectedIso3: null,
  panelOpen: false,
  fullscreen: false,
  mapTransform: null,
  offMapMarker: null,
});

const listeners = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  state = Object.freeze({ ...state, ...patch });
  for (const listener of listeners) listener(state);
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

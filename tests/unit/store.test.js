import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getState, setState, subscribe } from '../../lib/store.js';

test('setState merges a patch into the existing state', () => {
  setState({ selectedIso3: null, panelOpen: false });
  setState({ selectedIso3: 'IND' });
  const state = getState();
  assert.equal(state.selectedIso3, 'IND');
  assert.equal(state.panelOpen, false); // untouched fields survive the patch
});

test('setState never mutates a previously-returned snapshot', () => {
  setState({ selectedIso3: 'FRA' });
  const before = getState();
  setState({ selectedIso3: 'BRA' });
  assert.equal(before.selectedIso3, 'FRA'); // the old reference is frozen, not changed in place
  assert.equal(getState().selectedIso3, 'BRA');
});

test('state snapshots are frozen', () => {
  const state = getState();
  assert.throws(() => {
    state.selectedIso3 = 'NOPE';
  });
});

test('subscribe notifies listeners with the new state on every change', () => {
  const seen = [];
  const unsubscribe = subscribe((state) => seen.push(state.selectedIso3));
  setState({ selectedIso3: 'NGA' });
  setState({ selectedIso3: 'AUS' });
  unsubscribe();
  setState({ selectedIso3: 'USA' });
  assert.deepEqual(seen, ['NGA', 'AUS']); // nothing recorded after unsubscribe
});

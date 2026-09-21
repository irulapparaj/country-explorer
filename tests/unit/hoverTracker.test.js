import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHoverTracker } from '../../components/world-map/hoverTracker.js';

// Regression for "some countries stay highlighted and never revert": the old code kept
// hover state in a per-element CSS class that was only removed by that element's own
// pointerleave. Re-parenting the element while hovered (to raise it above neighbors)
// swallowed the leave event, so the class stuck. The tracker makes "which country is
// hovered" a single value, so at most one can ever be highlighted.

test('starts with nothing hovered', () => {
  assert.equal(createHoverTracker().current, null);
});

test('entering a country makes it the only hovered one and reports a change', () => {
  const tracker = createHoverTracker();
  assert.deepEqual(tracker.enter('FRA'), { changed: true, previous: null });
  assert.equal(tracker.current, 'FRA');
});

test('entering B while A is still hovered replaces A (a missed leave can never strand A)', () => {
  const tracker = createHoverTracker();
  tracker.enter('USA');
  assert.deepEqual(tracker.enter('CAN'), { changed: true, previous: 'USA' });
  assert.equal(tracker.current, 'CAN');
});

test('re-entering the already-hovered country is not a change (no redundant redraw)', () => {
  const tracker = createHoverTracker();
  tracker.enter('RUS');
  assert.deepEqual(tracker.enter('RUS'), { changed: false, previous: 'RUS' });
});

test('leaving the hovered country clears it', () => {
  const tracker = createHoverTracker();
  tracker.enter('BRA');
  assert.equal(tracker.leave('BRA'), true);
  assert.equal(tracker.current, null);
});

test('a late leave for a country that is no longer hovered is ignored', () => {
  const tracker = createHoverTracker();
  tracker.enter('USA');
  tracker.enter('CAN');
  assert.equal(tracker.leave('USA'), false); // stale event from the previous country
  assert.equal(tracker.current, 'CAN');
});

test('clear() always resets, and reports whether anything was hovered', () => {
  const tracker = createHoverTracker();
  assert.equal(tracker.clear(), false);
  tracker.enter('IND');
  assert.equal(tracker.clear(), true);
  assert.equal(tracker.current, null);
});

test('a sweep across many countries never leaves more than one hovered', () => {
  const tracker = createHoverTracker();
  const ids = ['USA', 'CAN', 'MEX', 'BRA', 'ARG', 'CHL', 'PER', 'COL'];
  for (let pass = 0; pass < 5; pass++) for (const id of ids) tracker.enter(id); // no leaves at all
  assert.equal(tracker.current, 'COL');
  tracker.clear();
  assert.equal(tracker.current, null);
});

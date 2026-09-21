import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WATER_LABELS, waterLabelsForZoom, labelLines } from '../../components/world-map/oceanLabels.js';

test('every ocean is named, including the polar ones', () => {
  const oceans = WATER_LABELS.filter((l) => l.kind === 'ocean').map((l) => l.name);
  for (const expected of ['North Pacific Ocean', 'South Pacific Ocean', 'North Atlantic Ocean', 'South Atlantic Ocean', 'Indian Ocean', 'Southern Ocean', 'Arctic Ocean']) {
    assert.ok(oceans.includes(expected), `missing ${expected}`);
  }
});

test('ocean labels are visible from the whole-world view; seas only appear once zoomed in', () => {
  for (const l of WATER_LABELS) {
    if (l.kind === 'ocean') assert.equal(l.minZoom, 1, l.name);
    else assert.ok(l.minZoom > 1, `${l.name} should be revealed by zoom`);
  }
  assert.equal(waterLabelsForZoom(1).every((l) => l.kind === 'ocean'), true);
  assert.ok(waterLabelsForZoom(3).some((l) => l.name === 'Mediterranean Sea'));
});

test('ids and names are unique and every anchor is a real lon/lat', () => {
  assert.equal(new Set(WATER_LABELS.map((l) => l.id)).size, WATER_LABELS.length);
  assert.equal(new Set(WATER_LABELS.map((l) => l.name)).size, WATER_LABELS.length);
  for (const { lng, lat } of WATER_LABELS) {
    assert.ok(lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90);
  }
});

test('the hemisphere words agree with the anchors (North Pacific is north of the equator, etc.)', () => {
  // Oceans only: "South China Sea" is a proper name, not a hemisphere.
  for (const l of WATER_LABELS.filter((label) => label.kind === 'ocean')) {
    if (l.name.startsWith('North ')) assert.ok(l.lat > 0, l.name);
    if (l.name.startsWith('South ')) assert.ok(l.lat < 0, l.name);
  }
  const southern = WATER_LABELS.find((l) => l.name === 'Southern Ocean');
  const arctic = WATER_LABELS.find((l) => l.name === 'Arctic Ocean');
  assert.ok(southern.lat < -55);
  assert.ok(arctic.lat > 70);
});

test('ocean names are set on two lines, seas on one, and the words always add back up to the name', () => {
  const lines = (name) => labelLines(WATER_LABELS.find((l) => l.name === name));
  assert.deepEqual(lines('North Pacific Ocean'), ['North Pacific', 'Ocean']);
  assert.deepEqual(lines('Indian Ocean'), ['Indian', 'Ocean']);
  assert.deepEqual(lines('Mediterranean Sea'), ['Mediterranean Sea']);
  for (const label of WATER_LABELS) assert.equal(labelLines(label).join(' '), label.name);
});

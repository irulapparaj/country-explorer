import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPECIAL_LINES,
  TROPIC_LATITUDE,
  POLAR_CIRCLE_LATITUDE,
  graticuleStepForZoom,
  parallelsForStep,
  meridiansForStep,
  formatLatitude,
  formatLongitude,
  specialLineLabel,
  thinTicks,
} from '../../components/world-map/graticule.js';

test('the tropics and polar circles are the standard textbook latitudes', () => {
  assert.equal(TROPIC_LATITUDE, 23.44);
  assert.equal(POLAR_CIRCLE_LATITUDE, 66.56); // 90 - 23.44
  assert.equal(+(90 - TROPIC_LATITUDE).toFixed(2), POLAR_CIRCLE_LATITUDE);
});

test('SPECIAL_LINES lists the equator, both tropics and both polar circles, north to south', () => {
  assert.deepEqual(
    SPECIAL_LINES.map((l) => [l.id, l.name, l.lat]),
    [
      ['arctic-circle', 'Arctic Circle', 66.56],
      ['cancer', 'Tropic of Cancer', 23.44],
      ['equator', 'Equator', 0],
      ['capricorn', 'Tropic of Capricorn', -23.44],
      ['antarctic-circle', 'Antarctic Circle', -66.56],
    ]
  );
});

test('special-line labels carry the name and the latitude with hemisphere', () => {
  const byId = Object.fromEntries(SPECIAL_LINES.map((l) => [l.id, specialLineLabel(l)]));
  assert.equal(byId.equator, 'Equator · 0°');
  assert.equal(byId.cancer, 'Tropic of Cancer · 23.44°N');
  assert.equal(byId.capricorn, 'Tropic of Capricorn · 23.44°S');
  assert.equal(byId['arctic-circle'], 'Arctic Circle · 66.56°N');
  assert.equal(byId['antarctic-circle'], 'Antarctic Circle · 66.56°S');
});

test('grid spacing gets finer as you zoom in, and never gets coarser', () => {
  const steps = [1, 1.9, 2, 3.9, 4, 7.9, 8, 12].map(graticuleStepForZoom);
  assert.deepEqual(steps, [30, 30, 15, 15, 10, 10, 5, 5]);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i] <= steps[i - 1]);
});

test('parallels are symmetric about the equator, include it, and stop short of the poles', () => {
  for (const step of [30, 15, 10, 5]) {
    const lats = parallelsForStep(step);
    assert.ok(lats.includes(0), `step ${step} includes the equator`);
    assert.ok(lats.every((l) => Math.abs(l) < 90), `step ${step} excludes the poles`);
    assert.ok(lats.every((l) => l % step === 0));
    assert.deepEqual([...lats].sort((a, b) => a - b), lats, 'ascending');
    assert.deepEqual(lats.map((l) => 0 - l).sort((a, b) => a - b), lats, 'symmetric');
  }
  assert.deepEqual(parallelsForStep(30), [-60, -30, 0, 30, 60]);
});

test('meridians span the whole globe, -180 to 180, on the step', () => {
  const lngs = meridiansForStep(30);
  assert.equal(lngs[0], -180);
  assert.equal(lngs.at(-1), 180);
  assert.equal(lngs.length, 13);
  assert.ok(lngs.includes(0));
});

test('latitude labels use N/S, the equator is a bare 0°', () => {
  assert.equal(formatLatitude(30), '30°N');
  assert.equal(formatLatitude(-60), '60°S');
  assert.equal(formatLatitude(0), '0°');
  assert.equal(formatLatitude(23.44), '23.44°N');
});

test('longitude labels use E/W, the prime meridian and antimeridian are bare degrees', () => {
  assert.equal(formatLongitude(90), '90°E');
  assert.equal(formatLongitude(-120), '120°W');
  assert.equal(formatLongitude(0), '0°');
  assert.equal(formatLongitude(180), '180°');
  assert.equal(formatLongitude(-180), '180°');
});

test('thinTicks keeps the first of any pair closer than the minimum gap', () => {
  const ticks = [{ pos: 0 }, { pos: 10 }, { pos: 45 }, { pos: 50 }, { pos: 120 }];
  assert.deepEqual(thinTicks(ticks, 30).map((t) => t.pos), [0, 45, 120]);
  assert.deepEqual(thinTicks([], 30), []);
});

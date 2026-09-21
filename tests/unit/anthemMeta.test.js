import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnavailable, sourcesDiffer } from '../../components/anthem-player/anthemMeta.js';

const brazil = { title: 'Brazilian National Anthem', oggUrl: 'https://x/a.ogg', mp3Url: 'https://x/a.mp3', license: null };

test('an anthem is unavailable when there is no meta, or no audio URL at all', () => {
  assert.equal(isUnavailable(null), true);
  assert.equal(isUnavailable(undefined), true);
  assert.equal(isUnavailable({ title: 'X', oggUrl: null, mp3Url: null }), true);
  assert.equal(isUnavailable({ title: 'X', oggUrl: 'https://x/a.ogg', mp3Url: null }), false);
  assert.equal(isUnavailable({ title: 'X', oggUrl: null, mp3Url: 'https://x/a.mp3' }), false);
});

// The reported recovery bug: the first load of a country had no anthem (a request failed); after "Try
// again" the real one arrived for the SAME country, and the player ignored it (a same-country reload is
// normally a no-op so playback survives moving between the panel and the page).
test('sources differ when a recording appears where there was none (the "Try again" case)', () => {
  assert.equal(sourcesDiffer(null, brazil), true);
  assert.equal(sourcesDiffer({ title: 'X', oggUrl: null, mp3Url: null }, brazil), true);
});

test('sources differ when either URL changes (e.g. the mp3 arrives after the ogg-only fallback)', () => {
  assert.equal(sourcesDiffer({ ...brazil, mp3Url: null }, brazil), true);
  assert.equal(sourcesDiffer(brazil, { ...brazil, oggUrl: 'https://x/other.ogg' }), true);
});

test('identical sources do not differ, so playback is left alone when moving between panel and page', () => {
  assert.equal(sourcesDiffer(brazil, { ...brazil, license: { shortName: 'CC0', credit: null } }), false);
  assert.equal(sourcesDiffer(null, null), false);
});

test('a later load with no meta never counts as a change (it must not wipe a working recording)', () => {
  assert.equal(sourcesDiffer(brazil, null), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFailedSources, describeLoadOutcome } from '../../components/shared/PartialDataNotice.js';

test('failed sources are named in words, once each', () => {
  assert.equal(describeFailedSources(['wikidata']), 'Wikidata');
  assert.equal(describeFailedSources(['worldbank']), 'the World Bank');
  assert.equal(describeFailedSources(['wikipedia']), 'Wikipedia');
  assert.equal(describeFailedSources(['wikidata', 'wikidata']), 'Wikidata');
  assert.equal(describeFailedSources(['wikidata', 'worldbank']), 'Wikidata and the World Bank');
  assert.equal(describeFailedSources(['wikidata', 'worldbank', 'wikipedia']), 'Wikidata, the World Bank and Wikipedia');
});

test('an unknown or missing source still reads sensibly', () => {
  assert.equal(describeFailedSources([]), 'a data source');
  assert.equal(describeFailedSources(['osm']), 'osm');
});

// Found by review: a status node inserted together with its text is not reliably announced, and the only
// announcement was "Brazil selected" — so a screen-reader user never heard that details had failed to load,
// nor that Try again had worked (or had not).
test('the announcement says what happened: loaded, partly loaded, recovered, or still failing', () => {
  assert.equal(describeLoadOutcome('Brazil', []), 'Brazil selected');
  assert.equal(describeLoadOutcome('Brazil', ['wikidata']), 'Brazil selected. Some details could not be loaded from Wikidata. Use the Try again button to fetch them.');
  assert.equal(describeLoadOutcome('Brazil', [], { retried: true }), 'Brazil: all details loaded.');
  assert.equal(describeLoadOutcome('Brazil', ['worldbank', 'wikidata'], { retried: true }), 'Brazil: some details still could not be loaded from the World Bank and Wikidata.');
});

test('the announcement works without a failure list and for the page wording', () => {
  assert.equal(describeLoadOutcome('Brazil', undefined), 'Brazil selected');
  assert.equal(describeLoadOutcome('Brazil', [], { lead: 'country page loaded' }), 'Brazil country page loaded');
  assert.equal(describeLoadOutcome('Brazil', ['wikipedia'], { lead: 'country page loaded' }), 'Brazil country page loaded. Some details could not be loaded from Wikipedia. Use the Try again button to fetch them.');
});

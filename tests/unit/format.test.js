import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatNumber, formatStat, formatArea, formatDate, formatList, orNotAvailable, formatCountryTitle } from '../../lib/format.js';

test('formatNumber adds thousands separators', () => {
  assert.equal(formatNumber(1234567), '1,234,567');
  assert.equal(formatNumber(0), '0');
});

test('formatNumber returns null for missing values', () => {
  assert.equal(formatNumber(null), null);
  assert.equal(formatNumber(undefined), null);
});

test('formatStat shows "Not available" for null values', () => {
  assert.equal(formatStat(null, 'per 1,000 people', 2023), 'Not available');
});

test('formatStat combines value, unit, and year', () => {
  assert.equal(formatStat(16.1, 'per 1,000 people', 2023), '16.1 per 1,000 people (2023)');
});

test('formatStat formats numeric values with separators', () => {
  assert.equal(formatStat(1400000000, 'people', 2024), '1,400,000,000 people (2024)');
});

test('formatStat omits the year parenthetical when no year is given', () => {
  assert.equal(formatStat(5, '%'), '5 %');
});

test('formatArea converts km2 to mi2 and formats both', () => {
  const { km2, mi2 } = formatArea(3287263);
  assert.equal(km2, '3,287,263 km²');
  assert.equal(mi2, '1,269,219 mi²');
});

test('formatArea shows "Not available" for both fields when null', () => {
  const { km2, mi2 } = formatArea(null);
  assert.equal(km2, 'Not available');
  assert.equal(mi2, 'Not available');
});

test('formatDate renders a real ISO date and falls back for missing/invalid ones', () => {
  assert.equal(formatDate('1947-08-15T00:00:00Z'), 'August 15, 1947');
  assert.equal(formatDate(null), 'Not available');
  assert.equal(formatDate('not-a-date'), 'Not available');
});

test('formatList truncates with a remainder count', () => {
  assert.equal(formatList(['a', 'b', 'c', 'd'], { max: 2 }), 'a, b, and 2 more');
});

test('formatList returns the empty-text fallback for an empty/missing list', () => {
  assert.equal(formatList([]), 'Not available');
  assert.equal(formatList(null, { emptyText: 'Details coming soon' }), 'Details coming soon');
});

test('orNotAvailable passes through real values and replaces empty ones', () => {
  assert.equal(orNotAvailable('Paris'), 'Paris');
  assert.equal(orNotAvailable(''), 'Not available');
  assert.equal(orNotAvailable(null), 'Not available');
  assert.equal(orNotAvailable(0), 0);
});

// "India (IND)": the country's name followed by its three-letter code. Needed because the header
// used to fall back to the bare code ("BRA") whenever data had not loaded.
test('formatCountryTitle puts the ISO code in parentheses after the name', () => {
  assert.equal(formatCountryTitle('India', 'IND'), 'India (IND)');
  assert.equal(formatCountryTitle('United States', 'USA'), 'United States (USA)');
});

test('formatCountryTitle never duplicates the code when the name is already just the code', () => {
  assert.equal(formatCountryTitle('BRA', 'BRA'), 'BRA');
  assert.equal(formatCountryTitle(null, 'BRA'), 'BRA');
  assert.equal(formatCountryTitle('', 'BRA'), 'BRA');
});

test('formatCountryTitle upper-cases the code and tolerates a missing one', () => {
  assert.equal(formatCountryTitle('France', 'fra'), 'France (FRA)');
  assert.equal(formatCountryTitle('France', null), 'France');
});

// ---- formatDate: precision-aware and independent of the machine's time zone -----------------------------
// Found by review: the formatter used the LOCAL time zone, so a UTC-midnight date read a day early anywhere
// west of Greenwich (Brazil's 1822-09-07 showed as "September 6" in New York), and a year-only inception
// read as "January 1".

test('formatDate shows a bare year for year-precision dates, never an invented month and day', () => {
  assert.equal(formatDate('1947'), '1947');
  assert.equal(formatDate('0843'), '843');
});

test('formatDate shows month and year for month-precision dates', () => {
  assert.equal(formatDate('1500-05'), 'May 1500');
});

test('formatDate reads a full ISO date in UTC, so the day is the same in every time zone', () => {
  assert.equal(formatDate('1822-09-07T00:00:00Z'), 'September 7, 1822');
  assert.equal(formatDate('1947-08-15'), 'August 15, 1947');
  assert.equal(formatDate('2024-01-01T00:00:00Z'), 'January 1, 2024', 'a New Year midnight must not roll back into the previous year');
});

test('formatDate still refuses what it cannot read', () => {
  assert.equal(formatDate(null), 'Not available');
  assert.equal(formatDate('not a date'), 'Not available');
  assert.equal(formatDate('-0500-01-01T00:00:00Z'), 'Not available');
});

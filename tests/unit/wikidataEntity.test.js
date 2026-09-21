import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KM2_UNIT,
  currentStatements,
  currentEntityIds,
  bestEntityId,
  bestStatement,
  areaKm2,
  latestQuantity,
  timeValue,
  commonsFile,
  qualifierCommonsFile,
  englishText,
  coordinate,
  labelOf,
  utcOffsetMinutes,
  sortTimeZones,
} from '../../lib/wikidataEntity.js';

// ---- fixture builders mirroring the real Wikidata JSON shape (wbgetentities / wbgetclaims) ----
const snak = (type, value) => ({ snaktype: 'value', datavalue: { type, value } });
const item = (id, rank = 'normal') => ({ mainsnak: snak('wikibase-entityid', { 'entity-type': 'item', id }), rank });
const ended = (statement, time = '+1960-04-21T00:00:00Z') => ({ ...statement, qualifiers: { ...statement.qualifiers, P582: [snak('time', { time })] } });
const at = (statement, time) => ({ ...statement, qualifiers: { ...statement.qualifiers, P585: [snak('time', { time })] } });
const quantity = (amount, unit = KM2_UNIT, rank = 'normal') => ({ mainsnak: snak('quantity', { amount, unit }), rank });
const entityWith = (claims) => ({ claims });

// ---- current statements -------------------------------------------------------------------------

// Brazil's item really lists two capitals: Rio de Janeiro (ended 1960) and Brasília.
test('a historical statement (with an end time) is not "current": Brazil has one capital, Brasília', () => {
  const brazil = entityWith({ P36: [ended(item('Q8678')), item('Q2844')] });
  assert.deepEqual(currentEntityIds(brazil, 'P36'), ['Q2844']);
});

test('nine currencies listed, only the one in use counts', () => {
  const claims = { P38: ['Q831578', 'Q10261896', 'Q1764812', 'Q926028', 'Q44904', 'Q8351983', 'Q10366257', 'Q10261894'].map((id) => ended(item(id), '+1994-06-30T00:00:00Z')) };
  claims.P38.unshift(item('Q173117')); // the real (Brazilian real)
  assert.deepEqual(currentEntityIds(entityWith(claims), 'P38'), ['Q173117']);
});

// Russia's item has two anthem statements: the current one is RANK PREFERRED; the other (Patriotic
// Song, 1990-2000) is normal with an end time. Nothing ended may sneak in.
test('the ended anthem is dropped and the current (preferred) one stays', () => {
  const russia = entityWith({ P85: [item('Q1225991', 'preferred'), ended(item('Q2058180'), '+2000-12-31T00:00:00Z')] });
  assert.deepEqual(currentEntityIds(russia, 'P85'), ['Q1225991']);
});

test('deprecated statements and "no value"/"unknown value" snaks are ignored', () => {
  const noValue = { mainsnak: { snaktype: 'novalue' }, rank: 'normal' };
  const someValue = { mainsnak: { snaktype: 'somevalue' }, rank: 'normal' };
  const claims = entityWith({ P36: [item('Q1', 'deprecated'), noValue, someValue, item('Q2')] });
  assert.deepEqual(currentEntityIds(claims, 'P36'), ['Q2']);
});

test('when every statement is historical there is no current value (rather than resurrecting an old one)', () => {
  assert.deepEqual(currentEntityIds(entityWith({ P35: [ended(item('Q1')), ended(item('Q2'))] }), 'P35'), []);
});

test('repeated values are listed once, in order (Brazil lists UTC-03:00 twice)', () => {
  const tz = entityWith({ P421: ['Q6536', 'Q6536', 'Q6513', 'Q6513', 'Q6513', 'Q5762'].map((id) => item(id)) });
  assert.deepEqual(currentEntityIds(tz, 'P421'), ['Q6536', 'Q6513', 'Q5762']);
});

test('an entity with no such property, or no entity at all, yields nothing rather than throwing', () => {
  assert.deepEqual(currentStatements({ claims: {} }, 'P36'), []);
  assert.deepEqual(currentStatements({}, 'P36'), []);
  assert.deepEqual(currentStatements(undefined, 'P36'), []);
  assert.deepEqual(currentEntityIds(null, 'P36'), []);
});

// ---- quantities: area and population ------------------------------------------------------------

test('area is read in km2, parsing the signed amount string', () => {
  assert.equal(areaKm2(entityWith({ P2046: [quantity('+8515767')] })), 8515767);
  assert.equal(areaKm2(entityWith({ P2046: [quantity('+0.49')] })), 0.49); // Vatican City
});

test('area ignores statements in other units instead of misreading square miles as km2', () => {
  const sqMi = quantity('+3287263', 'http://www.wikidata.org/entity/Q232291');
  assert.equal(areaKm2(entityWith({ P2046: [sqMi] })), null);
  assert.equal(areaKm2(entityWith({ P2046: [sqMi, quantity('+1234')] })), 1234);
});

test('with several km2 areas the preferred one wins, otherwise the most recent', () => {
  const dated = entityWith({ P2046: [at(quantity('+100'), '+1990-01-01T00:00:00Z'), at(quantity('+300'), '+2010-01-01T00:00:00Z'), at(quantity('+200'), '+2000-01-01T00:00:00Z')] });
  assert.equal(areaKm2(dated), 300);
  const withPreferred = entityWith({ P2046: [at(quantity('+300'), '+2010-01-01T00:00:00Z'), quantity('+250', KM2_UNIT, 'preferred')] });
  assert.equal(areaKm2(withPreferred), 250);
});

// The Vatican's item carries eight population figures from 1931 to 2024; only the World Bank
// (which does not cover the Vatican) is the app's usual source, so this is the fallback.
test('population: the preferred (current) figure, with its year', () => {
  const vatican = entityWith({
    P1082: [
      at(quantity('+1000', 'unit'), '+2017-00-00T00:00:00Z'),
      at(quantity('+764', 'unit'), '+2023-06-26T00:00:00Z'),
      at(quantity('+711', 'unit'), '+1931-12-31T00:00:00Z'),
      at(quantity('+882', 'unit', 'preferred'), '+2024-12-31T00:00:00Z'),
    ],
  });
  assert.deepEqual(latestQuantity(vatican, 'P1082'), { value: 882, year: 2024 });
});

test('population without a preferred figure falls back to the most recently dated one', () => {
  const claims = entityWith({ P1082: [at(quantity('+594', 'unit'), '+2013-00-00T00:00:00Z'), at(quantity('+764', 'unit'), '+2023-06-26T00:00:00Z'), at(quantity('+572', 'unit'), '+2011-03-01T00:00:00Z')] });
  assert.deepEqual(latestQuantity(claims, 'P1082'), { value: 764, year: 2023 });
});

test('a population with no date has no year, and no population is null', () => {
  assert.deepEqual(latestQuantity(entityWith({ P1082: [quantity('+5000', 'unit')] }), 'P1082'), { value: 5000, year: null });
  assert.equal(latestQuantity(entityWith({}), 'P1082'), null);
});

// ---- dates ----------------------------------------------------------------------------------------

// A date is only as precise as Wikidata says. Rendering a year-only inception as "January 1, 1947" (as
// this used to) INVENTS a month and a day, so the precision is kept: year -> "1947", month -> "1500-05".
test('timeValue keeps only the precision Wikidata has: a full date, a month, or just a year', () => {
  const time = (value, precision) => timeValue(entityWith({ P571: [{ mainsnak: snak('time', { time: value, precision }), rank: 'normal' }] }), 'P571');
  assert.equal(time('+1822-09-07T00:00:00Z', 11), '1822-09-07T00:00:00Z');
  assert.equal(time('+1500-05-00T00:00:00Z', 10), '1500-05');
  assert.equal(time('+1947-00-00T00:00:00Z', 9), '1947');
  assert.equal(time('+0843-01-01T00:00:00Z', 9), '0843', 'a year-precision date is a year even when the stored month/day happen to be 01-01');
});

test('with no precision given it is inferred from the "00" placeholders', () => {
  const time = (value) => timeValue(entityWith({ P571: [{ mainsnak: snak('time', { time: value }), rank: 'normal' }] }), 'P571');
  assert.equal(time('+1822-09-07T00:00:00Z'), '1822-09-07T00:00:00Z');
  assert.equal(time('+1500-05-00T00:00:00Z'), '1500-05');
  assert.equal(time('+1947-00-00T00:00:00Z'), '1947');
});

test('dates before year 1 have no displayable form here (null)', () => {
  const claims = entityWith({ P571: [{ mainsnak: snak('time', { time: '-0500-01-01T00:00:00Z' }), rank: 'normal' }] });
  assert.equal(timeValue(claims, 'P571'), null);
  assert.equal(timeValue(entityWith({}), 'P571'), null);
});

// ---- media, text, coordinates, labels -------------------------------------------------------------

test('commonsFile returns the file name of the first current media statement', () => {
  const flag = entityWith({ P41: [{ mainsnak: snak('commonsMedia', 'Flag of Brazil.svg'), rank: 'normal' }] });
  assert.equal(commonsFile(flag, 'P41'), 'Flag of Brazil.svg');
  assert.equal(commonsFile(entityWith({}), 'P41'), null);
});

// Russia's anthem statement also carries the recording as a P51 qualifier.
test('qualifierCommonsFile reads a media file attached to a statement as a qualifier', () => {
  const statement = { ...item('Q1225991', 'preferred'), qualifiers: { P51: [snak('commonsMedia', 'Russian Anthem chorus.ogg')] } };
  assert.equal(qualifierCommonsFile(statement, 'P51'), 'Russian Anthem chorus.ogg');
  assert.equal(qualifierCommonsFile(item('Q1'), 'P51'), null);
});

test('englishText picks the English form out of several monolingual statements (official name)', () => {
  const brazil = entityWith({
    P1448: ['República Federativa do Brasil|pt', 'République fédérative du Brésil|fr', 'Federative Republic of Brazil|en', 'Brazílska federatívna republika|sk'].map((s) => {
      const [text, language] = s.split('|');
      return { mainsnak: snak('monolingualtext', { text, language }), rank: 'normal' };
    }),
  });
  assert.equal(englishText(brazil, 'P1448'), 'Federative Republic of Brazil');
  assert.equal(englishText(entityWith({}), 'P1448'), null);
});

test('coordinate reads latitude/longitude, from a whole entity or a wbgetclaims result', () => {
  const moscow = entityWith({ P625: [{ mainsnak: snak('globecoordinate', { latitude: 55.75055555555556, longitude: 37.6175 }), rank: 'normal' }] });
  assert.deepEqual(coordinate(moscow, 'P625'), { lat: 55.75055555555556, lng: 37.6175 });
  assert.equal(coordinate(entityWith({}), 'P625'), null);
});

test('labelOf prefers the English label, then the English Wikipedia title, then null', () => {
  assert.equal(labelOf({ labels: { en: { value: 'Euro' } } }), 'Euro');
  assert.equal(labelOf({ labels: {}, sitelinks: { enwiki: { title: 'Euro (currency)' } } }), 'Euro (currency)');
  assert.equal(labelOf({}), null);
  assert.equal(labelOf(undefined), null);
});

// ---- time zones ---------------------------------------------------------------------------------------

test('utcOffsetMinutes parses Wikidata labels, including the real minus sign (U+2212)', () => {
  assert.equal(utcOffsetMinutes('UTC+05:30'), 330);
  assert.equal(utcOffsetMinutes('UTC−03:00'), -180); // U+2212, as Wikidata writes it
  assert.equal(utcOffsetMinutes('UTC-09:30'), -570);
  assert.equal(utcOffsetMinutes('UTC±00:00'), 0);
  assert.equal(utcOffsetMinutes('UTC'), 0);
  assert.ok(Number.isNaN(utcOffsetMinutes('Moscow Time')));
});

test('sortTimeZones orders west to east', () => {
  assert.deepEqual(sortTimeZones(['UTC+03:00', 'UTC−02:00', 'UTC−04:00', 'UTC+05:30']), ['UTC−04:00', 'UTC−02:00', 'UTC+03:00', 'UTC+05:30']);
});


// ---- rank means "primary", not "the only one" ------------------------------------------------------------
// Found live: Wikidata marks the PRIMARY value of a multi-valued property as preferred, while the others
// are just as valid. Treating "preferred" as "the only current value" hid Brazil's English official name
// (the preferred name is Portuguese) and 14 of Russia's 15 time zones.

test('multi-valued properties keep EVERY current value, primary (preferred) first: Brazil\'s official languages', () => {
  const languages = entityWith({ P37: [item('Q3436689'), item('Q5146', 'preferred')] }); // Libras is listed first but Portuguese is primary
  assert.deepEqual(currentEntityIds(languages, 'P37'), ['Q5146', 'Q3436689']);
});

test('Russia\'s time zones: one preferred and the regional ones (qualified "applies to part") all count', () => {
  const regional = (id) => ({ ...item(id), qualifiers: { P518: [snak('wikibase-entityid', { id: 'Q1' })] } });
  const zones = entityWith({ P421: [regional('Q1'), regional('Q2'), regional('Q3'), item('Q4'), item('Q5', 'preferred')] });
  assert.deepEqual(currentEntityIds(zones, 'P421'), ['Q5', 'Q1', 'Q2', 'Q3', 'Q4']);
});

test('an ended statement is dropped even if it is ranked preferred (the end time is the stronger fact)', () => {
  assert.deepEqual(currentEntityIds(entityWith({ P35: [ended(item('Q1', 'preferred')), item('Q2')] }), 'P35'), ['Q2']);
});

test('bestEntityId: the preferred current statement, else the first current one, else null', () => {
  assert.equal(bestEntityId(entityWith({ P36: [item('Q1'), item('Q2', 'preferred')] }), 'P36'), 'Q2');
  assert.equal(bestEntityId(entityWith({ P36: [ended(item('Q1')), item('Q2'), item('Q3')] }), 'P36'), 'Q2');
  assert.equal(bestEntityId(entityWith({ P36: [ended(item('Q1'))] }), 'P36'), null);
  assert.equal(bestEntityId(entityWith({}), 'P36'), null);
});

test('bestStatement returns the statement itself (the anthem\'s recording lives in its qualifiers)', () => {
  const statement = { ...item('Q1225991', 'preferred'), qualifiers: { P51: [snak('commonsMedia', 'Russian Anthem chorus.ogg')] } };
  assert.equal(bestStatement(entityWith({ P85: [ended(item('Q2058180')), statement] }), 'P85'), statement);
  assert.equal(bestStatement(entityWith({}), 'P85'), null);
});

test('the English official name is found even when another language\'s name is the preferred one (Brazil)', () => {
  const name = (t, language, rank = 'normal') => ({ mainsnak: snak('monolingualtext', { text: t, language }), rank });
  const brazil = entityWith({ P1448: [name('República Federativa do Brasil', 'pt', 'preferred'), name('Federative Republic of Brazil', 'en')] });
  assert.equal(englishText(brazil, 'P1448'), 'Federative Republic of Brazil');
});

test('a single-valued reading still prefers the preferred rank: area, flag, inception, coordinates', () => {
  const flags = entityWith({ P41: [{ mainsnak: snak('commonsMedia', 'Old flag.svg'), rank: 'normal' }, { mainsnak: snak('commonsMedia', 'Current flag.svg'), rank: 'preferred' }] });
  assert.equal(commonsFile(flags, 'P41'), 'Current flag.svg');
  const dates = entityWith({ P571: [{ mainsnak: snak('time', { time: '+1900-01-01T00:00:00Z' }), rank: 'normal' }, { mainsnak: snak('time', { time: '+1822-09-07T00:00:00Z' }), rank: 'preferred' }] });
  assert.equal(timeValue(dates, 'P571'), '1822-09-07T00:00:00Z');
});

// Found live: the Vatican's time-zone property lists the zone three ways ("UTC+01:00", "Central European
// Time", "Europe/Vatican"). The app writes zones as UTC offsets, so the other two are just noise.
test('when a zone is given as a UTC offset, its named and IANA duplicates are dropped', () => {
  assert.deepEqual(sortTimeZones(['UTC+01:00', 'Central European Time', 'Europe/Vatican']), ['UTC+01:00']);
});

test('but if NO label is an offset, the names are kept rather than showing nothing', () => {
  assert.deepEqual(sortTimeZones(['Central European Time', 'Europe/Vatican']), ['Central European Time', 'Europe/Vatican']);
});


// ---- what "ended" means --------------------------------------------------------------------------------
// Found by review: ANY end-time qualifier used to mean "ended". But Wikidata's "no value" end time says the
// statement has NO end (so a valid capital / head of state / anthem vanished), and an end date in the
// future has not happened yet.
const endQualifier = (statement, snaktype, time) => ({
  ...statement,
  qualifiers: { P582: [snaktype === 'value' ? snak('time', { time }) : { snaktype, property: 'P582' }] },
});
const NOW = Date.parse('2026-09-20T00:00:00Z');

test('an end time of "no value" means there is no end: the statement is current', () => {
  assert.deepEqual(currentEntityIds(entityWith({ P36: [endQualifier(item('Q1'), 'novalue')] }), 'P36'), ['Q1']);
});

test('an end time of "unknown value" means it ended, at an unknown date', () => {
  assert.deepEqual(currentEntityIds(entityWith({ P36: [endQualifier(item('Q1'), 'somevalue')] }), 'P36'), []);
});

test('an end date in the future has not ended; one in the past has', () => {
  const claims = entityWith({ P35: [endQualifier(item('Q1'), 'value', '+2030-01-20T00:00:00Z'), endQualifier(item('Q2'), 'value', '+2020-01-20T00:00:00Z')] });
  assert.deepEqual(currentStatements(claims, 'P35', { now: NOW }).map((s) => s.mainsnak.datavalue.value.id), ['Q1']);
});

test('an end date of exactly "now" counts as ended, and ancient (BCE) end dates are certainly past', () => {
  const claims = entityWith({ P35: [endQualifier(item('Q1'), 'value', '+2026-09-20T00:00:00Z'), endQualifier(item('Q2'), 'value', '-0300-01-01T00:00:00Z')] });
  assert.deepEqual(currentStatements(claims, 'P35', { now: NOW }), []);
});

test('an unreadable end date is treated as an end (the qualifier is there for a reason)', () => {
  const claims = entityWith({ P35: [{ ...item('Q1'), qualifiers: { P582: [{ snaktype: 'value', datavalue: { value: {} } }] } }] });
  assert.deepEqual(currentStatements(claims, 'P35', { now: NOW }), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWikidataFacts } from '../../lib/wikidataClient.js';
import { KM2_UNIT } from '../../lib/wikidataEntity.js';

// ---- fixture builders (real Wikidata JSON shapes) -----------------------------------------------
const snak = (type, value) => ({ snaktype: 'value', datavalue: { type, value } });
const item = (id, rank = 'normal') => ({ mainsnak: snak('wikibase-entityid', { 'entity-type': 'item', id }), rank });
const ended = (statement) => ({ ...statement, qualifiers: { ...statement.qualifiers, P582: [snak('time', { time: '+1960-04-21T00:00:00Z' })] } });
const withQualifier = (statement, property, type, value) => ({ ...statement, qualifiers: { ...statement.qualifiers, [property]: [snak(type, value)] } });
const media = (file) => ({ mainsnak: snak('commonsMedia', file), rank: 'normal' });
const text = (t, language) => ({ mainsnak: snak('monolingualtext', { text: t, language }), rank: 'normal' });
const quantity = (amount) => ({ mainsnak: snak('quantity', { amount, unit: KM2_UNIT }), rank: 'normal' });
const time = (t) => ({ mainsnak: snak('time', { time: t }), rank: 'normal' });

// A fake `api` that records what was asked of it. `labelsByQid` answers getLabels; `claimsByKey`
// answers getClaims("Q..:P.."); failures are injected per method.
function fakeApi({ qid = 'Q155', entity, labelsByQid = {}, claimsByKey = {}, fileInfo = null, failures = {}, failingClaims = [] } = {}) {
  const calls = { resolveQid: 0, getEntity: 0, getLabels: [], getClaims: [], getCommonsFileInfo: [] };
  const api = {
    calls,
    resolveQid: async () => { calls.resolveQid++; if (failures.resolveQid) throw failures.resolveQid; return qid; },
    getEntity: async () => { calls.getEntity++; if (failures.getEntity) throw failures.getEntity; return entity; },
    getLabels: async (ids) => {
      calls.getLabels.push([...ids]);
      if (failures.getLabels) throw failures.getLabels;
      return new Map(ids.map((id) => [id, labelsByQid[id] ?? null]));
    },
    getClaims: async (id, property) => {
      calls.getClaims.push(`${id}:${property}`);
      if (failures.getClaims || failingClaims.includes(`${id}:${property}`)) throw failures.getClaims ?? new Error('busy'); // every claims request, or only the named "Q..:P.." ones
      return { claims: claimsByKey[`${id}:${property}`] ?? {} };
    },
    getCommonsFileInfo: async (file) => {
      calls.getCommonsFileInfo.push(file);
      if (failures.getCommonsFileInfo) throw failures.getCommonsFileInfo;
      return fileInfo;
    },
  };
  return api;
}

// Brazil, abridged from the real item: TWO capitals (Rio ended 1960), NINE currencies (all but the
// real ended), one time zone listed several times.
function brazilEntity() {
  return {
    claims: {
      P1448: [text('República Federativa do Brasil', 'pt'), text('Federative Republic of Brazil', 'en')],
      P36: [ended(item('Q8678')), item('Q2844')],
      P625: [{ mainsnak: snak('globecoordinate', { latitude: -10, longitude: -55 }), rank: 'normal' }],
      P2046: [quantity('+8515767')],
      P38: [item('Q173117'), ended(item('Q831578')), ended(item('Q10261896'))],
      P30: [item('Q18')],
      P41: [media('Flag of Brazil.svg')],
      P571: [time('+1822-09-07T00:00:00Z')],
      P122: [item('Q5')],
      P35: [item('Q1', 'preferred')],
      P6: [item('Q2')],
      P85: [item('Q134654')],
      P421: [item('Q6536'), item('Q6536'), item('Q6513'), item('Q5762'), item('Q5390')],
      P37: [item('Q5146'), item('Q3436689')],
    },
  };
}
const brazilLabels = { Q2844: 'Brasília', Q8678: 'Rio de Janeiro', Q173117: 'Brazilian real', Q831578: 'cruzeiro', Q18: 'South America', Q5: 'federal republic', Q1: 'Lula', Q2: 'Lula (HoG)', Q134654: 'Brazilian National Anthem', Q6536: 'UTC−02:00', Q6513: 'UTC−03:00', Q5762: 'UTC−04:00', Q5390: 'UTC−05:00', Q5146: 'Portuguese', Q3436689: 'Brazilian Sign Language' };

// ---- core -------------------------------------------------------------------------------------------

// The reported bug: Brazil showed "Not available" for the capital, area, currency, continent and time zones.
test('core: Brazil resolves its capital (Brasília, not the ended Rio), area, one currency, continent and flag', async () => {
  const api = fakeApi({ entity: brazilEntity(), labelsByQid: brazilLabels, claimsByKey: { 'Q2844:P625': { P625: [{ mainsnak: snak('globecoordinate', { latitude: -15.79, longitude: -47.88 }), rank: 'normal' }] } } });
  const brazil = await createWikidataFacts(api).core('BRA');
  assert.equal(brazil.officialName, 'Federative Republic of Brazil');
  assert.deepEqual(brazil.capital, { name: 'Brasília', coord: { lat: -15.79, lng: -47.88 } });
  assert.equal(brazil.areaKm2, 8515767);
  assert.deepEqual(brazil.currencies, ['Brazilian real']);
  assert.deepEqual(brazil.continents, ['South America']);
  assert.equal(brazil.flagUrl, 'https://commons.wikimedia.org/wiki/Special:FilePath/Flag%20of%20Brazil.svg');
  assert.equal(brazil.formationDate, '1822-09-07T00:00:00Z');
  assert.equal(brazil.governmentForm, 'federal republic');
  assert.deepEqual(brazil.centerCoord, { lat: -10, lng: -55 });
});

test('core: needs one entity read and one label batch, however many facts it fills in', async () => {
  const api = fakeApi({ entity: brazilEntity(), labelsByQid: brazilLabels });
  await createWikidataFacts(api).core('BRA');
  assert.equal(api.calls.getEntity, 1);
  assert.equal(api.calls.getLabels.length, 1);
});

test('core: head of state is the preferred current holder; head of government is its own field', async () => {
  const brazil = await createWikidataFacts(fakeApi({ entity: brazilEntity(), labelsByQid: brazilLabels })).core('BRA');
  assert.equal(brazil.headOfState, 'Lula');
  assert.equal(brazil.headOfGovernment, 'Lula (HoG)');
});

test('core: with no head of state statement (the USA), the head of government is shown for both roles', async () => {
  const entity = brazilEntity();
  delete entity.claims.P35;
  const usa = await createWikidataFacts(fakeApi({ entity, labelsByQid: brazilLabels })).core('USA');
  assert.equal(usa.headOfState, 'Lula (HoG)');
});

test('core: an ended head of state is not shown as the current one', async () => {
  const entity = brazilEntity();
  entity.claims.P35 = [ended(item('Q1'))];
  const facts = await createWikidataFacts(fakeApi({ entity, labelsByQid: brazilLabels })).core('BRA');
  assert.equal(facts.headOfState, 'Lula (HoG)'); // no CURRENT P35 -> the (documented) combined-office fallback
});

// Vatican City: the World Bank has nothing for it, so its Wikidata population must reach the panel.
test('core: reports Wikidata\'s population and year (the fallback where the World Bank has none)', async () => {
  const entity = brazilEntity();
  entity.claims.P1082 = [{ ...quantity('+882'), rank: 'preferred', qualifiers: { P585: [snak('time', { time: '+2024-12-31T00:00:00Z' })] } }];
  const facts = await createWikidataFacts(fakeApi({ entity, labelsByQid: brazilLabels })).core('VAT');
  assert.deepEqual(facts.population, { value: 882, year: 2024 });
});

test('core: no anthem statement means no anthem', async () => {
  const entity = brazilEntity();
  delete entity.claims.P85;
  assert.equal((await createWikidataFacts(fakeApi({ entity, labelsByQid: brazilLabels })).core('BRA')).anthem, null);
});

// ---- the anthem (Russia: "recording not available") -------------------------------------------------

function russiaEntity({ recordingOnStatement }) {
  const current = { ...item('Q1225991', 'preferred') };
  const statement = recordingOnStatement ? withQualifier(current, 'P51', 'commonsMedia', 'Russian Anthem chorus.ogg') : current;
  return { claims: { P85: [statement, ended(item('Q2058180'))] } };
}
const russiaLabels = { Q1225991: 'State Anthem of the Russian Federation', Q2058180: 'Patrioticheskaya Pesnya' };
const russiaFile = { oggUrl: 'https://upload.wikimedia.org/wikipedia/commons/f/fc/Russian_Anthem_chorus.ogg', mp3Url: 'https://upload.wikimedia.org/x.mp3', license: { shortName: 'CC BY 4.0', credit: 'Someone' } };

test('anthem: Russia uses its CURRENT (preferred) anthem, and the recording attached to that statement', async () => {
  const api = fakeApi({ entity: russiaEntity({ recordingOnStatement: true }), labelsByQid: russiaLabels, fileInfo: russiaFile });
  const { anthem } = await createWikidataFacts(api).core('RUS');
  assert.equal(anthem.title, 'State Anthem of the Russian Federation');
  assert.equal(anthem.oggUrl, russiaFile.oggUrl);
  assert.equal(anthem.license.shortName, 'CC BY 4.0');
  assert.deepEqual(api.calls.getCommonsFileInfo, ['Russian Anthem chorus.ogg']);
  assert.deepEqual(api.calls.getClaims, [], 'no extra lookup was needed');
});

test('anthem: when the statement has no recording, the anthem item\'s own audio (P51) is used', async () => {
  const api = fakeApi({
    entity: russiaEntity({ recordingOnStatement: false }),
    labelsByQid: russiaLabels,
    claimsByKey: { 'Q1225991:P51': { P51: [media('Russian Anthem chorus.ogg')] } },
    fileInfo: russiaFile,
  });
  const { anthem } = await createWikidataFacts(api).core('RUS');
  assert.equal(anthem.oggUrl, russiaFile.oggUrl);
  assert.deepEqual(api.calls.getClaims, ['Q1225991:P51']);
});

test('anthem: if only the Commons file lookup fails, the recording is still offered via Special:FilePath', async () => {
  const api = fakeApi({ entity: russiaEntity({ recordingOnStatement: true }), labelsByQid: russiaLabels, failures: { getCommonsFileInfo: new Error('offline') } });
  const { anthem } = await createWikidataFacts(api).core('RUS');
  assert.equal(anthem.oggUrl, 'https://commons.wikimedia.org/wiki/Special:FilePath/Russian%20Anthem%20chorus.ogg');
  assert.equal(anthem.title, 'State Anthem of the Russian Federation');
});

test('anthem: an anthem with no recording anywhere has a title and no audio', async () => {
  const { anthem } = await createWikidataFacts(fakeApi({ entity: russiaEntity({ recordingOnStatement: false }), labelsByQid: russiaLabels })).core('RUS');
  assert.equal(anthem.title, 'State Anthem of the Russian Federation');
  assert.equal(anthem.oggUrl, null);
});

// ---- failures ------------------------------------------------------------------------------------------

test('a failure to read the country item REJECTS (so the caller can offer a Retry) rather than returning empty facts', async () => {
  const boom = new Error('network down');
  await assert.rejects(createWikidataFacts(fakeApi({ entity: brazilEntity(), failures: { getEntity: boom } })).core('BRA'), /network down/);
  await assert.rejects(createWikidataFacts(fakeApi({ entity: brazilEntity(), failures: { resolveQid: boom } })).core('BRA'), /network down/);
});

test('a failure to fetch labels also rejects: the names are the substance of the answer', async () => {
  await assert.rejects(createWikidataFacts(fakeApi({ entity: brazilEntity(), failures: { getLabels: new Error('busy') } })).core('BRA'), /busy/);
});

test('the capital\'s map coordinates failing leaves the capital name in place — and is REPORTED, not silently cached as complete', async () => {
  const facts = await createWikidataFacts(fakeApi({ entity: brazilEntity(), labelsByQid: brazilLabels, failingClaims: ['Q2844:P625'] })).core('BRA');
  assert.deepEqual(facts.capital, { name: 'Brasília', coord: null });
  assert.deepEqual(facts.incompleteParts, ['capital coordinates']);
});

// Found by review: sub-requests whose failure was swallowed (.catch(() => null)) left a result that looked
// complete, so it was cached for the visit — no notice, no Try again, no audio in Safari — the very bug
// class this work set out to fix. They are the 5th-7th requests in the chain, so the likeliest to be throttled.
test('a complete read reports nothing incomplete, and the marker never shows up as data', async () => {
  const facts = await createWikidataFacts(fakeApi({ entity: brazilEntity(), labelsByQid: brazilLabels, claimsByKey: { 'Q2844:P625': { P625: [{ mainsnak: snak('globecoordinate', { latitude: 1, longitude: 2 }), rank: 'normal' }] } } })).core('BRA');
  assert.deepEqual(facts.incompleteParts, []);
  assert.equal(Object.keys(facts).includes('incompleteParts'), false);
});

test('an anthem whose recording lookup failed is reported incomplete', async () => {
  const lookupFails = fakeApi({ entity: russiaEntity({ recordingOnStatement: false }), labelsByQid: russiaLabels, failures: { getClaims: new Error('busy') } });
  assert.deepEqual((await createWikidataFacts(lookupFails).core('RUS')).incompleteParts, ['anthem recording']);
  const commonsFails = fakeApi({ entity: russiaEntity({ recordingOnStatement: true }), labelsByQid: russiaLabels, failures: { getCommonsFileInfo: new Error('busy') } });
  assert.deepEqual((await createWikidataFacts(commonsFails).core('RUS')).incompleteParts, ['anthem recording']);
});

test('an anthem with genuinely no recording is complete, not a failure', async () => {
  const facts = await createWikidataFacts(fakeApi({ entity: russiaEntity({ recordingOnStatement: false }), labelsByQid: russiaLabels })).core('RUS');
  assert.deepEqual(facts.incompleteParts, []);
});

test('an item that cannot be found is an error, not an empty country', async () => {
  await assert.rejects(createWikidataFacts(fakeApi({ qid: null, entity: null })).core('ZZZ'), /No Wikidata item/);
  await assert.rejects(createWikidataFacts(fakeApi({ entity: null })).core('BRA'), /no item/i);
});

test('a failed read is not remembered: the next call starts fresh', async () => {
  let failFirst = true;
  const api = fakeApi({ entity: brazilEntity(), labelsByQid: brazilLabels });
  const realGetEntity = api.getEntity;
  api.getEntity = async () => { if (failFirst) { failFirst = false; throw new Error('blip'); } return realGetEntity(); };
  const facts = createWikidataFacts(api);
  await assert.rejects(facts.core('BRA'), /blip/);
  assert.equal((await facts.core('BRA')).areaKm2, 8515767);
});

// ---- lists ---------------------------------------------------------------------------------------------

test('lists: time zones are unique and ordered west to east', async () => {
  const { timeZones } = await createWikidataFacts(fakeApi({ entity: brazilEntity(), labelsByQid: brazilLabels })).lists('BRA');
  assert.deepEqual(timeZones, ['UTC−05:00', 'UTC−04:00', 'UTC−03:00', 'UTC−02:00']);
});

test('lists: the official languages are listed, primary (preferred) first', async () => {
  const entity = brazilEntity();
  entity.claims.P37 = [item('Q3436689'), item('Q5146', 'preferred')]; // Libras first in the item, Portuguese is the primary one
  const { languages } = await createWikidataFacts(fakeApi({ entity, labelsByQid: brazilLabels })).lists('BRA');
  assert.deepEqual(languages, ['Portuguese', 'Brazilian Sign Language']);
});

test('lists: all of Russia\'s time zones are kept, not only the preferred one', async () => {
  const entity = { claims: { P421: [item('Q1'), item('Q2'), item('Q3', 'preferred')] } };
  const { timeZones } = await createWikidataFacts(fakeApi({ entity, labelsByQid: { Q1: 'UTC+02:00', Q2: 'UTC+11:00', Q3: 'UTC+03:00' } })).lists('RUS');
  assert.deepEqual(timeZones, ['UTC+02:00', 'UTC+03:00', 'UTC+11:00']);
});

test('core: the English official name is found although the preferred name is in another language (Brazil)', async () => {
  const entity = brazilEntity();
  entity.claims.P1448 = [{ mainsnak: snak('monolingualtext', { text: 'República Federativa do Brasil', language: 'pt' }), rank: 'preferred' }, { mainsnak: snak('monolingualtext', { text: 'Federative Republic of Brazil', language: 'en' }), rank: 'normal' }];
  assert.equal((await createWikidataFacts(fakeApi({ entity, labelsByQid: brazilLabels })).core('BRA')).officialName, 'Federative Republic of Brazil');
});

test('core: France keeps BOTH current currencies even when one of them is ranked preferred', async () => {
  const entity = brazilEntity();
  entity.claims.P38 = [item('Q4916', 'preferred'), item('Q1'), ended(item('Q2'))];
  const facts = await createWikidataFacts(fakeApi({ entity, labelsByQid: { ...brazilLabels, Q4916: 'Euro', Q1: 'CFP Franc', Q2: 'French franc' } })).core('FRA');
  assert.deepEqual(facts.currencies, ['Euro', 'CFP Franc']);
});

test('lists: shares ONE country-item read with core (it is ~1 MB)', async () => {
  const api = fakeApi({ entity: brazilEntity(), labelsByQid: brazilLabels });
  const facts = createWikidataFacts(api);
  await Promise.all([facts.core('BRA'), facts.lists('BRA')]);
  assert.equal(api.calls.getEntity, 1);
  assert.equal(api.calls.resolveQid, 1);
});

test('lists: a small set of extra spoken languages tops up the official ones (the USA and English)', async () => {
  const entity = { claims: { P37: ['Q1', 'Q2', 'Q3'].map((id) => item(id)), P2936: ['Q1', 'Q2', 'Q3', 'Q4'].map((id) => item(id)) } };
  const { languages } = await createWikidataFacts(fakeApi({ entity, labelsByQid: { Q1: 'Hawaiian', Q2: 'Spanish', Q3: 'Samoan', Q4: 'English' } })).lists('USA');
  assert.deepEqual(languages, ['Hawaiian', 'Spanish', 'Samoan', 'English']);
});

test('lists: hundreds of spoken languages (India) are not fetched at all, and do not swamp the official ones', async () => {
  const many = Array.from({ length: 300 }, (_, i) => item(`Q${1000 + i}`));
  const entity = { claims: { P37: [item('Q1'), item('Q2')], P2936: [item('Q1'), item('Q2'), ...many] } };
  const api = fakeApi({ entity, labelsByQid: { Q1: 'Hindi', Q2: 'English' } });
  const { languages } = await createWikidataFacts(api).lists('IND');
  assert.deepEqual(languages, ['Hindi', 'English']);
  assert.ok(api.calls.getLabels.flat().length < 10, 'the 300 spoken-language labels must not be requested');
});

test('lists: with no official language, the spoken ones stand in, capped', async () => {
  const entity = { claims: { P2936: Array.from({ length: 30 }, (_, i) => item(`Q${i + 1}`)) } };
  const labelsByQid = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Q${i + 1}`, `Language ${i + 1}`]));
  const { languages } = await createWikidataFacts(fakeApi({ entity, labelsByQid })).lists('XXX');
  assert.equal(languages.length, 15);
});

// ---- states and territories (page only) -----------------------------------------------------------------

test('states: the count is complete, the list alphabetical, and only current subdivisions count', async () => {
  const entity = { claims: { P150: [item('Q1'), item('Q2'), ended(item('Q3')), item('Q4')] } };
  const states = await createWikidataFacts(fakeApi({ entity, labelsByQid: { Q1: 'Pará', Q2: 'Acre', Q4: 'Bahia' } })).statesTerritories('BRA');
  assert.deepEqual(states, { count: 3, list: ['Acre', 'Bahia', 'Pará'] });
});

test('states: a country with no subdivisions listed gets an empty list and no label request', async () => {
  const api = fakeApi({ entity: { claims: {} } });
  assert.deepEqual(await createWikidataFacts(api).statesTerritories('VAT'), { count: 0, list: [] });
  assert.deepEqual(api.calls.getLabels, []);
});

test('states: only the first 150 labels are fetched, but the count stays the true one', async () => {
  const entity = { claims: { P150: Array.from({ length: 400 }, (_, i) => item(`Q${i + 1}`)) } };
  const api = fakeApi({ entity, labelsByQid: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`Q${i + 1}`, `Place ${String(i + 1).padStart(3, '0')}`])) });
  const states = await createWikidataFacts(api).statesTerritories('XXX');
  assert.equal(states.count, 400);
  assert.equal(states.list.length, 150);
  assert.equal(api.calls.getLabels[0].length, 150);
});

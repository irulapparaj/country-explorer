import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PYRAMID_BANDS } from '../../lib/worldBankClient.js';

test('PYRAMID_BANDS covers all seventeen five-year age bands with no duplicates', () => {
  assert.equal(PYRAMID_BANDS.length, 17);
  assert.equal(new Set(PYRAMID_BANDS).size, 17);
});

test('PYRAMID_BANDS entries match the World Bank SP.POP.{band}.{MA|FE} shape', () => {
  for (const band of PYRAMID_BANDS) {
    assert.match(band, /^(\d{4}|80UP)$/);
  }
  assert.equal(PYRAMID_BANDS.at(-1), '80UP');
});

// ---- retry + failure tracking (fetch is injected: no network) ---------------------------------------
import { fetchWorldBankDemographics, fetchWorldBankPyramid } from '../../lib/worldBankClient.js';

const wbOk = (value, date = '2024') => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => [{ page: 1 }, [{ value, date }]] });
// What the World Bank really answers for a place it does not cover (e.g. the Vatican): HTTP 200 and a message body.
const wbUnsupported = { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ message: [{ id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' }] }] };
const wbEmpty = { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ page: 1 }, [{ value: null, date: '2024' }]] };
const wbStatus = (code) => ({ ok: false, status: code, headers: { get: () => null }, json: async () => ({}) });
const noWait = async () => {};

test('demographics come back as {value, year} per indicator', async () => {
  const fetchImpl = async () => wbOk(212812405, '2025');
  const data = await fetchWorldBankDemographics('BRA', { fetchImpl, sleep: noWait });
  assert.deepEqual(data.population, { value: 212812405, year: 2025 });
  assert.equal(Object.keys(data).length, 9);
  assert.deepEqual(data.failedIndicators, []);
});

test('a place the World Bank does not cover is "no data", NOT a failure (so no misleading Retry)', async () => {
  const data = await fetchWorldBankDemographics('VAT', { fetchImpl: async () => wbUnsupported, sleep: noWait });
  assert.equal(data.population, null);
  assert.deepEqual(data.failedIndicators, []);
  const empty = await fetchWorldBankDemographics('XXX', { fetchImpl: async () => wbEmpty, sleep: noWait });
  assert.equal(empty.population, null);
  assert.deepEqual(empty.failedIndicators, []);
});

test('a busy service (429) is retried instead of turning into "Not available"', async () => {
  const seen = new Map();
  const fetchImpl = async (url) => {
    const n = (seen.get(url) ?? 0) + 1;
    seen.set(url, n);
    return n === 1 ? wbStatus(429) : wbOk(100);
  };
  const data = await fetchWorldBankDemographics('BRA', { fetchImpl, sleep: noWait });
  assert.deepEqual(data.population, { value: 100, year: 2024 });
  assert.deepEqual(data.failedIndicators, []);
});

test('indicators that keep failing are reported by name; the others still arrive', async () => {
  const fetchImpl = async (url) => (url.includes('SP.DYN.LE00.IN') ? wbStatus(503) : wbOk(7));
  const data = await fetchWorldBankDemographics('BRA', { fetchImpl, sleep: noWait });
  assert.equal(data.lifeExpectancy, null);
  assert.deepEqual(data.failedIndicators, ['lifeExpectancy']);
  assert.deepEqual(data.population, { value: 7, year: 2024 });
});

test('failedIndicators does not leak into the data (it is not enumerable), so spreading/iterating stays clean', async () => {
  const data = await fetchWorldBankDemographics('BRA', { fetchImpl: async () => wbStatus(503), sleep: noWait });
  assert.equal(data.failedIndicators.length, 9);
  assert.equal(Object.keys(data).includes('failedIndicators'), false);
  assert.equal(Object.values({ ...data }).every((v) => v === null), true);
});

test('the pyramid has one row per age band and lists any failed indicator', async () => {
  const fetchImpl = async (url) => (url.includes('SP.POP.2529.FE') ? wbStatus(500) : wbOk(1000));
  const rows = await fetchWorldBankPyramid('BRA', { fetchImpl, sleep: noWait });
  assert.equal(rows.length, 17);
  assert.equal(rows[0].band, '0004');
  assert.deepEqual(rows[0].male, { value: 1000, year: 2024 });
  const row = rows.find((r) => r.band === '2529');
  assert.equal(row.female, null);
  assert.deepEqual(rows.failedIndicators, ['SP.POP.2529.FE']);
});

test('a country with no age data at all yields rows of nulls and NO failures (Vatican City)', async () => {
  const rows = await fetchWorldBankPyramid('VAT', { fetchImpl: async () => wbUnsupported, sleep: noWait });
  assert.equal(rows.length, 17);
  assert.ok(rows.every((r) => r.male === null && r.female === null));
  assert.deepEqual(rows.failedIndicators, []);
});

// ---- what counts as "no data", and how hard we hit the host --------------------------------------------

const wbMessage = (id, key) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => [{ message: [{ id, key, value: 'x' }] }] });
const wbNoRows = { ok: true, status: 200, headers: { get: () => null }, json: async () => [{ page: 0, pages: 0, per_page: 0, total: 0 }, null] }; // Taiwan, live

// Found by review: ANY 200 with a message body used to count as "this place has no data". Only the
// documented "invalid value" answer (id 120 — what the API says for a country it does not cover, checked live
// for VAT and ZZZ) means that; a message we do not recognise is a failure the user should be able to retry.
test('an unrecognised message body is a failure, not "no data"', async () => {
  const data = await fetchWorldBankDemographics('BRA', { fetchImpl: async () => wbMessage('175', 'Something else'), sleep: noWait });
  assert.equal(data.population, null);
  assert.equal(data.failedIndicators.length, 9);
});

test('a country the World Bank has no rows for (Taiwan: an empty page) is "no data", not a failure', async () => {
  const data = await fetchWorldBankDemographics('TWN', { fetchImpl: async () => wbNoRows, sleep: noWait });
  assert.equal(data.population, null);
  assert.deepEqual(data.failedIndicators, []);
});

test('a failure with an unrecognised message is not retried (it would answer the same again)', async () => {
  let calls = 0;
  await fetchWorldBankDemographics('BRA', { fetchImpl: async () => { calls++; return wbMessage('175', 'Something else'); }, sleep: noWait });
  assert.equal(calls, 9); // one attempt per indicator
});

// The 43 requests of a full country page used to be fired at once, all retrying in step when the host got busy.
test('requests to the World Bank are capped at a handful in flight, however many indicators there are', async () => {
  let running = 0;
  let peak = 0;
  const fetchImpl = async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    running--;
    return wbOk(1);
  };
  const rows = await fetchWorldBankPyramid('BRA', { fetchImpl, sleep: noWait });
  assert.equal(rows.length, 17);
  assert.deepEqual(rows.failedIndicators, []);
  assert.ok(peak > 1 && peak <= 6, `peak in flight: ${peak}`);
});

// ---- the shape of an answer, and the exact questions asked -----------------------------------------------------

// Found by review: a 200 that is neither a message nor a data page ({}, [], a bare header) read as "no data".
test('a body that is not a World Bank answer at all is a failure, not "no data" — and is not retried', async () => {
  for (const body of [{}, [], [{ page: 1 }], 'oops', null]) {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: true, status: 200, headers: { get: () => null }, json: async () => body }; };
    const data = await fetchWorldBankDemographics('BRA', { fetchImpl, sleep: noWait });
    assert.equal(data.failedIndicators.length, 9, JSON.stringify(body));
    assert.equal(calls, 9, 'one attempt per indicator');
  }
});

test('a page with no rows, or an empty row list, is genuine "no data"', async () => {
  for (const body of [[{ page: 0, total: 0 }, null], [{ page: 1, total: 0 }, []]]) {
    const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
    const data = await fetchWorldBankDemographics('TWN', { fetchImpl, sleep: noWait });
    assert.equal(data.population, null);
    assert.deepEqual(data.failedIndicators, []);
  }
});

// Mutation testing by review: dropping `mrnev=1`, or a wrong path or indicator code, left every test green — and
// dropping mrnev=1 would silently turn many indicators into "no data" (they are empty for the latest calendar year).
const urlsAsked = async (run) => {
  const urls = [];
  await run(async (url) => { urls.push(url); return wbOk(1); });
  return urls.sort();
};
const wbUrl = (iso3, code) => `https://api.worldbank.org/v2/country/${iso3}/indicator/${code}?format=json&per_page=1&mrnev=1`;

test('demographics ask for exactly these nine indicators, most recent non-empty value, for the country asked about', async () => {
  const urls = await urlsAsked((fetchImpl) => fetchWorldBankDemographics('BRA', { fetchImpl, sleep: noWait }));
  const codes = ['SP.POP.TOTL', 'EN.POP.DNST', 'SP.DYN.CBRT.IN', 'SP.DYN.CDRT.IN', 'SP.POP.GROW', 'SM.POP.NETM', 'SP.DYN.LE00.IN', 'SP.POP.TOTL.MA.IN', 'SP.POP.TOTL.FE.IN'];
  assert.deepEqual(urls, codes.map((code) => wbUrl('BRA', code)).sort());
});

test('the pyramid asks for male and female counts in each of the 17 age bands', async () => {
  const urls = await urlsAsked((fetchImpl) => fetchWorldBankPyramid('FRA', { fetchImpl, sleep: noWait }));
  const bands = ['0004', '0509', '1014', '1519', '2024', '2529', '3034', '3539', '4044', '4549', '5054', '5559', '6064', '6569', '7074', '7579', '80UP'];
  assert.deepEqual(urls, bands.flatMap((band) => [`SP.POP.${band}.MA`, `SP.POP.${band}.FE`]).map((code) => wbUrl('FRA', code)).sort());
});

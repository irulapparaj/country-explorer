// Pure readers for Wikidata entity JSON (as returned by the Action API's wbgetentities/wbgetclaims).
// No network and no DOM, so the rules that decide WHICH of an item's statements to believe — the
// subtle part — can be unit-tested against the real shapes.
//
// Why this matters: a Wikidata item keeps history. Brazil lists two capitals (Rio de Janeiro, ended
// 1960, and Brasília) and nine currencies; Russia lists two anthems; the Vatican lists eight
// population figures. Reading "all values" (or an arbitrary one) shows wrong or stale facts, so
// every reader here goes through currentStatements().

export const KM2_UNIT = 'http://www.wikidata.org/entity/Q712226';
const END_TIME = 'P582';
const POINT_IN_TIME = 'P585';

const valueOf = (statement) => (statement.mainsnak?.snaktype === 'value' ? statement.mainsnak.datavalue?.value : undefined);

// ---- times and "has it ended?" ---------------------------------------------------------------------

function yearOfTime(time) {
  const match = /^([+-])(\d+)-/.exec(time ?? '');
  return match ? (match[1] === '-' ? -1 : 1) * Number(match[2]) : null;
}

// Wikidata times are "+YYYY-MM-DDT00:00:00Z", with "00" month/day placeholders at coarse precision.
function timeToMillis(raw) {
  const year = yearOfTime(raw);
  if (year == null) return Number.NaN;
  if (year < 1) return -Infinity; // BCE: certainly in the past (Date cannot represent it as ISO text)
  if (year > 9999) return Infinity;
  return Date.parse(raw.replace(/^\+/, '').replace(/-00(?=-|T)/g, '-01').replace(/-00T/, '-01T'));
}

/**
 * Has this statement ended? An end-time qualifier (P582) says so — with three exceptions Wikidata
 * itself defines: "no value" means it has NO end; "unknown value" means it ended at an unknown time;
 * and an end DATE only counts once it has arrived (a term ending next year is still in force).
 */
function hasEnded(statement, now) {
  const qualifiers = statement.qualifiers?.[END_TIME];
  if (!qualifiers?.length) return false;
  return qualifiers.some((qualifier) => {
    if (qualifier.snaktype === 'novalue') return false;
    if (qualifier.snaktype === 'somevalue') return true;
    const endsAt = timeToMillis(qualifier.datavalue?.value?.time);
    return Number.isNaN(endsAt) ? true : endsAt <= now; // unreadable: assume the qualifier means what it usually means
  });
}

// ---- which statements are current ------------------------------------------------------------------

/**
 * Every statement of `property` that is still true. Deprecated statements, "no value" / "unknown
 * value" snaks and statements that have ENDED are dropped; the rest are all kept, with the ones
 * ranked PREFERRED first.
 *
 * Rank means "primary", not "only": Wikidata marks the main value of a multi-valued property as
 * preferred while the others stay valid — Brazil's official languages (Portuguese preferred, Libras
 * also official), Russia's time zones (one preferred, the regional ones normal). Reading "preferred
 * only" hid the English official name and 14 of Russia's 15 time zones. Single-valued facts ask for
 * bestStatement() instead.
 * @param {object | null | undefined} entity an entity — or a wbgetclaims result — with a `claims` map
 * @param {string} property e.g. "P36"
 * @param {{now?: number}} [options] `now` (ms) decides whether an end DATE has arrived; injectable for tests
 */
export function currentStatements(entity, property, { now = Date.now() } = {}) {
  const live = (entity?.claims?.[property] ?? []).filter(
    (s) => s.rank !== 'deprecated' && s.mainsnak?.snaktype === 'value' && !hasEnded(s, now)
  );
  return [...live.filter((s) => s.rank === 'preferred'), ...live.filter((s) => s.rank !== 'preferred')];
}

/** The one statement to believe for a single-valued fact: the preferred current one, else the first. */
export function bestStatement(entity, property) {
  return currentStatements(entity, property)[0] ?? null;
}

/** Entity ids (Q-numbers) of all current statements, unique; the primary (preferred) value first. */
export function currentEntityIds(entity, property) {
  const ids = currentStatements(entity, property)
    .map((s) => valueOf(s)?.id)
    .filter(Boolean);
  return [...new Set(ids)];
}

/** The entity id of the single best current statement (a capital, a head of state), or null. */
export function bestEntityId(entity, property) {
  return currentEntityIds(entity, property)[0] ?? null;
}

function pointInTime(statement) {
  return statement.qualifiers?.[POINT_IN_TIME]?.[0]?.datavalue?.value?.time ?? null;
}

// Prefer the preferred rank; otherwise the most recently dated statement; otherwise the first listed.
// (Lexicographic order is chronological for Wikidata's "+YYYY-MM-DD..." times.)
function pickBest(statements) {
  if (statements.length === 0) return null;
  const preferred = statements.find((s) => s.rank === 'preferred');
  if (preferred) return preferred;
  const dated = statements.filter((s) => pointInTime(s));
  if (dated.length > 0) return dated.reduce((best, s) => (pointInTime(s) > pointInTime(best) ? s : best));
  return statements[0];
}

// ---- dates ---------------------------------------------------------------------------------------------

/**
 * A date statement, kept exactly as precise as Wikidata is: a full ISO date-time for a known day
 * ("1822-09-07T00:00:00Z"), "YYYY-MM" for a month, "YYYY" for a year or coarser. (Rendering a
 * year-only inception as "January 1, 1947" would invent a month and a day.) Null for dates before
 * year 1, which have no displayable form here.
 */
export function timeValue(entity, property) {
  const statement = bestStatement(entity, property);
  const value = statement ? valueOf(statement) : null;
  const match = /^\+?(\d{4,})-(\d{2})-(\d{2})T/.exec(value?.time ?? '');
  if (!match || (yearOfTime(value.time) ?? 0) < 1) return null;
  const [, year, month, day] = match;
  const precision = value.precision ?? (month === '00' ? 9 : day === '00' ? 10 : 11);
  if (precision <= 9) return year;
  const monthPart = month === '00' ? '01' : month;
  if (precision === 10) return `${year}-${monthPart}`;
  return `${year}-${monthPart}-${day === '00' ? '01' : day}T00:00:00Z`;
}

// ---- quantities ---------------------------------------------------------------------------------------

/** A country's area in km2. Statements in other units are ignored, never misread. */
export function areaKm2(entity) {
  const inKm2 = currentStatements(entity, 'P2046').filter((s) => valueOf(s)?.unit === KM2_UNIT);
  const best = pickBest(inKm2);
  return best ? Number(valueOf(best).amount) : null;
}

/** The current value of a quantity property (e.g. population, P1082) and the year it is for. */
export function latestQuantity(entity, property) {
  const best = pickBest(currentStatements(entity, property));
  if (!best) return null;
  const value = Number(valueOf(best)?.amount);
  if (!Number.isFinite(value)) return null;
  const year = yearOfTime(pointInTime(best));
  return { value, year: year != null && year >= 1 ? year : null };
}

// ---- media, text, coordinates, labels ---------------------------------------------------------------

/** The Commons file name of the best current media statement (e.g. a flag, P41), or null. */
export function commonsFile(entity, property) {
  const statement = bestStatement(entity, property);
  const value = statement ? valueOf(statement) : null;
  return typeof value === 'string' ? value : null;
}

/** A Commons file attached to a statement as a qualifier (Russia's anthem carries its recording that way). */
export function qualifierCommonsFile(statement, property) {
  const value = statement?.qualifiers?.[property]?.[0]?.datavalue?.value;
  return typeof value === 'string' ? value : null;
}

/** The English text of a monolingual-text property (e.g. the official name, P1448), or null. */
export function englishText(entity, property) {
  for (const statement of currentStatements(entity, property)) {
    const value = valueOf(statement);
    if (value?.language === 'en' && value.text) return value.text;
  }
  return null;
}

/** {lat, lng} of a coordinate property (P625), from an entity or a wbgetclaims result. */
export function coordinate(entity, property = 'P625') {
  const value = pickBest(currentStatements(entity, property));
  const point = value ? valueOf(value) : null;
  return point && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) ? { lat: point.latitude, lng: point.longitude } : null;
}

/** English label, else the English Wikipedia article title (a real, sourced name), else null. */
export function labelOf(entity) {
  return entity?.labels?.en?.value || entity?.sitelinks?.enwiki?.title || null;
}

// ---- time zones -------------------------------------------------------------------------------------

/** Minutes east of UTC for a label like "UTC+05:30" / "UTC−03:00" (Wikidata uses U+2212), else NaN. */
export function utcOffsetMinutes(label) {
  if (/^UTC$/.test(label ?? '')) return 0;
  const match = /^UTC([+−±-])(\d{1,2})(?::(\d{2}))?$/.exec(label ?? ''); // + − ± and a hyphen (last: elsewhere it reads as a range)
  if (!match) return Number.NaN;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === '+' || match[1] === '±' ? minutes : -minutes;
}

/**
 * West to east. Time-zone items are labeled in several ways ("UTC+01:00", "Central European Time",
 * "Europe/Vatican"); the app writes zones as UTC offsets, so when any label is an offset the named and
 * IANA duplicates are dropped. If none is an offset they are all kept, rather than showing nothing.
 */
export function sortTimeZones(labels) {
  const offsets = labels.filter((label) => !Number.isNaN(utcOffsetMinutes(label)));
  const kept = offsets.length > 0 ? offsets : labels;
  return [...kept].sort((a, b) => {
    const [oa, ob] = [utcOffsetMinutes(a), utcOffsetMinutes(b)];
    if (Number.isNaN(oa) || Number.isNaN(ob)) return 0;
    return oa - ob;
  });
}

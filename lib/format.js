const NUMBER_FORMAT = new Intl.NumberFormat('en-US');
// Dates from Wikidata and the local files are UTC calendar dates: formatting them in the reader's LOCAL
// time zone shows the previous day anywhere west of Greenwich (and a New Year's date as last December).
const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
const MONTH_FORMAT = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' });
const KM2_TO_MI2 = 0.386102;

export function formatNumber(value) {
  if (value == null || Number.isNaN(value)) return null;
  return NUMBER_FORMAT.format(value);
}

// "value unit (year)" — the shape the spec requires for every statistic.
export function formatStat(value, unit, year) {
  if (value == null) return 'Not available';
  const num = typeof value === 'number' ? formatNumber(value) : value;
  const withUnit = unit ? `${num} ${unit}` : num;
  return year ? `${withUnit} (${year})` : withUnit;
}

export function formatArea(km2) {
  if (km2 == null) return { km2: 'Not available', mi2: 'Not available' };
  const mi2 = km2 * KM2_TO_MI2;
  return {
    km2: `${formatNumber(Math.round(km2))} km²`,
    mi2: `${formatNumber(Math.round(mi2))} mi²`,
  };
}

/**
 * @param {string | null} value "1822-09-07T00:00:00Z" / "1947-08-15" (a day), "1500-05" (a month) or
 *   "1947" (a year): shown at exactly the precision it has.
 */
export function formatDate(value) {
  if (!value) return 'Not available';
  if (/^\d{4}$/.test(value)) return String(Number(value));
  const month = /^(\d{4})-(\d{2})$/.exec(value);
  if (month) return MONTH_FORMAT.format(new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1, 1)));
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return DATE_FORMAT.format(date);
}

export function formatList(items, { max = Infinity, emptyText = 'Not available' } = {}) {
  if (!items || items.length === 0) return emptyText;
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(', ')}, and ${rest} more` : shown.join(', ');
}

export function orNotAvailable(value) {
  if (value == null || value === '') return 'Not available';
  return value;
}

/**
 * "India (IND)": a country's name followed by its three-letter ISO code. Falls back to just the
 * code when there is no name yet, and never repeats the code when the name IS the code.
 */
export function formatCountryTitle(name, iso3) {
  const code = iso3 ? String(iso3).toUpperCase() : null;
  if (!name) return code ?? '';
  if (!code || name.toUpperCase() === code) return name;
  return `${name} (${code})`;
}

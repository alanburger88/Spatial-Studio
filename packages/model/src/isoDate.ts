/**
 * Calendar days as ISO 8601 text (`YYYY-MM-DD`), with no time of day, no time zone and no clock. Every date the engine
 * works with (the document's date, effective periods, date arithmetic in calculations) goes through these helpers, so
 * the browser, the server and the runnable package always agree. No `Date` and no `Intl`.
 */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days in a month of the proleptic Gregorian calendar. */
function monthLength(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** True for a real calendar day written as `YYYY-MM-DD` (years 1000 to 9999). */
export function isIsoDay(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = ISO_DAY.exec(v);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  return y >= 1000 && mo >= 1 && mo <= 12 && d >= 1 && d <= monthLength(y, mo);
}

/** The day as a whole number of days since 1970-01-01 (negative before). Throws on text that is not a day. */
export function dayNumber(iso: string): number {
  if (!isIsoDay(iso)) throw new Error(`Not a calendar day: ${iso}`);
  const [y0, m, d] = iso.split('-').map(Number);
  // Days from civil (H. Hinnant), exact for the whole range.
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The ISO day for a day number (see `dayNumber`). */
export function dayFromNumber(n: number): string {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The day `days` after (or, negative, before) `iso`. */
export function addDaysToIso(iso: string, days: number): string {
  return dayFromNumber(dayNumber(iso) + days);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetweenIso(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * A day in fixed studio English ("1 Jan 2027"), for explanations, findings and checks a person reads in the studio.
 * Not customer-visible document text: documents format dates with the formatters and the document language.
 */
export function dayWords(iso: string): string {
  if (!isIsoDay(iso)) return String(iso);
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
}

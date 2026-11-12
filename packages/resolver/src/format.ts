/** Locale-aware formatting at the presentation boundary. Arithmetic is always integer cents. */

function group3(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatCents(cents: number | null | undefined, _locale = 'en-US'): string {
  if (cents === null || cents === undefined || !Number.isInteger(cents)) return '';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toString();
  const rem = (abs % 100).toString().padStart(2, '0');
  return `${neg ? '−' : ''}$${group3(dollars)}.${rem}`;
}

const MONTHS: Record<string, string[]> = {
  'en-US': ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  'es-US': ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'],
};

export function formatDate(iso: string | null | undefined, locale = 'en-US'): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return String(iso);
  const month = (MONTHS[locale] ?? MONTHS['en-US'])[Number(m[2]) - 1];
  const day = Number(m[3]);
  return locale === 'es-US' ? `${day} ${month} ${m[1]}` : `${month} ${day}, ${m[1]}`;
}

export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  return (n < 0 ? '−' : '') + group3(Math.abs(Math.trunc(n)).toString());
}

export function formatValue(value: unknown, formatter: string | undefined, locale = 'en-US'): string {
  if (value === null || value === undefined) return '';
  switch (formatter) {
    case 'usd-cents': return typeof value === 'number' ? formatCents(value, locale) : String(value);
    case 'date': return formatDate(String(value), locale);
    case 'int': return typeof value === 'number' ? formatInt(value) : String(value);
    case 'points': return typeof value === 'number' ? `${formatInt(value)} pts` : String(value);
    case 'percent': return typeof value === 'number' ? `${value}%` : String(value);
    default:
      if (typeof value === 'boolean') return value ? (locale === 'es-US' ? 'Sí' : 'Yes') : 'No';
      return String(value);
  }
}

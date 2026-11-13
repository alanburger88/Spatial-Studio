/** Locale-aware formatting at the presentation boundary. Arithmetic is always integer cents. */

import { languageData } from '@iss/model';

function group3(digits: string, sep = ','): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** US-dollar amount in the conventions of the document language (separators and symbol position from the language table). */
export function formatCents(cents: number | null | undefined, locale = 'en-US'): string {
  if (cents === null || cents === undefined || !Number.isInteger(cents)) return '';
  const l = languageData(locale);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const n = `${group3(Math.floor(abs / 100).toString(), l.group)}${l.decimal}${(abs % 100).toString().padStart(2, '0')}`;
  return `${neg ? '−' : ''}${l.currencyFirst ? `$${l.gap}${n}` : `${n}${l.gap}$`}`;
}

/** Short date in the document language: month names and order come from the language table (CLDR). */
export function formatDate(iso: string | null | undefined, locale = 'en-US'): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return String(iso);
  const l = languageData(locale);
  return l.datePattern.replace('{d}', String(Number(m[3]))).replace('{m}', l.months[Number(m[2]) - 1]).replace('{y}', m[1]);
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

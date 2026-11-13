import { smsEncoding } from './sms';

/**
 * Makes a text message fit: a pure, conservative rewrite of the SMS TEMPLATE so that the message a customer receives
 * fits the wanted number of parts in the standard SMS alphabet (GSM-7). It proposes; a person accepts the result.
 *
 * What is never changed: `{{data}}` tokens and `{placeholders}`, web addresses, and wording written in capitals
 * (such as "THIS IS NOT A BILL" or its translation). No sentence is ever dropped.
 */

export interface SmsMeasure { length: number; segments: number; encoding: string }
export interface SmsFit { text: string; changes: string[]; before: SmsMeasure; after: SmsMeasure; fits: boolean }

/** Parts of the template that must reach the customer exactly as written. */
const PROTECTED = new RegExp([
  String.raw`\{\{[^{}]*\}\}`, // data tokens
  String.raw`\{\w+\}`, // placeholders of fixed wording
  String.raw`\b[hH][tT][tT][pP][sS]?:\/\/[^\s<>"]+`, // web addresses
  String.raw`\b[wW]{3}\.[^\s<>"]+`,
  String.raw`\b[\w-]+(?:\.[\w-]+)*\.[a-zA-Z]{2,}\/[^\s<>"]*`, // example.com/path
  String.raw`(?<![\p{L}\p{N}])\p{Lu}[\p{Lu}'’]*(?:[ \u00A0]+\p{Lu}[\p{Lu}'’]*){2,}(?![\p{L}\p{N}])[.!]?`, // three or more words in capitals
].join('|'), 'gu');

type Piece = { text: string; locked: boolean };

function pieces(template: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of template.matchAll(PROTECTED)) {
    const at = m.index ?? 0;
    // A web address does not include the full stop or comma that ends the sentence around it.
    const raw = m[0];
    const isAddress = !raw.startsWith('{') && /^(?:https?:\/\/|www\.|[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\/)/i.test(raw);
    const trimmed = isAddress ? raw.replace(/[.,;:!?)]+$/, '') : raw;
    if (at > last) out.push({ text: template.slice(last, at), locked: false });
    out.push({ text: trimmed, locked: true });
    last = at + trimmed.length;
  }
  if (last < template.length) out.push({ text: template.slice(last), locked: false });
  return out;
}

const join = (ps: Piece[]): string => ps.map((p) => p.text).join('');
/** Applies `fn` to the free wording only, piece by piece. */
const rewrite = (template: string, fn: (free: string) => string): string => join(pieces(template).map((p) => (p.locked ? p : { ...p, text: fn(p.text) })));

const isGsm = (ch: string): boolean => smsEncoding(ch).encoding === 'GSM-7';

/* ------------------------------------------------------------------ step 1: typographic characters */

const TYPOGRAPHIC: Array<{ re: RegExp; to: string; what: string }> = [
  { re: /[‘’‚‛′´`]/g, to: "'", what: 'curly apostrophes and single quotes with straight ones' },
  { re: /[“”„‟″«»]/g, to: '"', what: 'curly double quotes with straight ones' },
  { re: /[‐‑‒–—―−]/g, to: '-', what: 'long dashes with hyphens' },
  { re: /…/g, to: '...', what: 'the single “…” character with three full stops' },
  { re: /[  -   　]/g, to: ' ', what: 'non-breaking and special spaces with ordinary spaces' },
  { re: /[•‣◦⁃∙·]/g, to: '-', what: 'bullets with hyphens' },
  { re: /[​-‍⁠﻿­]/g, to: '', what: 'invisible characters with nothing' },
];

/* ------------------------------------------------------------------ step 2: accents outside the SMS alphabet */

const PLAIN: Record<string, string> = {
  á: 'a', â: 'a', ã: 'a', ā: 'a', ă: 'a', ą: 'a', Á: 'A', À: 'A', Â: 'A', Ã: 'A', Ā: 'A', Ă: 'A', Ą: 'A',
  ç: 'c', ć: 'c', č: 'c', Ć: 'C', Č: 'C', ď: 'd', Ď: 'D', đ: 'd', Đ: 'D',
  ê: 'e', ë: 'e', ē: 'e', ė: 'e', ę: 'e', ě: 'e', È: 'E', Ê: 'E', Ë: 'E', Ē: 'E', Ė: 'E', Ę: 'E', Ě: 'E',
  ğ: 'g', Ğ: 'G', í: 'i', î: 'i', ï: 'i', ī: 'i', į: 'i', ı: 'i', Í: 'I', Ì: 'I', Î: 'I', Ï: 'I', Ī: 'I', İ: 'I',
  ł: 'l', Ł: 'L', ľ: 'l', Ľ: 'L', ń: 'n', ň: 'n', Ń: 'N', Ň: 'N',
  ó: 'o', ô: 'o', õ: 'o', ő: 'o', ō: 'o', Ó: 'O', Ò: 'O', Ô: 'O', Õ: 'O', Ő: 'O', Ō: 'O',
  ř: 'r', Ř: 'R', ś: 's', š: 's', ş: 's', ș: 's', Ś: 'S', Š: 'S', Ş: 'S', Ș: 'S', ť: 't', ț: 't', Ť: 'T', Ț: 'T',
  ú: 'u', û: 'u', ū: 'u', ů: 'u', ű: 'u', ų: 'u', Ú: 'U', Ù: 'U', Û: 'U', Ū: 'U', Ů: 'U', Ű: 'U', Ų: 'U',
  ý: 'y', ÿ: 'y', Ý: 'Y', Ÿ: 'Y', ź: 'z', ż: 'z', ž: 'z', Ź: 'Z', Ż: 'Z', Ž: 'Z',
  œ: 'oe', Œ: 'OE', ð: 'd', Ð: 'D', þ: 'th', Þ: 'Th',
};

function plainLetter(ch: string): string | null {
  const mapped = PLAIN[ch];
  if (mapped !== undefined) return mapped;
  // Any other letter with an accent: keep the base letter when the SMS alphabet has it.
  const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return base && base !== ch && [...base].every(isGsm) ? base : null;
}

/* ------------------------------------------------------------------ step 4: English shortenings */

const EN_WORDS = new Set(['the', 'your', 'you', 'is', 'are', 'and', 'for', 'to', 'of', 'this', 'by', 'on', 'due', 'ready', 'not', 'has', 'have', 'with', 'our', 'we', 'will', 'please', 'new', 'now', 'from', 'at', 'it', 'if', 'or', 'be', 'can']);
const OTHER_WORDS = new Set(['su', 'sus', 'el', 'la', 'los', 'las', 'de', 'del', 'que', 'es', 'una', 'un', 'para', 'con', 'por', 'ya', 'se', 'usted', 'le', 'les', 'et', 'est', 'votre', 'pour', 'avec', 'der', 'die', 'das', 'und', 'ist', 'ihr', 'ihre', 'nicht', 'mit', 'sua', 'seu', 'com', 'em', 'um', 'uma', 'het', 'een', 'van', 'uw', 'il', 'di', 'che', 'per', 'non']);

/** Conservative: the free wording must show at least two different common English words and no sign of another language. */
function looksEnglish(template: string): boolean {
  const free = pieces(template).filter((p) => !p.locked).map((p) => p.text).join(' ');
  if (/[¿¡ñÑßáéíóúàèùâêîôûäëïöüçãõ]/i.test(free)) return false;
  const words = (free.toLowerCase().match(/[a-z']+/g) ?? []);
  const en = new Set(words.filter((w) => EN_WORDS.has(w)));
  const other = words.filter((w) => OTHER_WORDS.has(w)).length;
  return en.size >= 2 && other === 0;
}

/** Shortenings a customer reads without effort. Each is tried in this order and only while the message is still too long. */
const SHORTENINGS: Array<{ re: RegExp; to: (m: string) => string; note: string }> = [
  { re: /\b(do|does|did|is|are|was|were|has|have|had|would|should|could) not\b/gi, to: (m) => `${m.slice(0, -4)}n't`, note: 'Used short forms such as “isn’t” and “don’t”' },
  { re: /\bcannot\b/gi, to: (m) => `${m.slice(0, 3)}'t`, note: 'Shortened “cannot” to “can’t”' },
  { re: /\b(you|we|they) are\b/gi, to: (m) => `${m.slice(0, -4)}'re`, note: 'Used short forms such as “you’re”' },
  { re: /\b(you|we|they|I) have\b/g, to: (m) => `${m.slice(0, -5)}'ve`, note: 'Used short forms such as “we’ve”' },
  { re: /\b(it|that) is\b/gi, to: (m) => `${m.slice(0, -3)}'s`, note: 'Used the short form “it’s”' },
  { re: / and /g, to: () => ' & ', note: 'Replaced “and” with “&”' },
  { re: /\b[Mm]inimum\b/g, to: (m) => (m[0] === 'M' ? 'Min' : 'min'), note: 'Shortened “minimum” to “min”' },
  { re: /\b[Mm]aximum\b/g, to: (m) => (m[0] === 'M' ? 'Max' : 'max'), note: 'Shortened “maximum” to “max”' },
  { re: /\b[Ii]nformation\b/g, to: (m) => (m[0] === 'I' ? 'Info' : 'info'), note: 'Shortened “information” to “info”' },
];

/* ------------------------------------------------------------------ fit */

/**
 * Tries, in order and only as far as needed: plain typographic characters, accents the SMS alphabet lacks, extra spaces
 * and repeated punctuation, and (English only) a few common short forms. `sample` fills the tokens with the longest
 * realistic values so the measurement is of the message a customer would get; without it the template itself is measured.
 */
export function fitSms(text: string, opts: { maxSegments?: number; sample?: (template: string) => string } = {}): SmsFit {
  const maxSegments = Math.max(1, Math.floor(opts.maxSegments ?? 1));
  const measure = (template: string): SmsMeasure => {
    const e = smsEncoding(opts.sample ? opts.sample(template) : template);
    return { length: e.length, segments: e.segments, encoding: e.encoding };
  };
  const fitsNow = (m: SmsMeasure): boolean => m.encoding === 'GSM-7' && m.segments <= maxSegments;

  const before = measure(text);
  const changes: string[] = [];
  let current = text;
  const done = (): SmsFit => { const after = measure(current); return { text: current, changes, before, after, fits: fitsNow(after) }; };
  if (fitsNow(before)) return done();

  // 1. Typographic characters that force the long (UCS-2) encoding.
  for (const t of TYPOGRAPHIC) {
    const next = rewrite(current, (free) => free.replace(t.re, t.to));
    if (next !== current) { current = next; changes.push(`Replaced ${t.what}`); }
  }
  if (fitsNow(measure(current))) return done();

  // 2. Accents on letters the SMS alphabet does not have (á, í, ó, ú …). Letters it does have (ñ, é, ü …) stay.
  const swapped = new Map<string, string>();
  const kept = new Set<string>();
  const unaccented = rewrite(current, (free) => [...free].map((ch) => {
    if (isGsm(ch)) { if (/[^\u0000-\u007f]/.test(ch) && /\p{L}/u.test(ch)) kept.add(ch); return ch; }
    const plain = plainLetter(ch);
    if (plain === null) return ch;
    swapped.set(ch, plain);
    return plain;
  }).join(''));
  if (unaccented !== current) {
    current = unaccented;
    const pairs = [...swapped].slice(0, 6).map(([a, b]) => `${a} to ${b}`).join(', ');
    changes.push(`Removed accents the standard SMS alphabet does not have (${pairs}${swapped.size > 6 ? ' and others' : ''})${kept.size ? `; ${[...kept].slice(0, 6).join(', ')} stayed because the alphabet has ${kept.size === 1 ? 'it' : 'them'}` : ''}`);
  }
  if (fitsNow(measure(current))) return done();

  // 3. Extra spaces and repeated punctuation.
  const spaced = rewrite(current, (free) => free.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,])/g, '$1').replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n'));
  const tidy = spaced.replace(/^[ \t]+|[ \t]+$/g, '');
  if (tidy !== current) { current = tidy; changes.push('Removed extra spaces'); }
  const once = rewrite(current, (free) => free.replace(/([!?,;:])\1+/g, '$1').replace(/\.{2,}/g, '.').replace(/([!?])[!?]+/g, '$1'));
  if (once !== current) { current = once; changes.push('Removed repeated punctuation'); }
  if (fitsNow(measure(current))) return done();

  // 4. Common English short forms, only for English wording and only as far as they help: up to the first one that makes
  // the message fit, or (when nothing makes it fit) up to the one that saves a whole part. Otherwise the wording is left alone.
  const base = measure(current);
  if (base.encoding === 'GSM-7' && looksEnglish(current)) {
    const tried: Array<{ text: string; note: string; m: SmsMeasure }> = [];
    let t = current;
    for (const s of SHORTENINGS) {
      const next = rewrite(t, (free) => free.replace(s.re, s.to));
      if (next === t) continue;
      t = next;
      tried.push({ text: t, note: s.note, m: measure(t) });
      if (fitsNow(tried[tried.length - 1].m)) break;
    }
    let upto = tried.findIndex((x) => fitsNow(x.m));
    if (upto < 0 && tried.length) {
      const fewest = Math.min(...tried.map((x) => x.m.segments));
      upto = fewest < base.segments ? tried.findIndex((x) => x.m.segments === fewest) : -1;
    }
    for (let i = 0; i <= upto; i++) { current = tried[i].text; changes.push(tried[i].note); }
  }
  return done();
}

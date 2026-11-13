import type { Project } from '@iss/model';
import type { Resolution } from '@iss/resolver';
import { formatCents } from '@iss/resolver';
import { extractChannelFacts, fillChannelText, notABillPhrase, NOT_DETERMINED, type ChannelFacts, type EmailRender } from './email';

export const SMS_RENDERER_VERSION = 'sms-renderer/1';

/** GSM 03.38 basic character set (single septet) and extension table (two septets). */
const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '\f^{}\\[~]|€';
const BASIC = new Set([...GSM_BASIC]);
const EXT = new Set([...GSM_EXT]);

export interface NonGsmChar { char: string; index: number; codePoint: string }
export interface SmsEncoding { encoding: 'GSM-7' | 'UCS-2'; length: number; segments: number; perSegment: number; nonGsm: NonGsmChar[] }

/** GSM-7 vs UCS-2, unit length and segment count (160/153 GSM-7, 70/67 UCS-2). */
export function smsEncoding(text: string): SmsEncoding {
  const nonGsm: NonGsmChar[] = [];
  let septets = 0; let idx = 0;
  for (const ch of text) {
    if (BASIC.has(ch)) septets += 1;
    else if (EXT.has(ch)) septets += 2;
    else nonGsm.push({ char: ch, index: idx, codePoint: 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0') });
    idx += ch.length;
  }
  if (!nonGsm.length) {
    const segments = septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153);
    return { encoding: 'GSM-7', length: septets, segments, perSegment: segments > 1 ? 153 : 160, nonGsm };
  }
  const units = text.length; // UTF-16 code units, as billed
  const segments = units <= 70 ? 1 : Math.ceil(units / 67);
  return { encoding: 'UCS-2', length: units, segments, perSegment: segments > 1 ? 67 : 70, nonGsm };
}

export interface SmsRender {
  text: string; encoding: 'GSM-7' | 'UCS-2'; length: number; segments: number; perSegment: number;
  nonGsm: NonGsmChar[]; warnings: string[]; facts: ChannelFacts; renderer: string; lang: string;
}

export function smsText(f: ChannelFacts): string {
  if (f.texts) return fillChannelText(f.texts.sms, f);
  const url = f.actions[0]?.url;
  if (f.documentType === 'eob') {
    return `DEMO ${f.issuer}: Your Explanation of Benefits${f.claimId ? ` for claim ${f.claimId}` : ''} is ready. THIS IS NOT A BILL.${url ? ` Details: ${url}` : ''}`;
  }
  const bal = f.keyFacts.find((k) => k.nodeId === 'billing-summary');
  const due = f.keyFacts.find((k) => k.nodeId === 'payment-due');
  const bits = [bal ? `New balance ${bal.display}` : '', due ? `minimum due ${due.display}${f.dueDate ? ` by ${f.dueDate.display}` : ''}` : ''].filter(Boolean).join('; ');
  return `DEMO ${f.issuer}: Your statement is ready.${bits ? ` ${bits}.` : ''}${url ? ` ${url}` : ''}`;
}

export function renderSms(res: Resolution, project: Project): SmsRender {
  const facts = extractChannelFacts(res, project);
  const text = smsText(facts);
  const enc = smsEncoding(text);
  const warnings: string[] = [];
  if (res.findings.some((x) => x.severity === 'blocking')) warnings.push('Blocking findings in this run — treat this message as a draft.');
  if (enc.encoding === 'UCS-2') warnings.push(`Non-GSM character${enc.nonGsm.length > 1 ? 's' : ''} ${[...new Set(enc.nonGsm.map((n) => `“${n.char}” (${n.codePoint})`))].join(', ')} force UCS-2 encoding: ${enc.perSegment === 70 ? '70' : '67'} characters per segment instead of ${enc.perSegment === 160 ? '160' : '153'}.`);
  if (enc.segments > 2) warnings.push(`${enc.segments} segments: messages above 2 segments cost more and are more likely to be split or dropped.`);
  if (!facts.actions.length) warnings.push('No https action link in the model; the message has no link.');
  if (facts.lang !== 'en-US' && (res.translation?.missing ?? []).includes('@sms/text')) warnings.push(`The SMS message has no approved ${facts.lang} text; the English wording is shown. Amounts and dates are ${facts.lang}-formatted.`);
  if ((res.translation?.draftsShown ?? []).includes('@sms/text')) warnings.push('This preview shows an unapproved translation draft of the SMS message.');
  return { text, encoding: enc.encoding, length: enc.length, segments: enc.segments, perSegment: enc.perSegment, nonGsm: enc.nonGsm, warnings, facts, renderer: SMS_RENDERER_VERSION, lang: facts.lang };
}

/* ------------------------------------------------------------------ parity */

export interface ChannelParityCheck { id: string; label: string; status: 'match' | 'mismatch' | 'not-applicable'; blocking: boolean; expected?: unknown; email?: unknown; sms?: unknown; note?: string }
export interface ChannelParityReport { ok: boolean; checks: ChannelParityCheck[] }

/** Strip tags/entities enough to search rendered email HTML for literal fact strings. */
const htmlToPlain = (h: string) => h.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/**
 * Compares what the email (HTML + text) and SMS actually contain against the semantic manifest:
 * money strings, dates, guarded liability, selected variants, disclosures, action URLs, NOT A BILL.
 */
export function checkChannelParity(res: Resolution, email: EmailRender, sms: SmsRender): ChannelParityReport {
  const m = res.semanticManifest;
  const eh = htmlToPlain(email.html);
  const et = email.text;
  const checks: ChannelParityCheck[] = [];
  const add = (c: ChannelParityCheck) => checks.push(c);

  // money: every key fact with cents must equal the manifest's formatted value and be present in HTML + text.
  const money = email.facts.keyFacts.filter((k) => k.cents !== undefined);
  const moneyBad: string[] = [];
  for (const k of money) {
    const want = formatCents(m.money[k.nodeId], res.locale);
    if (m.money[k.nodeId] !== k.cents || k.display !== want || !eh.includes(want) || !et.includes(want)) moneyBad.push(`${k.nodeId}: ${want}`);
  }
  add({ id: 'money', label: 'Amounts equal the manifest (email HTML + text)', status: money.length ? (moneyBad.length ? 'mismatch' : 'match') : 'not-applicable', blocking: true, expected: Object.fromEntries(money.map((k) => [k.nodeId, formatCents(m.money[k.nodeId], res.locale)])), email: moneyBad.length ? { missing: moneyBad } : 'present' });

  // dates
  const due = email.facts.dueDate;
  if (due) {
    const ok = eh.includes(due.display) && et.includes(due.display) && sms.text.includes(due.display);
    add({ id: 'dates', label: 'Due date string in email and SMS', status: ok ? 'match' : 'mismatch', blocking: true, expected: due.display, email: eh.includes(due.display) && et.includes(due.display), sms: sms.text.includes(due.display) });
  } else add({ id: 'dates', label: 'Due date string in email and SMS', status: 'not-applicable', blocking: false });

  // SMS amounts (card only)
  const smsMoney = email.facts.documentType === 'eob' ? [] : money.filter((k) => k.nodeId === 'billing-summary' || k.nodeId === 'payment-due');
  if (smsMoney.length) {
    const miss = smsMoney.filter((k) => !sms.text.includes(formatCents(m.money[k.nodeId], res.locale)));
    add({ id: 'sms-money', label: 'SMS amounts equal the manifest', status: miss.length ? 'mismatch' : 'match', blocking: true, expected: Object.fromEntries(smsMoney.map((k) => [k.nodeId, formatCents(m.money[k.nodeId], res.locale)])), sms: miss.length ? { missing: miss.map((k) => k.nodeId) } : 'present' });
  } else add({ id: 'sms-money', label: 'SMS amounts equal the manifest', status: 'not-applicable', blocking: false });

  // guarded liability
  if (m.guardedLiabilityNodeIds.length) {
    const guarded = email.facts.keyFacts.filter((k) => m.guardedLiabilityNodeIds.includes(k.nodeId));
    const shownOk = guarded.every((k) => et.includes(`${k.label}: ${NOT_DETERMINED}`) && eh.includes(NOT_DETERMINED));
    const leaked = guarded.some((k) => new RegExp(`${k.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: \\$`).test(et));
    add({ id: 'member-liability', label: 'Unconfirmed member liability is never shown as an amount', status: shownOk && !leaked && !/\$/.test(sms.text) ? 'match' : 'mismatch', blocking: true, expected: m.guardedLiabilityNodeIds, email: { shownAsUnderReview: shownOk, leakedAmount: leaked }, sms: { containsAmount: /\$/.test(sms.text) } });
  } else add({ id: 'member-liability', label: 'Unconfirmed member liability is never shown as an amount', status: 'not-applicable', blocking: false });

  // not a bill: the banner wording of the document language must appear in the email (HTML and text) and in the SMS
  if (email.facts.notABill) {
    const phrase = notABillPhrase(email.facts);
    const ok = et.includes(phrase) && eh.includes(phrase) && sms.text.toLocaleUpperCase().includes(phrase.toLocaleUpperCase());
    add({ id: 'not-a-bill', label: `${phrase} in email and SMS`, status: ok ? 'match' : 'mismatch', blocking: true, expected: true });
  } else add({ id: 'not-a-bill', label: 'THIS IS NOT A BILL in email and SMS', status: 'not-applicable', blocking: false });

  // selected variants: manifest-selected variants' titles appear in the email.
  const sel = Object.entries(m.selectedVariants).filter(([, v]) => v);
  const titles = new Map(email.facts.sections.map((s) => [s.nodeId, s.title]));
  const varBad = sel.filter(([node]) => titles.has(node) && !(eh.includes(titles.get(node)!) && et.includes(titles.get(node)!))).map(([n]) => n);
  const covered = sel.filter(([node]) => titles.has(node));
  add({ id: 'selected-variants', label: 'Selected variant messages present', status: covered.length ? (varBad.length ? 'mismatch' : 'match') : 'not-applicable', blocking: true, expected: Object.fromEntries(covered.map(([n, v]) => [n, v])), email: varBad.length ? { missing: varBad } : 'present' });

  // disclosures
  const discBad = email.facts.disclosures.filter((d) => { const t = htmlToPlain(d.blocks.map((b) => (b.inlines ?? []).map((i) => i.text).join('')).join(' ')).trim(); return t && !(d.banner ? true : eh.includes(t.slice(0, 40)) && et.includes(t.slice(0, 40))); }).map((d) => d.nodeId);
  add({ id: 'disclosures', label: 'Mandatory disclosure text present', status: m.disclosures.length ? (discBad.length ? 'mismatch' : 'match') : 'not-applicable', blocking: true, expected: m.disclosures.map((d) => `${d.contentPartId} v${d.version}`), email: discBad.length ? { missing: discBad } : 'present' });

  // actions
  const urls = m.actions.map((a) => a.url).filter((u) => /^https:\/\//.test(u));
  const urlBad = urls.filter((u) => !email.html.includes(`href="${u}"`) || !et.includes(u));
  add({ id: 'actions', label: 'Action links (https) present', status: urls.length ? (urlBad.length ? 'mismatch' : 'match') : 'not-applicable', blocking: false, expected: urls, email: urlBad.length ? { missing: urlBad } : 'present', sms: urls.length ? urls.every((u) => sms.text.includes(u)) ? 'present' : 'primary link only' : undefined });

  return { ok: !checks.some((c) => c.status === 'mismatch' && c.blocking), checks };
}

import type { Project } from '@iss/model';
import type { ChannelTexts, RBlock, RInline, RNode, Resolution } from '@iss/resolver';
import { formatCents } from '@iss/resolver';
import { esc, imageSrc } from './html-common';

/**
 * Email channel: renders the SAME resolved semantic tree as PDF/HTML into an email-client-safe,
 * single-column, inline-styled document plus a plain-text alternative. Every fact (amounts, dates,
 * member liability, selected variants, disclosures, action URLs) is copied from the resolved tree;
 * nothing is invented. Channel chrome (greeting verb, section labels, subject template) is English
 * only because the model has no approved translation for it, and that is surfaced as a warning.
 */
export const EMAIL_RENDERER_VERSION = 'email-renderer/1';
export const SYNTHETIC_CUE = 'Synthetic demonstration data — not a real statement or claim.';
export const NOT_DETERMINED = 'Not determined — under review';
const TABLE_INLINE_MAX_ROWS = 10;

export interface ChannelFact { nodeId: string; label: string; display: string; cents?: number; guarded: boolean }
export interface ChannelSection { nodeId: string; title: string; blocks: RBlock[]; missingLocale: boolean }
export interface ChannelAction { nodeId: string; label: string; url: string }
export interface ChannelDisclosure { nodeId: string; contentPartId: string; version: number; title: string; blocks: RBlock[]; banner: boolean }
export interface ChannelSummaryLine { nodeId: string; kind: 'table' | 'chart' | 'explanation'; text: string }
export interface ChannelTable { nodeId: string; caption: string; columns: Array<{ label: string; align?: string }>; rows: string[][]; totalDisplay?: string }

/** Channel-neutral facts extracted once from a resolution; email and SMS both render from this. */
export interface ChannelFacts {
  issuer: string; product: string; accent: string; lang: string; documentType: string;
  customerName: string; logo: { src: string; alt: string } | null;
  notABill: boolean; claimId?: string; dueDate?: ChannelFact;
  keyFacts: ChannelFact[]; greeting: RBlock[]; sections: ChannelSection[]; actions: ChannelAction[];
  disclosures: ChannelDisclosure[]; summaries: ChannelSummaryLine[]; tables: ChannelTable[];
  /** Editable, translated wording (subject, preview text, heading, opening, closing, SMS) and the email section choices. */
  texts?: ChannelTexts;
}

export interface EmailRender {
  subject: string; preheader: string; html: string; text: string; warnings: string[]; lang: string;
  facts: ChannelFacts; renderer: string;
}

function walk(n: RNode, f: (n: RNode) => void) { if (!n.visible) return; f(n); n.children.forEach((c) => walk(c, f)); }

export function blocksText(blocks: RBlock[] | undefined): string {
  const inl = (xs: RInline[] = []) => xs.map((i) => (i.kind === 'break' ? ' ' : i.href && /^https:\/\//.test(i.href) ? `${i.text} (${i.href})` : i.text)).join('');
  return (blocks ?? []).map((b) => (b.kind === 'ul' || b.kind === 'ol' ? (b.items ?? []).map((it, k) => `${b.kind === 'ol' ? `${k + 1}.` : '-'} ${inl(it)}`).join('\n') : inl(b.inlines))).join('\n');
}

const isHttps = (u: string | undefined): u is string => !!u && /^https:\/\/[^\s"'<>]+$/.test(u);
const safeAccent = (a: string | undefined) => (a && /^#[0-9a-fA-F]{6}$/.test(a) ? a : '#277656');

export function extractChannelFacts(res: Resolution, project: Project): ChannelFacts {
  const isEob = project.documentType === 'eob';
  const nodes = new Map<string, RNode>();
  const ordered: RNode[] = [];
  walk(res.root, (n) => { nodes.set(n.id, n); ordered.push(n); });
  const accent = safeAccent(project.issuer?.accent);
  const fact = (id: string): ChannelFact | undefined => {
    const f = nodes.get(id)?.field; if (!f) return undefined;
    return { nodeId: id, label: f.label, display: f.display, ...(f.cents !== undefined ? { cents: f.cents } : {}), guarded: !!f.guarded };
  };
  const keyIds = isEob ? ['claim-identifiers', 'plan-paid', 'member-responsibility'] : ['billing-summary', 'payment-due', 'payment-due-date'];
  let keyFacts = keyIds.map(fact).filter((x): x is ChannelFact => !!x);
  if (!keyFacts.length) keyFacts = ordered.filter((n) => n.type === 'summary-metric').slice(0, 3).map((n) => fact(n.id)!).filter(Boolean);
  const logoNode = nodes.get('issuer-logo')?.image ?? ordered.find((n) => n.type === 'image')?.image;
  const logoSrc = logoNode ? imageSrc(logoNode.src, accent) : null;

  const sections: ChannelSection[] = [];
  const disclosures: ChannelDisclosure[] = [];
  const actions: ChannelAction[] = [];
  const summaries: ChannelSummaryLine[] = [];
  const tables: ChannelTable[] = [];
  for (const n of ordered) {
    if (n.type === 'variant-set' || n.type === 'conditional-region') {
      const sel = n.variants?.unresolved ? [] : (n.variants?.items.filter((i) => i.selected) ?? []);
      if (sel.length) sections.push({ nodeId: n.id, title: sel.map((s) => s.title).join(' · '), blocks: n.text ?? sel.flatMap((s) => s.text), missingLocale: sel.some((s) => s.missingLocale) });
    } else if (n.type === 'disclosure' && n.disclosure) {
      disclosures.push({ nodeId: n.id, contentPartId: n.disclosure.contentPartId, version: n.disclosure.version, title: n.disclosure.title, blocks: n.text ?? [], banner: n.disclosure.contentPartId === 'not-a-bill-banner' });
    } else if (n.type === 'action-link' && n.action && isHttps(n.action.url)) {
      actions.push({ nodeId: n.id, label: n.action.label, url: n.action.url });
    } else if (n.type === 'repeating-table' && n.table) {
      const t = n.table;
      const total = t.totalCents !== undefined ? formatCents(t.totalCents, res.locale) : undefined;
      if (t.rows.length > TABLE_INLINE_MAX_ROWS) {
        summaries.push({ nodeId: n.id, kind: 'table', text: `${t.caption}: ${t.rows.length} items${total ? `, total ${total}` : ''}. The full list is not shown in this email — open the interactive statement for every row.` });
      } else if (t.rows.length) {
        tables.push({ nodeId: n.id, caption: t.caption, columns: t.columns.map((c) => ({ label: c.label, align: c.align })), rows: t.rows.map((r) => t.columns.map((c) => r.cells[c.key]?.display ?? '')), ...(total ? { totalDisplay: total } : {}) });
      }
    } else if (n.type === 'chart' && n.chart) {
      summaries.push({ nodeId: n.id, kind: 'chart', text: n.chart.summary });
    } else if (n.type === 'expandable-explanation' && n.explanation) {
      summaries.push({ nodeId: n.id, kind: 'explanation', text: `${n.explanation.title}: ${n.explanation.summary}` });
    }
  }
  const claimId = res.result.documentFacts.claimId;
  return {
    issuer: project.issuer?.name ?? 'Issuer', product: project.issuer?.product ?? project.issuer?.name ?? 'Issuer', accent, lang: res.locale || 'en-US', documentType: project.documentType,
    customerName: String(res.semanticManifest.identity.name ?? ''),
    logo: logoSrc && logoNode ? { src: logoSrc, alt: logoNode.alt } : null,
    notABill: isEob || res.result.documentFacts.notABill === true,
    ...(typeof claimId === 'string' ? { claimId } : {}),
    dueDate: fact('payment-due-date'),
    keyFacts, greeting: nodes.get('greeting')?.text ?? [], sections, actions, disclosures, summaries, tables,
    ...(res.channelTexts ? { texts: res.channelTexts } : {}),
  };
}

/** The "label: value" list of the key figures; an unconfirmed amount is never shown as a number. */
export const keyFactsLine = (f: ChannelFacts): string => f.keyFacts.map((k) => `${k.label}: ${k.guarded ? NOT_DETERMINED : k.display}`).join(' · ');

/**
 * Fills the two channel tokens the resolver leaves in place: `{{keyFacts}}` and `{{link}}` (the first https action link).
 * Without a link, the sentence part that holds the token is dropped, so no dangling "Details:" is left behind.
 */
export function fillChannelText(text: string, f: ChannelFacts): string {
  const url = f.actions[0]?.url;
  let t = text.replace(/\{\{\s*keyFacts\s*\}\}/g, keyFactsLine(f));
  t = url ? t.replace(/\{\{\s*link\s*\}\}/g, url) : t.replace(/\s*[^.!?]*\{\{\s*link\s*\}\}[^.!?]*/g, '');
  return t.replace(/[ \t]{2,}/g, ' ').trim();
}

/** The "not a bill" banner wording in the document language (the banner disclosure's own text), without closing punctuation. */
export function notABillPhrase(f: ChannelFacts): string {
  const banner = f.disclosures.find((d) => d.banner);
  const text = banner ? blocksText(banner.blocks).trim().replace(/[.!]+$/, '') : '';
  return text || 'THIS IS NOT A BILL';
}

export function emailSubject(f: ChannelFacts): string {
  if (f.texts) return fillChannelText(f.texts.subject, f);
  if (f.documentType === 'eob') return `Your ${f.issuer} Explanation of Benefits is ready — this is not a bill`;
  const due = f.keyFacts.find((k) => k.nodeId === 'payment-due');
  const date = f.dueDate;
  return `Your ${f.product} statement is ready${due ? ` — ${due.display} minimum due${date ? ` ${date.display}` : ''}` : ''}`;
}

export function emailPreheader(f: ChannelFacts): string {
  if (f.texts) return fillChannelText(f.texts.preheader, f).slice(0, 140);
  if (f.documentType === 'eob') return `THIS IS NOT A BILL. ${keyFactsLine(f)}`.slice(0, 140);
  return keyFactsLine(f).slice(0, 140);
}

const DEFAULT_SECTIONS: NonNullable<ChannelFacts['texts']>['sections'] = [{ id: 'keyFacts', show: true }, { id: 'messages', show: true }, { id: 'tables', show: true }, { id: 'summaries', show: true }, { id: 'actions', show: true }];
/** The generated email sections that are switched on, in the chosen order. */
export const emailSectionOrder = (f: ChannelFacts) => (f.texts?.sections ?? DEFAULT_SECTIONS).filter((x) => x.show).map((x) => x.id);

/* ------------------------------------------------------------------ HTML */

const FONT = `font-family:Arial,Helvetica,sans-serif;`;
const INK = '#1a202c';
const MUTED = '#4a5568';
const LINE = '#cbd5e0';

function inlinesEmail(xs: RInline[] | undefined, accent: string): string {
  return (xs ?? []).map((i) => {
    if (i.kind === 'break') return '<br>';
    let t = esc(i.text);
    if (i.bold || i.kind === 'token') t = `<strong>${t}</strong>`;
    if (i.italic) t = `<em>${t}</em>`;
    if (i.href && isHttps(i.href)) t = `<a href="${esc(i.href)}" style="color:${accent};text-decoration:underline;">${t}</a>`;
    return t;
  }).join('');
}

function blocksEmail(blocks: RBlock[] | undefined, accent: string): string {
  return (blocks ?? []).map((b) => {
    if (b.kind === 'ul' || b.kind === 'ol') return `<${b.kind} style="margin:0 0 12px 20px;padding:0;${FONT}font-size:15px;line-height:22px;color:${INK};">${(b.items ?? []).map((it) => `<li style="margin:0 0 4px;">${inlinesEmail(it, accent)}</li>`).join('')}</${b.kind}>`;
    if (b.kind === 'p') return `<p style="margin:0 0 12px;${FONT}font-size:15px;line-height:22px;color:${INK};">${inlinesEmail(b.inlines, accent)}</p>`;
    const size = b.kind === 'h2' ? 17 : 15;
    return `<${b.kind} style="margin:0 0 8px;${FONT}font-size:${size}px;line-height:22px;color:${INK};">${inlinesEmail(b.inlines, accent)}</${b.kind}>`;
  }).join('');
}

const row = (inner: string, pad = '0 24px 20px') => `<tr><td style="padding:${pad};">${inner}</td></tr>`;
const h2 = (t: string) => `<h2 style="margin:0 0 8px;${FONT}font-size:17px;line-height:24px;color:${INK};">${esc(t)}</h2>`;

export function emailHtml(f: ChannelFacts, subject: string, preheader: string): string {
  const A = f.accent;
  const parts: string[] = [];
  // header
  parts.push(`<tr><td style="padding:20px 24px;border-bottom:4px solid ${A};background-color:#ffffff;">${f.logo ? `<img src="${esc(f.logo.src)}" width="150" height="40" alt="${esc(f.logo.alt)}" style="display:block;border:0;outline:none;height:40px;width:150px;max-width:100%;">` : `<span style="${FONT}font-size:20px;font-weight:bold;color:${A};">${esc(f.issuer)}</span>`}</td></tr>`);
  const title = f.texts?.title || (f.documentType === 'eob' ? 'Your Explanation of Benefits is ready' : 'Your statement is ready');
  parts.push(row(`<h1 style="margin:0;${FONT}font-size:22px;line-height:28px;color:${INK};">${esc(title)}</h1>`, '24px 24px 12px'));
  if (f.notABill) {
    const banner = f.disclosures.find((d) => d.banner);
    parts.push(row(`<div role="note" style="border:2px solid ${INK};padding:10px 14px;${FONT}font-size:16px;line-height:22px;font-weight:bold;color:${INK};background-color:#fff8d6;">${banner ? blocksText(banner.blocks).split('\n').map(esc).join('<br>') : 'THIS IS NOT A BILL.'}</div>`, '0 24px 16px'));
  }
  // greeting
  parts.push(row(f.greeting.length ? blocksEmail(f.greeting, A) : `<p style="margin:0;${FONT}font-size:15px;line-height:22px;color:${INK};">Hello ${esc(f.customerName)},</p>`, '0 24px 16px'));
  // optional opening text
  if (f.texts?.intro.length) parts.push(row(blocksEmail(f.texts.intro, A), '0 24px 16px'));
  // generated sections, in the order chosen for the email
  for (const id of emailSectionOrder(f)) {
    if (id === 'keyFacts') {
    // key facts
    if (f.keyFacts.length) {
      const rows = f.keyFacts.map((k) => `<tr><td style="padding:10px 0;border-top:1px solid ${LINE};${FONT}font-size:14px;line-height:20px;color:${MUTED};">${esc(k.label)}</td><td align="right" style="padding:10px 0;border-top:1px solid ${LINE};${FONT}font-size:${k.guarded ? 14 : 18}px;line-height:22px;font-weight:bold;color:${INK};" data-fact="${esc(k.nodeId)}">${esc(k.guarded ? NOT_DETERMINED : k.display)}</td></tr>`).join('');
      parts.push(row(`${h2(f.texts?.keyFactsHeading || 'Key facts')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-bottom:1px solid ${LINE};">${rows}</table>`));
    }
    }
    if (id === 'messages') {
    // selected variants
    for (const s of f.sections) {
      parts.push(row(`<h2 style="margin:0 0 8px;${FONT}font-size:17px;line-height:24px;color:${INK};">${esc(s.title)}</h2>${blocksEmail(s.blocks, A)}${s.missingLocale ? `<p style="margin:0;${FONT}font-size:13px;color:${MUTED};">[Approved translation missing — English approved text shown]</p>` : ''}`));
    }
    }
    if (id === 'tables') {
    // small tables
    for (const t of f.tables) {
      const th = t.columns.map((c) => `<th scope="col" align="${c.align === 'right' ? 'right' : 'left'}" style="padding:6px 6px;border-bottom:2px solid ${INK};${FONT}font-size:13px;color:${INK};">${esc(c.label)}</th>`).join('');
      const body = t.rows.map((r) => `<tr>${r.map((c, i) => `<td align="${t.columns[i].align === 'right' ? 'right' : 'left'}" style="padding:6px;border-bottom:1px solid ${LINE};${FONT}font-size:13px;color:${INK};">${esc(c)}</td>`).join('')}</tr>`).join('');
      parts.push(row(`${h2(t.caption)}<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>${t.totalDisplay ? `<p style="margin:8px 0 0;${FONT}font-size:13px;color:${MUTED};">Total ${esc(t.totalDisplay)}</p>` : ''}`));
    }
    }
    if (id === 'summaries') {
    // interactive-only content becomes summary lines
    const lines = f.summaries;
    if (lines.length) parts.push(row(lines.map((s) => `<p style="margin:0 0 8px;${FONT}font-size:14px;line-height:20px;color:${MUTED};">${esc(s.text)}</p>`).join('')));
    }
    if (id === 'actions') {
    // actions
    for (const a of f.actions) {
      parts.push(row(`<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${A}" style="background-color:${A};border-radius:4px;"><a href="${esc(a.url)}" style="display:inline-block;padding:12px 20px;${FONT}font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">${esc(a.label)}</a></td></tr></table><p style="margin:8px 0 0;${FONT}font-size:12px;line-height:18px;color:${MUTED};">${esc(a.url)}</p>`));
    }
    }
  }
  // optional closing text
  if (f.texts?.closing.length) parts.push(row(blocksEmail(f.texts.closing, A)));
  // disclosures
  const disc = f.disclosures.filter((d) => !d.banner);
  if (disc.length) parts.push(row(`<div style="border-top:1px solid ${LINE};padding-top:16px;">${disc.map((d) => `<h3 style="margin:0 0 6px;${FONT}font-size:14px;line-height:20px;color:${INK};">${esc(d.title)}</h3><div style="${FONT}font-size:13px;line-height:19px;color:${MUTED};">${blocksEmail(d.blocks, A).replace(/font-size:15px;line-height:22px;color:#1a202c/g, `font-size:13px;line-height:19px;color:${MUTED}`)}</div>`).join('')}</div>`));
  // footer
  parts.push(`<tr><td style="padding:16px 24px;background-color:#edf2f7;${FONT}font-size:12px;line-height:18px;color:${MUTED};"><strong style="color:${INK};">DEMO DATA.</strong> ${esc(SYNTHETIC_CUE)}<br>Sent by ${esc(f.issuer)} (fictional).</td></tr>`);

  return `<!doctype html>
<html lang="${esc(f.lang)}" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(subject)}</title>
<style>body{margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}table{border-collapse:collapse}img{border:0}</style>
</head>
<body style="margin:0;padding:0;background-color:#f4f5f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f4f5f7;font-size:1px;line-height:1px;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f5f7" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:16px 8px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background-color:#ffffff;">
${parts.join('\n')}
</table>
</td></tr></table>
</body>
</html>`;
}

/* ------------------------------------------------------------------ text */

export function emailText(f: ChannelFacts, subject: string): string {
  const L: string[] = [];
  L.push(f.issuer.toUpperCase(), subject, '');
  if (f.notABill) L.push(`${notABillPhrase(f)}.`, '');
  L.push(f.greeting.length ? blocksText(f.greeting) : `Hello ${f.customerName},`, '');
  if (f.texts?.intro.length) L.push(blocksText(f.texts.intro), '');
  for (const id of emailSectionOrder(f)) {
    if (id === 'keyFacts') { if (f.keyFacts.length) { L.push((f.texts?.keyFactsHeading || 'Key facts').toUpperCase()); for (const k of f.keyFacts) L.push(`${k.label}: ${k.guarded ? NOT_DETERMINED : k.display}`); L.push(''); } }
    if (id === 'messages') { for (const s of f.sections) { L.push(`== ${s.title} ==`, blocksText(s.blocks), ""); } }
    if (id === 'tables') { for (const t of f.tables) { L.push(`== ${t.caption} ==`); L.push(t.columns.map((c) => c.label).join(' | ')); for (const r of t.rows) L.push(r.join(' | ')); if (t.totalDisplay) L.push(`Total ${t.totalDisplay}`); L.push(''); } }
    if (id === 'summaries') { for (const s of f.summaries) L.push(s.text); if (f.summaries.length) L.push(''); }
    if (id === 'actions') { for (const a of f.actions) L.push(`${a.label}: ${a.url}`); if (f.actions.length) L.push(''); }
  }
  if (f.texts?.closing.length) L.push(blocksText(f.texts.closing), '');
  for (const d of f.disclosures.filter((x) => !x.banner)) L.push(`== ${d.title} ==`, blocksText(d.blocks), "");
  L.push('--', `DEMO DATA. ${SYNTHETIC_CUE}`, `Sent by ${f.issuer} (fictional).`);
  return L.join('\n');
}

export function renderEmail(res: Resolution, project: Project): EmailRender {
  const facts = extractChannelFacts(res, project);
  const warnings: string[] = [];
  const blocking = res.findings.filter((x) => x.severity === 'blocking');
  if (blocking.length) warnings.push(`${blocking.length} blocking finding(s) in this run — treat this email as a draft.`);
  if (!facts.logo) warnings.push('No issuer image available; the issuer name is shown as text.');
  else warnings.push('The issuer logo is an embedded data-URI image; some email clients (e.g. Gmail) do not display data-URI SVG, so the alt text is the fallback.');
  const untranslated = (res.translation?.missing ?? []).filter((id) => id.startsWith('@email/'));
  if (facts.lang !== 'en-US' && untranslated.length) warnings.push(`${untranslated.length} piece${untranslated.length === 1 ? '' : 's'} of email wording ${untranslated.length === 1 ? 'has' : 'have'} no approved ${facts.lang} text; the English wording is shown.`);
  if ((res.translation?.draftsShown ?? []).length) warnings.push('This preview shows unapproved translation drafts. A clean export uses approved text only.');
  for (const s of facts.sections) if (s.missingLocale) warnings.push(`Section “${s.title}” has no approved ${facts.lang} text; English approved text is shown.`);
  for (const s of facts.summaries.filter((x) => x.kind === 'table')) warnings.push(`Table ${s.nodeId} is longer than ${TABLE_INLINE_MAX_ROWS} rows and is summarised, not listed.`);
  if (!facts.actions.length) warnings.push('No https action link in the model; the email has no call-to-action.');
  const subject = emailSubject(facts);
  const preheader = emailPreheader(facts);
  if (subject.length > 78) warnings.push(`Subject is ${subject.length} characters; many clients truncate after ~78.`);
  return { subject, preheader, html: emailHtml(facts, subject, preheader), text: emailText(facts, subject), warnings, lang: facts.lang, facts, renderer: EMAIL_RENDERER_VERSION };
}

import { describe, expect, it } from 'vitest';
import { blankProject, COMPONENT_CATALOG, defaultNode, type Project, type SyntheticRecord } from '@iss/model';
import { resolve } from '@iss/resolver';
import { afpSimulation, checkChannelParity, compareManifests, renderEmail, renderInteractiveHtml, renderPagedDocument, renderSms, type ExtractedManifest } from '@iss/renderers';
import { seedProjects, RECORDS } from '../../model/src/fixtures';
import { gymMember, gymProject, run, SAMPLE_WORDING, visibleText } from '../../model/test/helpers/customProject';

const outputs = (p: Project, record: SyntheticRecord) => {
  const res = resolve({ project: p, record });
  const email = renderEmail(res, p);
  const sms = renderSms(res, p);
  return { res, pages: renderPagedDocument(res, p), html: renderInteractiveHtml(res, p), email, sms, parity: checkChannelParity(res, email, sms) };
};
/** What a faithful output would be read back as: every fact of the resolver's manifest, the identity as shown. */
const faithful = (m: ReturnType<typeof resolve>['semanticManifest']): ExtractedManifest => ({ visibleNodeIds: m.visibleNodeIds, money: m.money, guardedLiabilityNodeIds: m.guardedLiabilityNodeIds, disclosures: m.disclosures, selectedVariants: m.selectedVariants, tableRows: m.tableRows, tableTotalsCents: m.tableTotalsCents, actions: m.actions, identity: m.identity });

describe('outputs of a document with its own data', () => {
  const p = gymProject();
  const o = outputs(p, gymMember({ custom: { tier: 'pro' } }));

  it('pages, web page, email and SMS all carry the customer’s own values', () => {
    for (const s of ['Hello', 'Robin', 'Okoye', 'Flex', '$49.00', 'Dec 1, 2026', 'Spin', 'Yoga', '$12.00', 'Nov 10, 2026', 'Pro members', 'priority booking', 'Booked sessions']) {
      expect(visibleText(o.pages), `pages: ${s}`).toContain(s);
      expect(visibleText(o.html), `web page: ${s}`).toContain(s);
    }
    // the list's total: the price column was marked to be summed
    expect(o.pages).toContain('data-table-total-cents="2100"');
    expect(visibleText(o.html)).toMatch(/Total price · 2 listed items\s+\$21\.00/);
    for (const s of ['Robin', '$49.00', 'Pro members', 'priority booking', 'Spin', 'Yoga', '$21.00']) { expect(o.email.text, `email text: ${s}`).toContain(s); expect(visibleText(o.email.html), `email: ${s}`).toContain(s); }
    expect(o.email.subject).toBe('Your Northside Gym document is ready');
    expect(o.email.preheader).toBe('Your Northside Gym document is ready. Monthly fee: $49.00');
    expect(o.email.facts.keyFacts).toEqual([{ nodeId: 'fee', label: 'Monthly fee', display: '$49.00', cents: 4900, guarded: false }]);
    expect(o.sms.text).toBe('DEMO Northside Gym: Your document is ready.');
    expect(o.sms).toMatchObject({ encoding: 'GSM-7', segments: 1 });
  });

  it('nothing a person reads mentions cards, claims, statements or bills, and nothing is left unfilled', () => {
    for (const [name, text] of Object.entries({ pages: visibleText(o.pages), web: visibleText(o.html), email: visibleText(o.email.html), emailText: o.email.text, subject: o.email.subject, preheader: o.email.preheader, sms: o.sms.text })) {
      expect(text.match(SAMPLE_WORDING)?.[0], name).toBeUndefined();
      expect(text, name).not.toMatch(/\{\{|\}\}/);
    }
    // the web page: neutral title, description and section name, and only the fixed wording of this kind travels with it
    expect(o.html).toContain('<title>Northside Gym — Membership notice (synthetic)</title>');
    expect(o.html).toMatch(/<h2 class="iss-sec-title" id="sec-data-h">Details<\/h2>/);
    const strings = JSON.parse(/<script type="application\/json" id="iss-strings">([\s\S]*?)<\/script>/.exec(o.html)![1]);
    expect(Object.keys(strings)).toContain('tableStatus');
    for (const k of ['sectionTransactions', 'sectionClaims', 'barNotBill', 'docTitleStatement', 'guardNotDetermined']) expect(Object.keys(strings)).not.toContain(k);
    // the bar shows the document's first main figure instead of a payment that is due
    expect(o.html).toMatch(/<span class="iss-bar-label">Monthly fee<\/span> <strong>\$49\.00<\/strong>/);
    expect(o.email.html).toContain('Synthetic demonstration data — not a real document.');
    expect(o.email.text).toContain('Synthetic demonstration data — not a real document.');
  });

  it('email and SMS agree with the resolved facts; the “not a bill” and amount-in-SMS checks do not apply', () => {
    expect(o.parity.ok).toBe(true);
    const status = Object.fromEntries(o.parity.checks.map((c) => [c.id, c.status]));
    expect(status).toEqual({ money: 'match', dates: 'not-applicable', 'sms-money': 'not-applicable', 'member-liability': 'not-applicable', 'not-a-bill': 'not-applicable', 'selected-variants': 'match', disclosures: 'not-applicable', actions: 'not-applicable' });
    expect(o.email.facts.notABill).toBe(false);
    expect(o.email.html).not.toMatch(/role="note"/);
  });

  it('an output that shows what was resolved passes the PDF/web comparison, including the identity as shown', () => {
    const report = compareManifests(o.res.semanticManifest, faithful(o.res.semanticManifest), faithful(o.res.semanticManifest));
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.id === 'identity')).toMatchObject({ status: 'match', expected: { name: 'Robin Okoye' } });
    // an output that lost the name is still caught
    expect(compareManifests(o.res.semanticManifest, { ...faithful(o.res.semanticManifest), identity: {} }).ok).toBe(false);
  });

  it('a long list is summarised in the email in neutral words, and a link fills the SMS', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ day: '2026-11-03', className: `Class ${i + 1}`, priceCents: 500, spots: 1 }));
    const withLink = run(p, { type: 'INSERT_NODE', node: defaultNode('action-link', 'manage', 'custom', p), parentId: 'doc-root' });
    const long = outputs(withLink, gymMember({ custom: { sessions: many } }));
    expect(long.email.text).toContain('Booked sessions: 14 items, total $70.00. The full list is not shown in this email — open the interactive document for every row.');
    expect(long.sms.text).toBe('DEMO Northside Gym: Your document is ready. Details: https://example.com/demo/options');
    expect(long.parity.ok).toBe(true);
    expect(visibleText(long.pages)).toContain('You have 14 sessions booked.');
  });

  it('renders in Spanish for a customer who prefers it', () => {
    const es = gymProject({ withSpanish: true });
    const s = outputs(es, gymMember({ customer: { locale: 'es-US' }, custom: { tier: 'pro' } }));
    expect(s.html).toMatch(/<html lang="es-US"/);
    for (const text of [visibleText(s.pages), visibleText(s.html), s.email.text]) { expect(text).toContain('Cuota mensual'); expect(text).toContain('Como miembro Pro conserva la reserva prioritaria, Robin.'); }
    expect(s.parity.ok).toBe(true);
  });
});

describe('outputs of an empty blank project', () => {
  const blank = blankProject({ projectId: 'empty-doc', title: 'Empty', issuerName: 'Northside Gym', accent: '#1f4e79' });
  const anyone: SyntheticRecord = { recordId: 'REC-60001', documentType: 'custom', customer: { givenName: 'Robin', familyName: 'Okoye', locale: 'en-US' } };
  const o = outputs(blank, anyone);

  it('an empty page renders in every output without throwing', () => {
    expect(o.pages).toContain('<div id="iss-source"');
    expect(o.pages).not.toContain('class="iss-block"');
    expect(o.html).toContain('<main id="iss-main"');
    expect(o.html).not.toContain('<header class="iss-head"');
    expect(o.html).not.toContain('class="iss-sec"');
    expect(o.html).toContain('#1f4e79');
    expect(o.email.subject).toBe('Your Northside Gym document is ready');
    expect(o.email.preheader).toBe('Your Northside Gym document is ready.');
    expect(o.email.text).toContain('Hello Robin Okoye,');
    expect(o.email.html).not.toContain('Key facts');
    expect(o.sms.text).toBe('DEMO Northside Gym: Your document is ready.');
    expect(o.parity.ok).toBe(true);
    expect(o.parity.checks.every((c) => c.status === 'not-applicable')).toBe(true);
    for (const text of [visibleText(o.pages), visibleText(o.html), visibleText(o.email.html), o.email.text, o.sms.text]) expect(text.match(SAMPLE_WORDING)?.[0]).toBeUndefined();
    expect(compareManifests(o.res.semanticManifest, faithful(o.res.semanticManifest), faithful(o.res.semanticManifest)).ok).toBe(true);
    expect(afpSimulation(o.res, blank, null)).toMatchObject({ simulationOnly: true, afpBytesGenerated: 0, formdef: 'F1ISSSIM (conceptual)' });
  });

  it('every default component renders in pages, web page and email; an image without a picture is a neutral empty frame', () => {
    const all = COMPONENT_CATALOG.reduce((p, c, i) => run(p, { type: 'INSERT_NODE', node: defaultNode(c.type, `n${i}-${c.type}`, 'custom', p), parentId: 'doc-root' }), blank);
    const out = outputs(all, anyone);
    for (const doc of [out.pages, out.html]) {
      expect(doc).toMatch(/<div class="iss-img-missing iss-img-empty" role="img" aria-label="Describe this image"/);
      expect(visibleText(doc)).not.toContain('Image unavailable');
      expect(visibleText(doc).match(SAMPLE_WORDING)?.[0]).toBeUndefined();
    }
    expect(visibleText(out.pages)).toContain('Write the message here.');
    expect(visibleText(out.pages)).toContain('Write the disclosure text here.');
    expect(out.email.text).toContain('Write the disclosure text here.');
    expect(out.email.facts.logo).toBeNull();
    // the divider takes the issuer's colour
    expect(out.pages).toMatch(/class="iss-shape" aria-hidden="true" style="border-top:1.5pt solid #1f4e79;"/);
  });
});

describe('the two built-in kinds render as before', () => {
  const [card, eob] = seedProjects();
  it('keep their titles, section names, fixed wording and email footer', () => {
    const cardRes = resolve({ project: card, record: RECORDS.find((r) => r.recordId === 'CARD-0001')! });
    const html = renderInteractiveHtml(cardRes, card);
    expect(html).toContain('<title>Aster Card — Statement (synthetic)</title>');
    expect(html).toMatch(/id="sec-data-h">Transactions</);
    const strings = JSON.parse(/<script type="application\/json" id="iss-strings">([\s\S]*?)<\/script>/.exec(html)![1]);
    expect(Object.keys(strings)).toHaveLength(60);
    expect(Object.keys(strings).some((k) => /Document$/.test(k))).toBe(false);
    expect(renderEmail(cardRes, card).html).toContain('Synthetic demonstration data — not a real statement or claim.');
    const eobRes = resolve({ project: eob, record: RECORDS.find((r) => r.recordId === 'EOB-0001')! });
    expect(renderInteractiveHtml(eobRes, eob)).toMatch(/id="sec-data-h">Claims</);
    expect(eobRes.semanticManifest.identity.name).toBe(renderEmail(eobRes, eob).facts.customerName);
  });
});

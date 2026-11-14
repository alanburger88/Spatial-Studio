import { describe, expect, it } from 'vitest';
import { seedProjects, RECORDS } from '../src/fixtures';
import {
  applyCommand, checkLibraryContent, checkWordingRule, defaultNode, diffProjects, libraryContentFingerprint, libraryContentFromProject, libraryLinkProblems,
  linkOfNode, linkOfPart, linkOfText, linkStatus, lookupTableLibraryContent, projectContentDigest, projectFileProblems, templateContentOf, projectFromSavedTemplate,
  translatableStrings, validateWordingRules, LIBRARY_CONTENT_MAX_CHARS,
  type Command, type LibraryKind, type LibraryLink, type LookupTable, type Project,
} from '../src';
import { summarizeChanges } from '../../scenarios/src/assist/changeSummary';
import { FEE_BY_TIER } from './helpers/depthProject';

const [card] = seedProjects();
const run = (p: Project, ...cmds: Command[]): Project => cmds.reduce((acc, c) => { const r = applyCommand(acc, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; }, p);
const refused = (p: Project, c: Command) => { const r = applyCommand(p, c); return r.ok ? null : r; };
const LOGO = 'data:image/png;base64,iVBORw0KGgo=';
const link = (p: Project, kind: LibraryKind) => (p.libraryLinks ?? []).find((l) => l.kind === kind)!;

/** A document with a "Contact panel" container holding a greeting, the payment guidance and the rewards section. */
function withPanel(): Project {
  return run(card,
    { type: 'INSERT_NODE', node: { ...defaultNode('container', 'contact-panel', 'credit-statement'), name: 'Contact panel' }, parentId: 'doc-root', index: 8 },
    { type: 'MOVE_NODE', nodeId: 'greeting', parentId: 'contact-panel', index: 0 },
    { type: 'MOVE_NODE', nodeId: 'payment-guidance', parentId: 'contact-panel', index: 1 },
    { type: 'MOVE_NODE', nodeId: 'rewards-summary', parentId: 'contact-panel', index: 2 },
  );
}
const panel = withPanel();
const blockV1 = libraryContentFromProject(panel, 'block', 'contact-panel') as { content: any; title: string };
/** Version 2 of the block: the standard payment message says something else. */
const blockV2 = (() => {
  const c = JSON.parse(JSON.stringify(blockV1.content));
  c.contentParts.find((p: any) => p.id === 'payment-standard').approvedLocales['en-US'] = 'Pay by the due date to keep your account in good standing.';
  return c;
})();
const second = (): Project => ({ ...JSON.parse(JSON.stringify(card)), projectId: 'second-doc', title: 'Second document' });
const BLOCK_ITEM = { id: 'contact-panel-block', kind: 'block' as const, title: 'Contact panel' };

describe('library content validators (untrusted content)', () => {
  it('accepts each kind taken from a document and cleans it', () => {
    const branded = run(card, { type: 'SET_BRAND', brand: { primary: '#123456', accent: '#4EAF60', logoDataUri: LOGO, logoAlt: 'Aster logo' } }, { type: 'SET_GLOSSARY', locale: 'es-US', entries: [{ source: 'balance', target: 'saldo' }] });
    for (const [kind, ref] of [['brand'], ['glossary'], ['wording', 'payment-reminder'], ['block', 'contact-panel']] as Array<[LibraryKind, string?]>) {
      const got = libraryContentFromProject(kind === 'block' ? panel : branded, kind, ref);
      expect('content' in got, kind).toBe(true);
      const c = checkLibraryContent(kind, (got as any).content);
      expect(c.ok, `${kind}: ${!c.ok ? c.problems.join(' ') : ''}`).toBe(true);
    }
    expect(checkLibraryContent('lookup-table', FEE_BY_TIER).ok).toBe(true);
    expect(checkLibraryContent('wording-rules', { rules: [{ id: 'no-delinquent', kind: 'banned', severity: 'must', phrase: 'delinquent', replacement: 'past due' }] }).ok).toBe(true);
    // Extra fields are dropped
    const b = checkLibraryContent('brand', { primary: '#123456', accent: '#654321', script: 'alert(1)' });
    expect(b.ok && !('script' in b.content)).toBe(true);
  });

  it('refuses malformed content of every kind in plain words', () => {
    const bad: Array<[LibraryKind, unknown, RegExp]> = [
      ['brand', { primary: 'red', accent: '#123456' }, /6-digit hex/],
      ['brand', { primary: '#123456', accent: '#123456', logoDataUri: 'https://evil.example/x.png' }, /PNG, JPEG or WebP/],
      ['block', { nodes: [], contentParts: [] }, /at least one component/],
      ['block', { nodes: [{ id: 'a1', type: 'container', children: ['zz'] }], contentParts: [] }, /not in the block/],
      ['block', { nodes: [{ id: 'a1', type: 'action-link', action: { label: 'x', url: 'javascript:alert(1)', fallbackText: 'x' } }], contentParts: [] }, /safe https/],
      ['block', { nodes: [{ id: 'a1', type: 'variant-set', variantIds: ['v1'] }], contentParts: [] }, /not in the block/],
      ['block', { nodes: [{ id: 'a1', type: 'script' }], contentParts: [] }, /unknown kind/],
      ['wording', { part: { id: 'w1', title: 'T', type: 'text', approvedLocales: { 'en-US': '<b>x</b>' } } }, /raw HTML/],
      ['wording', { part: { id: 'w1', title: 'T', type: 'text', approvedLocales: { 'es-US': 'Hola' } } }, /English text/],
      ['glossary', { entries: { 'es-US': [{ source: 'a', target: '' }] } }, /English term and its translation/],
      ['glossary', { entries: { 'en-US': [{ source: 'a', target: 'b' }] } }, /target language/],
      ['lookup-table', { ...FEE_BY_TIER, id: '1bad' }, /must start with a letter/],
      ['wording-rules', { rules: [{ id: 'r1', kind: 'banned', severity: 'must' }] }, /needs the phrase/],
      ['wording-rules', { rules: 'all' }, /must be a list/],
    ];
    for (const [kind, raw, msg] of bad) {
      const c = checkLibraryContent(kind, raw);
      expect(c.ok, `${kind} ${JSON.stringify(raw).slice(0, 60)}`).toBe(false);
      if (!c.ok) expect(c.problems.join(' ')).toMatch(msg);
    }
    expect(checkLibraryContent('nonsense' as LibraryKind, {}).ok).toBe(false);
  });

  it('refuses oversized content', () => {
    const big = { primary: '#123456', accent: '#123456', logoDataUri: `data:image/png;base64,${'A'.repeat(LIBRARY_CONTENT_MAX_CHARS)}`, logoAlt: 'x' };
    const c = checkLibraryContent('brand', big);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.problems[0]).toMatch(/too large/);
    const many = { nodes: [{ id: 'r0', type: 'container', children: Array.from({ length: 250 }, (_, i) => `n${i}`) }, ...Array.from({ length: 250 }, (_, i) => ({ id: `n${i}`, type: 'rich-text' }))], contentParts: [] };
    expect(checkLibraryContent('block', many).ok).toBe(false);
  });

  it('wording rules: the shape, each kind and the validator', () => {
    const ok = [
      { id: 'no-delinquent', kind: 'banned', severity: 'must', phrase: 'delinquent', replacement: 'past due' },
      { id: 'dispute-rights', kind: 'required', severity: 'must', phrase: 'You have the right to dispute', appliesTo: 'disclosures' },
      { id: 'email-spelling', kind: 'preferred', severity: 'should', phrase: 'e-mail', replacement: 'email' },
      { id: 'grade-8', kind: 'reading-level', severity: 'should', limit: 8, language: 'en-US' },
      { id: 'short-sentences', kind: 'sentence-length', severity: 'should', limit: 25 },
      { id: 'no-demands', kind: 'tone', severity: 'must', note: 'Not a bill' },
    ];
    expect(validateWordingRules(ok)).toEqual([]);
    expect(validateWordingRules([...ok, ok[0]]).join(' ')).toMatch(/share the id/);
    expect(checkWordingRule({ id: 'x1', kind: 'preferred', severity: 'should', phrase: 'e-mail' }).problems.join(' ')).toMatch(/preferred form/);
    expect(checkWordingRule({ id: 'x1', kind: 'reading-level', severity: 'should', limit: 30 }).problems.join(' ')).toMatch(/grade from 1 to 18/);
    expect(checkWordingRule({ id: 'x1', kind: 'tone', severity: 'must', language: 'es-US' }).problems.join(' ')).toMatch(/only check English/);
    expect(checkWordingRule({ id: 'x1', kind: 'sentence-length', severity: 'may', limit: 20 }).problems.join(' ')).toMatch(/“must” or a “should”/);
    expect(checkWordingRule({ id: 'x1', kind: 'banned', severity: 'must', phrase: 'x', extra: 1 }).problems.join(' ')).toMatch(/fields a wording rule does not have/);
    expect(validateWordingRules(Array.from({ length: 201 }, (_, i) => ({ id: `r${i}`, kind: 'tone', severity: 'should' })))[0]).toMatch(/at most 200/);
  });
});

describe('linking, updating and unlinking (every kind, one undoable step each)', () => {
  it('a block inserted from the library gets ids derived from the link; update replaces it in place; unlink keeps it', () => {
    const doc = second();
    const linked = run(doc, { type: 'LINK_LIBRARY_ITEM', item: BLOCK_ITEM, version: 1, content: blockV1.content, placement: { parentId: 'doc-root', index: 3 } });
    expect(linked.modelVersion).toBe(doc.modelVersion + 1);
    const l = linked.libraryLinks![0];
    expect(l).toMatchObject({ itemId: BLOCK_ITEM.id, kind: 'block', version: 1, fingerprint: libraryContentFingerprint(checkLibraryContent('block', blockV1.content).ok ? (checkLibraryContent('block', blockV1.content) as any).content : null) });
    expect(l.target.kind === 'block' && l.target.rootNodeId).toBe(`${l.linkId}-contact-panel`);
    const root = linked.nodes.find((n) => n.id === `${l.linkId}-contact-panel`)!;
    expect(linked.nodes.find((n) => n.id === 'doc-root')!.children![3]).toBe(root.id);
    expect(root.children).toEqual([`${l.linkId}-greeting`, `${l.linkId}-payment-guidance`, `${l.linkId}-rewards-summary`]);
    expect(linked.contentParts.some((c) => c.id === `${l.linkId}-payment-standard`)).toBe(true);
    // A rule of the document points into the block.
    const ruled = run(linked, { type: 'UPSERT_RULE', rule: { id: 'R30', scope: 'credit-statement', mode: 'exclusive', priority: 900, exclusiveGroup: `${l.linkId}-payment-guidance`, when: { op: 'gte', path: 'card.missedPayments', value: 2 }, then: { op: 'selectVariant', targetNodeId: `${l.linkId}-payment-guidance`, variantId: `${l.linkId}-payment-reminder` }, version: 1 } });
    // The document moves the block (its position is the document's own) and sets its layout.
    const moved = run(ruled, { type: 'MOVE_NODE', nodeId: root.id, parentId: 'doc-root', index: 5 }, { type: 'SET_LAYOUT', nodeId: root.id, profile: 'paged', layout: { spaceBeforePt: 12 } });
    const updated = run(moved, { type: 'UPDATE_LIBRARY_LINK', linkId: l.linkId, version: 2, content: blockV2 });
    const ul = updated.libraryLinks![0];
    expect(ul.version).toBe(2);
    expect(updated.nodes.find((n) => n.id === 'doc-root')!.children!.indexOf(root.id)).toBe(5);
    expect(updated.nodes.find((n) => n.id === root.id)!.layout?.paged?.spaceBeforePt).toBe(12);
    expect(updated.contentParts.find((c) => c.id === `${l.linkId}-payment-standard`)!.approvedLocales['en-US']).toMatch(/good standing/);
    // Stable ids: the rule pointing into the block still works and is unchanged.
    expect(updated.rules.find((r) => r.id === 'R30')).toEqual(ruled.rules.find((r) => r.id === 'R30'));
    expect(new Set(updated.nodes.map((n) => n.id))).toEqual(new Set(moved.nodes.map((n) => n.id)));
    // Unlink: content stays, link goes.
    const own = run(updated, { type: 'UNLINK_LIBRARY_ITEM', linkId: l.linkId });
    expect(own.libraryLinks).toBeUndefined();
    expect(own.nodes).toEqual(updated.nodes);
    // ... and it can now be edited.
    expect(applyCommand(own, { type: 'UPDATE_NODE', nodeId: `${l.linkId}-greeting`, patch: { name: 'Hello' } }).ok).toBe(true);
    // Undo of each step is the previous project (the store keeps it); restoring it is one step.
    const undone = run(updated, { type: 'RESTORE_SNAPSHOT', project: moved, label: 'Undo' });
    expect(projectContentDigest(undone)).toBe(projectContentDigest(moved));
  });

  it('a block linked in place of the component it was made from keeps every id, so rules and comments still point at it', () => {
    const linked = run(panel, { type: 'LINK_LIBRARY_ITEM', item: BLOCK_ITEM, version: 1, content: blockV1.content, placement: { replaceNodeId: 'contact-panel' } });
    expect(linked.nodes.map((n) => n.id).sort()).toEqual(panel.nodes.map((n) => n.id).sort());
    const l = linked.libraryLinks![0];
    expect(l.target).toEqual({ kind: 'block', rootNodeId: 'contact-panel', idPrefix: '' });
    expect(linked.rules).toEqual(panel.rules);
    const updated = run(linked, { type: 'UPDATE_LIBRARY_LINK', linkId: l.linkId, version: 2, content: blockV2 });
    expect(updated.rules).toEqual(panel.rules);
    expect(updated.contentParts.find((c) => c.id === 'payment-standard')!.approvedLocales['en-US']).toMatch(/good standing/);
  });

  it('wording, brand, glossary, lookup table and wording rules link, update and unlink', () => {
    const w1 = { part: { id: 'late-notice', title: 'Late payment notice', type: 'text', approvedLocales: { 'en-US': 'Your payment is late.', 'es-US': 'Su pago está atrasado.' } }, titleTranslations: { 'es-US': 'Aviso de pago atrasado' } };
    const w2 = { ...w1, part: { ...w1.part, approvedLocales: { 'en-US': 'Your payment is past due.', 'es-US': 'Su pago está vencido.' } } };
    let p = run(second(), { type: 'LINK_LIBRARY_ITEM', item: { id: 'late-notice', kind: 'wording', title: 'Late payment notice' }, version: 1, content: w1, placement: { partId: 'payment-reminder' } });
    expect(p.contentParts.find((c) => c.id === 'payment-reminder')!.approvedLocales['en-US']).toBe('Your payment is late.');
    expect(p.strings?.['@title/payment-reminder']?.approved?.['es-US']).toBe('Aviso de pago atrasado');
    p = run(p, { type: 'UPDATE_LIBRARY_LINK', linkId: link(p, 'wording').linkId, version: 2, content: w2 });
    expect(p.contentParts.find((c) => c.id === 'payment-reminder')!.approvedLocales['es-US']).toBe('Su pago está vencido.');

    const brand1 = { primary: '#123456', accent: '#4EAF60', logoDataUri: LOGO, logoAlt: 'Logo' };
    p = run(p, { type: 'LINK_LIBRARY_ITEM', item: { id: 'house-brand', kind: 'brand', title: 'House brand' }, version: 1, content: brand1 });
    expect(p.brand).toEqual(brand1);
    p = run(p, { type: 'UPDATE_LIBRARY_LINK', linkId: link(p, 'brand').linkId, version: 2, content: { ...brand1, primary: '#000000' } });
    expect(p.brand!.primary).toBe('#000000');

    p = run(p, { type: 'LINK_LIBRARY_ITEM', item: { id: 'house-glossary', kind: 'glossary', title: 'House glossary' }, version: 1, content: { entries: { 'es-US': [{ source: 'balance', target: 'saldo' }] } } });
    expect(p.glossary).toEqual({ 'es-US': [{ source: 'balance', target: 'saldo' }] });

    p = run(p, { type: 'LINK_LIBRARY_ITEM', item: { id: 'fee-table', kind: 'lookup-table', title: 'Late fee by tier' }, version: 1, content: FEE_BY_TIER });
    expect(p.lookupTables!.find((t) => t.id === 'feeByTier')!.rows).toHaveLength(2);
    const t2: LookupTable = { ...FEE_BY_TIER, rows: [...FEE_BY_TIER.rows, { keys: { tier: 'gold' }, values: { lateFee: 500, note: 'Gold' } }] };
    p = run(p, { type: 'UPDATE_LIBRARY_LINK', linkId: link(p, 'lookup-table').linkId, version: 2, content: t2 });
    expect(p.lookupTables!.find((t) => t.id === 'feeByTier')!.rows).toHaveLength(3);

    const rules = { rules: [{ id: 'no-delinquent', kind: 'banned', severity: 'must', phrase: 'delinquent', replacement: 'past due' }] };
    p = run(p, { type: 'LINK_LIBRARY_ITEM', item: { id: 'house-rules', kind: 'wording-rules', title: 'House rules' }, version: 1, content: rules });
    expect(p.houseWordingRules).toHaveLength(1);
    expect(p.libraryLinks).toHaveLength(5);
    expect(projectFileProblems(JSON.parse(JSON.stringify(p)))).toEqual([]);
    // A second brand link is refused; so is linking the same version again.
    expect(refused(p, { type: 'LINK_LIBRARY_ITEM', item: { id: 'other-brand', kind: 'brand', title: 'Other' }, version: 1, content: brand1 })?.message).toMatch(/already comes from the library/);
    expect(refused(p, { type: 'UPDATE_LIBRARY_LINK', linkId: link(p, 'brand').linkId, version: 2, content: brand1 })?.message).toMatch(/already holds version 2/);
    // Malformed content is refused by the command too.
    expect(refused(p, { type: 'UPDATE_LIBRARY_LINK', linkId: link(p, 'brand').linkId, version: 3, content: { primary: 'red' } })?.code).toBe('INVALID_LIBRARY_CONTENT');
    for (const k of ['brand', 'glossary', 'lookup-table', 'wording-rules', 'wording'] as LibraryKind[]) {
      const before = p;
      p = run(p, { type: 'UNLINK_LIBRARY_ITEM', linkId: link(p, k).linkId });
      expect(p.libraryLinks?.some((l) => l.kind === k) ?? false).toBe(false);
      // the content stays (unlinked house wording rules become the document's own rules, so they can be edited)
      expect({ b: before.brand, g: before.glossary, t: before.lookupTables, r: before.houseWordingRules }).toEqual({ b: p.brand, g: p.glossary, t: p.lookupTables, r: k === 'wording-rules' ? p.wordingRules : p.houseWordingRules });
    }
    expect(p.libraryLinks).toBeUndefined();
  });

  it('a new version taken from a document that inserted the block (then unlinked it) keeps the library’s ids', () => {
    const linked = run(second(), { type: 'LINK_LIBRARY_ITEM', item: BLOCK_ITEM, version: 1, content: blockV1.content, placement: { parentId: 'doc-root' } });
    const l = linked.libraryLinks![0];
    const own = run(linked, { type: 'UNLINK_LIBRARY_ITEM', linkId: l.linkId }, { type: 'UPDATE_NODE', nodeId: `${l.linkId}-greeting`, patch: { name: 'Warm greeting' } });
    const again = libraryContentFromProject(own, 'block', `${l.linkId}-contact-panel`) as { content: any };
    expect(again.content.nodes.map((n: any) => n.id)).toEqual(blockV1.content.nodes.map((n: any) => n.id));
    expect(again.content.contentParts.map((p: any) => p.id)).toEqual(blockV1.content.contentParts.map((p: any) => p.id));
    expect(again.content.nodes.find((n: any) => n.id === 'greeting').name).toBe('Warm greeting');
  });

  it('refuses a block whose data fields or ids the document does not have', () => {
    const eob = seedProjects()[1];
    const r = refused(eob, { type: 'LINK_LIBRARY_ITEM', item: { id: 'balance-block', kind: 'block', title: 'Balance' }, version: 1, content: (libraryContentFromProject(card, 'block', 'account-summary') as any).content, placement: { parentId: 'doc-root' } });
    expect(r?.message).toMatch(/data field card\.\w+, which this document does not have/);
    expect(refused(second(), { type: 'LINK_LIBRARY_ITEM', item: BLOCK_ITEM, version: 1, content: blockV1.content })?.message).toMatch(/Say where/);
  });
});

/* ------------------------------------------------------------------ the read-only rule */

interface Linked { p: Project; block: LibraryLink; ids: (id: string) => string }
/** A document holding one link of every kind: a block, a wording, the brand, the glossary, a lookup table and the house rules. */
function everything(): Linked {
  let p = run(second(), { type: 'SET_DOCUMENT_DATE', source: { source: 'run' } });
  p = run(p, { type: 'LINK_LIBRARY_ITEM', item: BLOCK_ITEM, version: 1, content: blockV1.content, placement: { parentId: 'doc-root' } });
  const block = p.libraryLinks![0];
  p = run(p,
    { type: 'LINK_LIBRARY_ITEM', item: { id: 'late-notice', kind: 'wording', title: 'Late payment notice' }, version: 1, content: { part: { id: 'late', title: 'Late', type: 'text', approvedLocales: { 'en-US': 'Late.' } } }, placement: { partId: 'payment-reminder' } },
    { type: 'LINK_LIBRARY_ITEM', item: { id: 'house-brand', kind: 'brand', title: 'House brand' }, version: 1, content: { primary: '#123456', accent: '#4EAF60' } },
    { type: 'LINK_LIBRARY_ITEM', item: { id: 'house-glossary', kind: 'glossary', title: 'House glossary' }, version: 1, content: { entries: { 'es-US': [{ source: 'balance', target: 'saldo' }] } } },
    { type: 'LINK_LIBRARY_ITEM', item: { id: 'fee-table', kind: 'lookup-table', title: 'Late fee by tier' }, version: 1, content: FEE_BY_TIER },
    { type: 'LINK_LIBRARY_ITEM', item: { id: 'house-rules', kind: 'wording-rules', title: 'House rules' }, version: 1, content: { rules: [{ id: 'r1', kind: 'tone', severity: 'must' }] } },
  );
  return { p, block, ids: (id) => `${block.linkId}-${id}` };
}

type Probe = { what: string; cmd: (x: Linked) => Command; allowed?: boolean; setup?: (x: Linked) => Project };
const READ_ONLY = /comes from the library: .*read-only in this document\. Unlink it/;
const draftIn = (p: Project, id: string): Project => {
  const q = JSON.parse(JSON.stringify(p)) as Project;
  if (id.startsWith('@')) q.strings = { ...(q.strings ?? {}), [id]: { ...(q.strings?.[id] ?? {}), draft: { 'es-US': translatableStrings(p).find((s) => s.id === id)!.source } } };
  else q.contentParts.find((c) => c.id === id)!.draftLocales = { 'es-US': 'Borrador' };
  return q;
};

/**
 * Every command type, and what each can do to linked content. An empty list means the command cannot touch the content of
 * any kind of link (it works on other parts of the document). TypeScript fails this file when a command type is added.
 */
const PROBES: Record<Command['type'], Probe[]> = {
  INSERT_NODE: [{ what: 'a component into a linked block', cmd: (x) => ({ type: 'INSERT_NODE', node: defaultNode('rich-text', 'new-text', 'credit-statement'), parentId: x.ids('contact-panel') }) }],
  DELETE_NODE: [{ what: 'a component of a linked block', cmd: (x) => ({ type: 'DELETE_NODE', nodeId: x.ids('greeting') }) }, { what: 'the linked block itself', cmd: (x) => ({ type: 'DELETE_NODE', nodeId: x.ids('contact-panel') }) }],
  MOVE_NODE: [
    { what: 'a component out of a linked block', cmd: (x) => ({ type: 'MOVE_NODE', nodeId: x.ids('greeting'), parentId: 'doc-root', index: 0 }) },
    { what: 'a component into a linked block', cmd: (x) => ({ type: 'MOVE_NODE', nodeId: 'statement-title', parentId: x.ids('contact-panel'), index: 0 }) },
    { what: 'the linked block within the document', cmd: (x) => ({ type: 'MOVE_NODE', nodeId: x.ids('contact-panel'), parentId: 'doc-root', index: 0 }), allowed: true },
  ],
  UPDATE_NODE: [{ what: 'the text of a linked component', cmd: (x) => ({ type: 'UPDATE_NODE', nodeId: x.ids('greeting'), patch: { name: 'Changed' } }) }, { what: 'the linked block root', cmd: (x) => ({ type: 'UPDATE_NODE', nodeId: x.ids('contact-panel'), patch: { name: 'Changed' } }) }],
  SET_LAYOUT: [
    { what: 'the layout of a component inside a linked block', cmd: (x) => ({ type: 'SET_LAYOUT', nodeId: x.ids('greeting'), profile: 'paged', layout: { spaceBeforePt: 20 } }) },
    { what: 'the layout of the linked block (the document’s own)', cmd: (x) => ({ type: 'SET_LAYOUT', nodeId: x.ids('contact-panel'), profile: 'paged', layout: { spaceBeforePt: 20 } }), allowed: true },
  ],
  DUPLICATE_NODE: [{ what: 'a component inside a linked block', cmd: (x) => ({ type: 'DUPLICATE_NODE', nodeId: x.ids('greeting'), newId: 'greeting-copy-2' }) }],
  UPSERT_RULE: [{ what: 'a rule pointing into a linked block (the rule is the document’s)', cmd: (x) => ({ type: 'UPSERT_RULE', rule: { id: 'R30', scope: 'credit-statement', mode: 'exclusive', priority: 900, exclusiveGroup: x.ids('payment-guidance'), when: { op: 'gte', path: 'card.missedPayments', value: 2 }, then: { op: 'selectVariant', targetNodeId: x.ids('payment-guidance'), variantId: x.ids('payment-reminder') }, version: 1 } }), allowed: true }],
  DELETE_RULE: [],
  SET_RULE_ENABLED: [],
  UPSERT_CONTENT_PART: [
    { what: 'a message of a linked block', cmd: (x) => ({ type: 'UPSERT_CONTENT_PART', part: { ...x.p.contentParts.find((c) => c.id === x.ids('payment-standard'))!, title: 'Changed' } }) },
    { what: 'a linked wording', cmd: (x) => ({ type: 'UPSERT_CONTENT_PART', part: { ...x.p.contentParts.find((c) => c.id === 'payment-reminder')!, approvedLocales: { 'en-US': 'Changed' } } }) },
  ],
  ADD_VARIANT: [{ what: 'an alternative to a linked block', cmd: (x) => ({ type: 'ADD_VARIANT', nodeId: x.ids('payment-guidance'), variantId: 'extra-variant', title: 'Extra', text: 'Extra' }) }],
  REMOVE_VARIANT: [{ what: 'an alternative of a linked block', cmd: (x) => ({ type: 'REMOVE_VARIANT', nodeId: x.ids('payment-guidance'), variantId: x.ids('payment-reminder') }) }],
  SET_VARIANT_CONDITION: [{ what: 'a condition inside a linked block', cmd: (x) => ({ type: 'SET_VARIANT_CONDITION', nodeId: x.ids('payment-guidance'), variantId: x.ids('payment-reminder'), when: { op: 'gte', path: 'card.missedPayments', value: 1 } }) }],
  SET_JOURNEY: [],
  UPDATE_PROFILE: [],
  SET_CUSTOM_FIELDS: [],
  SET_STYLES: [],
  SET_BRAND: [{ what: 'a linked brand', cmd: () => ({ type: 'SET_BRAND', brand: { primary: '#000000', accent: '#4EAF60' } }) }, { what: 'removing a linked brand', cmd: () => ({ type: 'SET_BRAND', brand: null }) }],
  UPSERT_TEST_CASE: [],
  DELETE_TEST_CASE: [],
  SET_TRANSLATION_DRAFT: [
    { what: 'a text of a linked block', cmd: (x) => ({ type: 'SET_TRANSLATION_DRAFT', partId: `@${x.ids('greeting')}/content`, locale: 'es-US', text: 'Hola' }) },
    { what: 'a message of a linked block', cmd: (x) => ({ type: 'SET_TRANSLATION_DRAFT', partId: x.ids('payment-standard'), locale: 'es-US', text: 'Hola' }) },
    { what: 'a linked wording', cmd: () => ({ type: 'SET_TRANSLATION_DRAFT', partId: 'payment-reminder', locale: 'es-US', text: 'Hola' }) },
    { what: 'the heading of a linked wording', cmd: () => ({ type: 'SET_TRANSLATION_DRAFT', partId: '@title/payment-reminder', locale: 'es-US', text: 'Hola' }) },
  ],
  APPROVE_TRANSLATION: [
    { what: 'a draft in a linked wording (only possible in a file)', setup: (x) => draftIn(x.p, 'payment-reminder'), cmd: () => ({ type: 'APPROVE_TRANSLATION', partId: 'payment-reminder', locale: 'es-US' }) },
    { what: 'a draft of a linked block text', setup: (x) => draftIn(x.p, `@${x.ids('greeting')}/content`), cmd: (x) => ({ type: 'APPROVE_TRANSLATION', partId: `@${x.ids('greeting')}/content`, locale: 'es-US' }) },
  ],
  SET_TRANSLATION_DRAFTS: [{ what: 'many drafts, one in a linked block', cmd: (x) => ({ type: 'SET_TRANSLATION_DRAFTS', locale: 'es-US', items: [{ id: 'payment-standard', text: 'Pague' }, { id: x.ids('payment-standard'), text: 'Pague' }] }) }],
  APPROVE_TRANSLATIONS: [{ what: 'approving drafts in a linked wording', setup: (x) => draftIn(x.p, 'payment-reminder'), cmd: () => ({ type: 'APPROVE_TRANSLATIONS', locale: 'es-US', ids: ['payment-reminder'] }) }],
  ADD_LANGUAGE: [],
  REMOVE_LANGUAGE: [],
  SET_CHANNELS: [],
  SET_GLOSSARY: [{ what: 'a linked glossary', cmd: () => ({ type: 'SET_GLOSSARY', locale: 'es-US', entries: [{ source: 'fee', target: 'cargo' }] }) }],
  SET_DOCUMENT_DATE: [],
  UPSERT_CALCULATED_FIELD: [],
  DELETE_CALCULATED_FIELD: [],
  MOVE_CALCULATED_FIELD: [],
  UPSERT_LOOKUP_TABLE: [{ what: 'a linked lookup table', cmd: () => ({ type: 'UPSERT_LOOKUP_TABLE', table: { ...FEE_BY_TIER, title: 'Changed' } }) }],
  DELETE_LOOKUP_TABLE: [{ what: 'a linked lookup table', cmd: () => ({ type: 'DELETE_LOOKUP_TABLE', tableId: 'feeByTier' }) }],
  MOVE_LOOKUP_TABLE: [{ what: 'a linked lookup table in the list (the order is the document’s)', cmd: () => ({ type: 'MOVE_LOOKUP_TABLE', tableId: 'feeByTier', index: 0 }), allowed: true }],
  SET_RULE_PERIOD: [],
  SET_VARIANT_PERIOD: [{ what: 'a period on an alternative of a linked block', cmd: (x) => ({ type: 'SET_VARIANT_PERIOD', nodeId: x.ids('payment-guidance'), variantId: x.ids('payment-reminder'), period: { from: '2026-01-01' } }) }],
  SET_SECTION_PERIOD: [{ what: 'a period on a section of a linked block', cmd: (x) => ({ type: 'SET_SECTION_PERIOD', nodeId: x.ids('rewards-summary'), period: { from: '2026-01-01' } }) }],
  BATCH: [
    { what: 'a batch with one change to a linked block', cmd: (x) => ({ type: 'BATCH', label: 'Fixes', commands: [{ type: 'UPDATE_NODE', nodeId: 'statement-title', patch: { name: 'Title' } }, { type: 'UPDATE_NODE', nodeId: x.ids('greeting'), patch: { name: 'Changed' } }] }) },
    { what: 'a batch that touches nothing linked', cmd: () => ({ type: 'BATCH', label: 'Fixes', commands: [{ type: 'UPDATE_NODE', nodeId: 'statement-title', patch: { name: 'Title' } }] }), allowed: true },
  ],
  SET_PAGE_DESIGN: [],
  SET_ACCESSIBLE_PDF_REQUIRED: [],
  RESTORE_SNAPSHOT: [{ what: 'undo to an earlier version (it may hold other content)', cmd: () => ({ type: 'RESTORE_SNAPSHOT', project: card, label: 'Undo' }), allowed: true }],
  LINK_LIBRARY_ITEM: [{ what: 'a second brand', cmd: () => ({ type: 'LINK_LIBRARY_ITEM', item: { id: 'other-brand', kind: 'brand', title: 'Other' }, version: 1, content: { primary: '#111111', accent: '#222222' } }) }],
  UPDATE_LIBRARY_LINK: [{ what: 'the block to version 2', cmd: (x) => ({ type: 'UPDATE_LIBRARY_LINK', linkId: x.block.linkId, version: 2, content: blockV2 }), allowed: true }],
  UNLINK_LIBRARY_ITEM: [{ what: 'the block', cmd: (x) => ({ type: 'UNLINK_LIBRARY_ITEM', linkId: x.block.linkId }), allowed: true }],
  // The document's own wording rules sit beside the linked house rules and never change them.
  ADD_WORDING_RULE: [{ what: 'an own wording rule beside the linked house rules', cmd: () => ({ type: 'ADD_WORDING_RULE', rule: { id: 'own-1', kind: 'banned', severity: 'should', phrase: 'kindly' } }), allowed: true }],
  UPDATE_WORDING_RULE: [],
  REMOVE_WORDING_RULE: [],
  MOVE_WORDING_RULE: [],
  // Mappings to a production system (wave 3) describe the data, never linked content.
  ADD_MAPPING: [{ what: 'a mapping beside linked content', cmd: () => ({ type: 'ADD_MAPPING', mapping: { id: 'map-core', name: 'Mapping for Core', system: 'Core' } }), allowed: true }],
  RENAME_MAPPING: [],
  REMOVE_MAPPING: [],
  IMPORT_TARGET_FIELDS: [],
  SET_MAPPING_ENTRY: [],
  CLEAR_MAPPING_ENTRY: [],
  SET_MAPPING_ENTRIES: [],
};

describe('linked content is read-only in the document', () => {
  const x = everything();
  for (const [type, probes] of Object.entries(PROBES)) for (const probe of probes) {
    it(`${type}: ${probe.what} is ${probe.allowed ? 'allowed' : 'refused, naming the library item'}`, () => {
      const base = probe.setup ? probe.setup(x) : x.p;
      const r = applyCommand(base, probe.cmd(x));
      if (probe.allowed) { expect(r.ok, r.ok ? '' : r.message).toBe(true); return; }
      expect(r.ok).toBe(false);
      if (r.ok) return;
      if (type === 'LINK_LIBRARY_ITEM') { expect(r.message).toMatch(/already comes from the library/); return; }
      expect(r.code, r.message).toBe('LIBRARY_READ_ONLY');
      expect(r.message).toMatch(READ_ONLY);
      expect(r.message).toMatch(/“(Contact panel|Late payment notice|House brand|House glossary|Late fee by tier)”/);
    });
  }
  it('the same commands still work on content that is not linked, and on a document without links', () => {
    expect(applyCommand(x.p, { type: 'UPDATE_NODE', nodeId: 'statement-title', patch: { name: 'Title' } }).ok).toBe(true);
    expect(applyCommand(x.p, { type: 'SET_TRANSLATION_DRAFT', partId: 'payment-standard', locale: 'es-US', text: 'Hola' }).ok).toBe(true);
    expect(applyCommand(card, { type: 'SET_BRAND', brand: { primary: '#000000', accent: '#4EAF60' } }).ok).toBe(true);
  });
  it('finds the link a node, message or text belongs to', () => {
    expect(linkOfNode(x.p, x.ids('greeting'))?.linkId).toBe(x.block.linkId);
    expect(linkOfNode(x.p, 'greeting')).toBeUndefined();
    expect(linkOfPart(x.p, 'payment-reminder')?.kind).toBe('wording');
    expect(linkOfPart(x.p, x.ids('payment-standard'))?.kind).toBe('block');
    expect(linkOfText(x.p, `@${x.ids('greeting')}/content`)?.kind).toBe('block');
    expect(linkOfText(x.p, '@title/payment-reminder')?.kind).toBe('wording');
  });
});

describe('links in files, templates, statuses and the diff', () => {
  const x = everything();
  it('saved templates and project files carry the links; a link to an unknown item keeps its content', () => {
    const tpl = templateContentOf(x.p);
    expect(tpl.libraryLinks).toEqual(x.p.libraryLinks);
    const fromTpl = projectFromSavedTemplate(tpl, { projectId: 'from-tpl', title: 'From template', templateId: 't', version: 1, templateTitle: 'T' });
    expect(fromTpl.libraryLinks).toEqual(x.p.libraryLinks);
    expect(projectFileProblems(JSON.parse(JSON.stringify(x.p)))).toEqual([]);
    // Unknown items are fine in a file: the studio shows them as not in its library.
    expect(linkStatus(x.block, [])).toBe('not-in-library');
    expect(linkStatus(x.block, [{ id: BLOCK_ITEM.id, latest: 1 }])).toBe('current');
    expect(linkStatus(x.block, [{ id: BLOCK_ITEM.id, latest: 3 }])).toBe('behind');
  });
  it('refuses malformed links in a file', () => {
    const bad = JSON.parse(JSON.stringify(x.p));
    bad.libraryLinks[0].target.rootNodeId = 'nowhere';
    bad.libraryLinks[1].linkId = 'NOPE';
    bad.libraryLinks.push({ ...bad.libraryLinks[2] });
    bad.houseWordingRules = [{ id: 'x', kind: 'banned', severity: 'must' }];
    const problems = libraryLinkProblems(bad).join(' ');
    expect(problems).toMatch(/not in the document/);
    expect(problems).toMatch(/no valid id/);
    expect(problems).toMatch(/share the id|hold the same content/);
    expect(problems).toMatch(/house wording rules are not valid/);
    expect(projectFileProblems(bad).some((p) => p.code === 'LIBRARY')).toBe(true);
  });
  it('the project diff and the change summary describe link, update and unlink in plain words', () => {
    const before = second();
    const linked = run(before, { type: 'LINK_LIBRARY_ITEM', item: BLOCK_ITEM, version: 1, content: blockV1.content, placement: { parentId: 'doc-root' } });
    const d1 = diffProjects(before, linked);
    expect(d1.library?.linked.map((l) => l.title)).toEqual(['Contact panel']);
    expect(d1.summary.counts.library).toBe(1);
    expect(d1.other).toEqual([]);
    const l = linked.libraryLinks![0];
    const updated = run(linked, { type: 'UPDATE_LIBRARY_LINK', linkId: l.linkId, version: 2, content: blockV2 });
    expect(diffProjects(linked, updated).library?.updated).toEqual([expect.objectContaining({ title: 'Contact panel', from: 1, version: 2 })]);
    const own = run(updated, { type: 'UNLINK_LIBRARY_ITEM', linkId: l.linkId });
    expect(diffProjects(updated, own).library?.unlinked.map((u) => u.version)).toEqual([2]);
    const records = RECORDS.filter((r) => r.documentType === 'credit-statement');
    const words = (a: Project, b: Project) => summarizeChanges(a, b, records).sections.flatMap((s) => s.items).join('\n');
    expect(words(before, linked)).toMatch(/Now uses the library building block “Contact panel” \(version 1\)/);
    expect(words(linked, updated)).toMatch(/updated from version 1 to version 2/);
    expect(words(updated, own)).toMatch(/was unlinked: its content is now this document’s own/);
  });
  it('a document without links: no library section in the diff, nothing in the summary', () => {
    const changed = run(card, { type: 'UPDATE_NODE', nodeId: 'statement-title', patch: { name: 'Title' } });
    const d = diffProjects(card, changed);
    expect('library' in d).toBe(false);
    expect('library' in d.summary.counts).toBe(false);
    expect(card.libraryLinks).toBeUndefined();
  });
  it('the Lookup tables screen hook gives a table’s content and title', () => {
    const withTable = run(card, { type: 'UPSERT_LOOKUP_TABLE', table: FEE_BY_TIER });
    expect(lookupTableLibraryContent(withTable, 'feeByTier')).toEqual({ content: FEE_BY_TIER, title: 'Late fee by tier' });
    expect(lookupTableLibraryContent(withTable, 'nope')).toEqual({ error: 'There is no lookup table nope.' });
  });
});

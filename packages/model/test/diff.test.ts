import { describe, expect, it } from 'vitest';
import { seedProjects } from '../src/fixtures';
import { applyCommand, checkTestCase, diffProjects, layoutText, predicateText, sanitizeCommentBody, transitionProblem, roleCan, richFromMarkup, type Project } from '../src/index';

const aster = () => structuredClone(seedProjects().find((p) => p.projectId === 'aster-card-demo')!) as Project;

describe('diffProjects', () => {
  it('identical projects (ignoring version counters and save time) produce an empty diff', () => {
    const a = aster();
    const b = { ...aster(), modelVersion: a.modelVersion + 7, lastSavedAt: '2026-01-01T00:00:00Z' };
    const d = diffProjects(a, b);
    expect(d.summary.identical).toBe(true);
    expect(d.summary.total).toBe(0);
    expect(d.title).toBeUndefined();
  });

  it('reports title, component name/text/layout changes with readable old → new values', () => {
    const a = aster();
    const b = aster();
    b.title = 'Aster statement (edited)';
    const text = b.nodes.find((n) => n.type === 'rich-text' && n.content)!;
    const oldText = text.content;
    text.name = 'Welcome message';
    text.content = richFromMarkup('Hello there');
    const fixed = b.nodes.find((n) => n.layout?.paged)!;
    fixed.layout = { ...fixed.layout, paged: { ...fixed.layout!.paged!, mode: 'flow', widthPct: 50 } };
    const d = diffProjects(a, b);
    expect(d.title).toEqual({ from: a.title, to: 'Aster statement (edited)' });
    const ch = d.components.changed.find((c) => c.id === text.id)!;
    expect(ch.fields).toEqual(expect.arrayContaining(['name', 'content']));
    expect(ch.changes.find((c) => c.field === 'name')!.to).toBe('Welcome message');
    const t = ch.changes.find((c) => c.field === 'text')!;
    expect(t.to).toBe('Hello there');
    expect(t.from).toBeTruthy();
    expect(oldText).toBeTruthy();
    const lay = d.components.changed.find((c) => c.id === fixed.id)!.changes.find((c) => c.field === 'layout')!;
    expect(lay.to).toContain('50% wide');
    expect(d.summary.counts.title).toBe(1);
    expect(d.summary.counts.components).toBeGreaterThanOrEqual(1);
  });

  it('reports components added and removed (via the command bus)', () => {
    const a = aster();
    const container = a.nodes.find((n) => n.type === 'container' && n.id !== a.rootNodeId) ?? a.nodes.find((n) => n.id === a.rootNodeId)!;
    const r = applyCommand(a, { type: 'INSERT_NODE', parentId: container.id, node: { id: 'note-added', type: 'rich-text', name: 'Added note', content: richFromMarkup('Hi') } });
    if (!r.ok) throw new Error(r.message);
    const d = diffProjects(a, r.project);
    expect(d.components.added.length).toBe(1);
    expect(d.components.added[0].type).toBe('rich-text');
    const back = diffProjects(r.project, a);
    expect(back.components.removed.map((c) => c.id)).toEqual(d.components.added.map((c) => c.id));
  });

  it('reports rule priority, enabled, condition and action changes plus added/removed rules', () => {
    const a = aster();
    const b = aster();
    const [r0, r1] = b.rules;
    r0.priority += 5;
    r0.enabled = false;
    r1.when = { op: 'gte', path: 'card.missedPayments', value: 9 };
    const removed = b.rules.pop()!;
    b.rules.push({ ...structuredClone(r1), id: 'R99', title: 'New rule' });
    const d = diffProjects(a, b);
    const c0 = d.rules.changed.find((c) => c.id === r0.id)!;
    expect(c0.priority).toEqual({ from: a.rules[0].priority, to: a.rules[0].priority + 5 });
    expect(c0.enabled).toEqual({ from: true, to: false });
    const c1 = d.rules.changed.find((c) => c.id === r1.id)!;
    expect(c1.condition!.to).toBe('card.missedPayments ≥ 9');
    expect(c1.before.id).toBe(r1.id);
    expect(d.rules.added.map((r) => r.id)).toEqual(['R99']);
    expect(d.rules.removed.map((r) => r.id)).toEqual([removed.id]);
    expect(d.summary.counts.rules).toBe(4);
  });

  it('enabled: undefined and enabled: true are the same', () => {
    const a = aster(); const b = aster();
    delete (a.rules[0] as any).enabled; b.rules[0].enabled = true;
    expect(diffProjects(a, b).rules.changed).toEqual([]);
  });

  it('reports content text changes per locale (approved and draft) and other sections', () => {
    const a = aster(); const b = aster();
    const part = b.contentParts[0];
    part.approvedLocales = { ...part.approvedLocales, 'en-US': 'New wording' };
    part.draftLocales = { 'es-US': 'Borrador' };
    b.customFields = [...(b.customFields ?? []), { key: 'tier', label: 'Tier', type: 'string' }];
    b.brand = { primary: '#000000', accent: '#111111' };
    b.testCases = [{ id: 't1', name: 'Pinned', recordId: 'CARD-0001', expect: {} }];
    b.journey = { ...b.journey, events: b.journey.events.slice(1) };
    const d = diffProjects(a, b);
    const en = d.content.changed.find((c) => c.partId === part.id && c.locale === 'en-US')!;
    expect(en).toMatchObject({ kind: 'approved', to: 'New wording' });
    expect(en.from).toBe(a.contentParts[0].approvedLocales['en-US']);
    expect(d.content.changed.find((c) => c.kind === 'draft')).toMatchObject({ locale: 'es-US', from: null, to: 'Borrador' });
    expect(d.customFields.added).toEqual([{ id: 'tier', name: 'Tier' }]);
    expect(d.brand.changed.map((c) => c.field)).toEqual(expect.arrayContaining(['primary', 'accent']));
    expect(d.testCases.added[0].name).toBe('Pinned');
    if (a.journey.events.length) expect(d.journey.removed.length).toBe(1);
    expect(d.summary.identical).toBe(false);
  });

  it('is deterministic', () => {
    const a = aster(); const b = aster(); b.title = 'X';
    expect(JSON.stringify(diffProjects(a, b))).toBe(JSON.stringify(diffProjects(a, b)));
  });
});

describe('helpers', () => {
  it('predicateText and layoutText', () => {
    expect(predicateText({ op: 'and', args: [{ op: 'eq', path: 'a.b', value: true }, { op: 'isNull', path: 'c' }] })).toBe('a.b = true AND c is empty');
    expect(layoutText({ paged: { mode: 'fixed', xPt: 10, yPt: 20, wPt: 100, hPt: 30, pages: 'first' } })).toBe('fixed at x 10 y 20 · 100×30 pt · first page');
  });

  it('checkTestCase compares variants, visibility, locale and blocking', () => {
    const tc = { id: 't', name: 'T', recordId: 'CARD-0001', expect: { selectedVariants: { pg: 'v1' }, visibleNodeIds: ['a'], hiddenNodeIds: ['b'], approvedLocale: 'en-US', noBlocking: true } };
    expect(checkTestCase(tc, { selectedVariants: { pg: 'v1' }, visibleNodeIds: ['a'], locale: 'en-US', blockingCount: 0 }).passed).toBe(true);
    const bad = checkTestCase(tc, { selectedVariants: { pg: 'v2' }, visibleNodeIds: ['b'], locale: 'es-US', blockingCount: 2 });
    expect(bad.passed).toBe(false);
    expect(bad.failures.map((f) => f.kind)).toEqual(['selectedVariant', 'visible', 'hidden', 'approvedLocale', 'noBlocking']);
  });

  it('workflow transitions and role permissions', () => {
    expect(transitionProblem('draft', 'submit')).toBeNull();
    expect(transitionProblem('draft', 'approve')).toMatch(/in review/);
    expect(transitionProblem('approved', 'publish')).toBeNull();
    expect(transitionProblem('in_review', 'publish')).not.toBeNull();
    expect(roleCan('reviewer', 'edit')).toBe(false);
    expect(roleCan('reviewer', 'request_changes')).toBe(true);
    expect(roleCan('approver', 'approve')).toBe(true);
    expect(roleCan('author', 'approve')).toBe(false);
    expect(roleCan('admin', 'manage_users')).toBe(true);
  });

  it('sanitizeCommentBody keeps plain text and strips control characters', () => {
    expect(sanitizeCommentBody('  hi\u0000 <b>there</b>\r\n\n\n\nok‮ ')).toBe('hi <b>there</b>\n\nok');
    expect(sanitizeCommentBody(42)).toBe('');
  });
});

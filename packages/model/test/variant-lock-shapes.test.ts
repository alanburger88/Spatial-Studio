import { describe, expect, it } from 'vitest';
import { buildHousehold } from '../src/samples/index';
import { applyCommand, makeVariant, mergeVariantUpdate, variantLockProblem } from '../src/index';
import type { Project } from '../src/types';

/**
 * Variants and richer data shapes together (wave 5): a variant of a document with groups, a list inside a list and a
 * repeating section. What a base section repeats for is page structure, so it stays the base's; the data fields are
 * already locked. A variant may still change wording inside the section, and an update from the base carries a change
 * to the repeat setting in.
 */
const base = buildHousehold();
const variant = (): Project => makeVariant(base, { projectId: 'household-lakeshore', title: 'Household — Lakeshore', purpose: 'region', label: 'Lakeshore' });
const section = (p: Project) => p.nodes.find((n) => n.repeat)!;

describe('a variant of a document with a repeating section', () => {
  it('starts with no lock problem and the same repeating section', () => {
    const v = variant();
    expect(section(v).repeat).toEqual(section(base).repeat);
    expect(variantLockProblem(base, v)).toBeNull();
  });

  it('cannot change what a base section repeats for, or stop it repeating', () => {
    const v = variant();
    const id = section(v).id;
    const changed: Project = { ...v, nodes: v.nodes.map((n) => (n.id === id ? { ...n, repeat: { ...n.repeat!, newPage: !n.repeat!.newPage } } : n)) };
    expect(variantLockProblem(v, changed)).toMatchObject({ part: 'repeat', nodeId: id });
    expect(variantLockProblem(v, changed)!.message).toMatch(/comes from the base document/);
    const stopped: Project = { ...v, nodes: v.nodes.map((n) => (n.id === id ? { ...n, repeat: undefined } : n)) };
    expect(variantLockProblem(v, stopped)).toMatchObject({ part: 'repeat', nodeId: id });
  });

  it('the command bus refuses it too, and refuses a change to the data fields', () => {
    const v = variant();
    const id = section(v).id;
    const r = applyCommand(v, { type: 'UPDATE_NODE', nodeId: id, patch: { repeat: { ...section(v).repeat!, newPage: !section(v).repeat!.newPage } } } as never);
    expect(r.ok).toBe(false);
    const f = applyCommand(v, { type: 'SET_CUSTOM_FIELDS', fields: (v.customFields ?? []).slice(1) } as never);
    expect(f.ok).toBe(false);
  });

  it('an update from the base brings a changed repeat setting in', () => {
    const v = variant();
    const id = section(base).id;
    const newer: Project = { ...base, modelVersion: base.modelVersion + 1, nodes: base.nodes.map((n) => (n.id === id ? { ...n, repeat: { ...n.repeat!, newPage: !n.repeat!.newPage } } : n)) };
    const update = mergeVariantUpdate({ ancestor: base, base: newer, variant: v });
    expect(section(update.project).repeat).toEqual(section(newer).repeat);
  });
});

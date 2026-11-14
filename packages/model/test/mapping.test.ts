import { describe, expect, it } from 'vitest';
import { seedProjects } from '../src/fixtures';
import {
  MAPPINGS_MAX, applyCommand, diffProjects, mappablePaths, mappingSlugs, nextMappingId, projectFileContentOf, projectFileProblems, targetTypeKind, templateContentOf, typeClash,
  type Command, type Project,
} from '../src/index';

const card = (): Project => structuredClone(seedProjects().find((p) => p.projectId === 'aster-card-demo')!) as Project;
const run = (p: Project, ...cs: Command[]): Project => cs.reduce((q, c) => { const r = applyCommand(q, c); if (!r.ok) throw new Error(`${c.type}: ${r.message}`); return r.project; }, p);
const refused = (p: Project, c: Command) => { const r = applyCommand(p, c); expect(r.ok, `${c.type} should be refused`).toBe(false); return r.ok ? null : r; };
const STAMP = { by: 'Ada Approver', at: '2026-11-14T10:00:00Z' };
const add: Command = { type: 'ADD_MAPPING', mapping: { id: 'map-core', name: 'Mapping for Core Banking', system: 'Core Banking', description: 'Statement feed' }, stamp: STAMP };

describe('mapping commands', () => {
  it('adds a named mapping as one undoable step, with who and when', () => {
    const p = card();
    const r = applyCommand(p, add);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.modelVersion).toBe(p.modelVersion + 1);
    expect(r.project.mappings).toEqual([{ id: 'map-core', name: 'Mapping for Core Banking', system: 'Core Banking', description: 'Statement feed', created: STAMP, entries: [] }]);
    expect(r.label).toBe('Add the mapping “Mapping for Core Banking”');
    expect(p.mappings).toBeUndefined(); // pure: the input is untouched
  });

  it('refuses bad ids, empty names, duplicates, too many, bad stamps and markup', () => {
    const p = run(card(), add);
    expect(refused(card(), { type: 'ADD_MAPPING', mapping: { id: 'Bad Id', name: 'X', system: 'Y' } })?.code).toBe('INVALID_MAPPING');
    expect(refused(card(), { type: 'ADD_MAPPING', mapping: { id: 'map-x', name: ' ', system: 'Y' } })?.message).toMatch(/name of a mapping is required/);
    expect(refused(card(), { type: 'ADD_MAPPING', mapping: { id: 'map-x', name: 'X', system: '' } })?.message).toMatch(/target system/);
    expect(refused(card(), { type: 'ADD_MAPPING', mapping: { id: 'map-x', name: 'X <b>', system: 'Y' } })?.message).toMatch(/cannot contain < or >/);
    expect(refused(p, { ...add, mapping: { ...(add as any).mapping, name: 'Other' } })?.code).toBe('DUPLICATE_ID');
    expect(refused(p, { type: 'ADD_MAPPING', mapping: { id: 'map-2', name: 'mapping for core banking', system: 'Y' } })?.code).toBe('DUPLICATE');
    expect(refused(card(), { ...add, stamp: { by: 'Ada', at: 'yesterday' } })?.message).toMatch(/UTC time/);
    let many = card();
    for (let i = 0; i < MAPPINGS_MAX; i++) many = run(many, { type: 'ADD_MAPPING', mapping: { id: `map-${i}`, name: `M${i}`, system: 'S' } });
    expect(refused(many, { type: 'ADD_MAPPING', mapping: { id: 'map-x', name: 'X', system: 'S' } })?.code).toBe('TOO_MANY');
  });

  it('renames, changes details, and removes (the last removal leaves no trace)', () => {
    const p = run(card(), add);
    const renamed = run(p, { type: 'RENAME_MAPPING', mappingId: 'map-core', name: 'Core statement feed', system: 'Core v2', description: '', stamp: STAMP });
    expect(renamed.mappings![0]).toMatchObject({ name: 'Core statement feed', system: 'Core v2', changed: STAMP });
    expect(renamed.mappings![0].description).toBeUndefined();
    expect(refused(p, { type: 'RENAME_MAPPING', mappingId: 'map-core', name: 'Mapping for Core Banking' })?.code).toBe('NO_CHANGE');
    expect(refused(p, { type: 'RENAME_MAPPING', mappingId: 'nope', name: 'X' })?.code).toBe('NOT_FOUND');
    const removed = run(p, { type: 'REMOVE_MAPPING', mappingId: 'map-core' });
    expect('mappings' in removed).toBe(false);
  });

  it('imports a target field list (names unique, ignoring case) and keeps entries', () => {
    const p = run(card(), add, { type: 'SET_MAPPING_ENTRY', mappingId: 'map-core', entry: { path: 'card.dueDate', target: 'DUE_DT' } });
    const q = run(p, { type: 'IMPORT_TARGET_FIELDS', mappingId: 'map-core', fields: [{ name: ' NEW_BAL ', type: 'DECIMAL(10,2)', description: 'New balance' }, { name: 'DUE_DT', type: 'DATE' }] });
    expect(q.mappings![0].targetFields).toEqual([{ name: 'NEW_BAL', type: 'DECIMAL(10,2)', description: 'New balance' }, { name: 'DUE_DT', type: 'DATE' }]);
    expect(q.mappings![0].entries).toHaveLength(1);
    expect(refused(p, { type: 'IMPORT_TARGET_FIELDS', mappingId: 'map-core', fields: [{ name: 'A' }, { name: 'a' }] })?.message).toMatch(/listed twice/);
    expect(refused(p, { type: 'IMPORT_TARGET_FIELDS', mappingId: 'map-core', fields: [{ name: '' }] })?.code).toBe('INVALID_TARGET_FIELDS');
    expect(refused(p, { type: 'IMPORT_TARGET_FIELDS', mappingId: 'map-core', fields: [{ name: 'x'.repeat(121) }] })?.message).toMatch(/limited to 120/);
  });

  it('sets, clears and bulk-sets entries; refuses unknown fields and contradictions', () => {
    const p = run(card(), add);
    const one = run(p, { type: 'SET_MAPPING_ENTRY', mappingId: 'map-core', entry: { path: 'card.newBalanceCents', target: ' NEW_BAL ', targetType: 'money', format: 'divide by 100', note: '' }, stamp: STAMP });
    expect(one.mappings![0].entries).toEqual([{ path: 'card.newBalanceCents', target: 'NEW_BAL', targetType: 'money', format: 'divide by 100' }]);
    expect(one.mappings![0].changed).toEqual(STAMP);
    // a list's column is a mappable path too
    expect(run(p, { type: 'SET_MAPPING_ENTRY', mappingId: 'map-core', entry: { path: 'card.transactions[].amountCents', target: 'TXN_AMT' } }).mappings![0].entries[0].path).toBe('card.transactions[].amountCents');
    expect(refused(p, { type: 'SET_MAPPING_ENTRY', mappingId: 'map-core', entry: { path: 'card.nope', target: 'X' } })?.message).toMatch(/not a data field/);
    expect(refused(p, { type: 'SET_MAPPING_ENTRY', mappingId: 'map-core', entry: { path: 'card.tier', target: 'TIER', notNeeded: { reason: 'n/a' } } })?.message).toMatch(/cannot both/);
    expect(refused(p, { type: 'SET_MAPPING_ENTRY', mappingId: 'map-core', entry: { path: 'card.tier', notNeeded: { reason: ' ' } } })?.message).toMatch(/reason .* is required/);
    expect(refused(p, { type: 'SET_MAPPING_ENTRY', mappingId: 'map-core', entry: { path: 'card.tier', target: 'T', extra: 1 } as any })?.message).toMatch(/does not know/);
    // an entry with nothing left in it is cleared
    expect(run(one, { type: 'SET_MAPPING_ENTRY', mappingId: 'map-core', entry: { path: 'card.newBalanceCents', target: ' ' } }).mappings![0].entries).toEqual([]);
    const cleared = run(one, { type: 'CLEAR_MAPPING_ENTRY', mappingId: 'map-core', path: 'card.newBalanceCents' });
    expect(cleared.mappings![0].entries).toEqual([]);
    expect(refused(cleared, { type: 'CLEAR_MAPPING_ENTRY', mappingId: 'map-core', path: 'card.newBalanceCents' })?.code).toBe('NOT_FOUND');
    const bulk = applyCommand(p, { type: 'SET_MAPPING_ENTRIES', mappingId: 'map-core', entries: [{ path: 'card.dueDate', target: 'DUE' }, { path: 'card.tier', notNeeded: { reason: 'The target has one tier' } }] });
    expect(bulk.ok && bulk.project.mappings![0].entries.length).toBe(2);
    expect(bulk.ok && bulk.project.modelVersion).toBe(p.modelVersion + 1);
    expect(bulk.ok && bulk.label).toBe('Map 2 fields in “Mapping for Core Banking”');
    expect(refused(p, { type: 'SET_MAPPING_ENTRIES', mappingId: 'map-core', entries: [{ path: 'card.dueDate', target: 'A' }, { path: 'card.dueDate', target: 'B' }] })?.message).toMatch(/set twice/);
    expect(refused(p, { type: 'SET_MAPPING_ENTRIES', mappingId: 'map-core', entries: [] })?.code).toBe('EMPTY');
    expect(refused(bulk.ok ? bulk.project : p, { type: 'SET_MAPPING_ENTRIES', mappingId: 'map-core', entries: [{ path: 'card.dueDate', target: 'DUE' }] })?.code).toBe('NO_CHANGE');
  });

  it('a batch of mapping changes is one step and all-or-nothing', () => {
    const p = card();
    const r = applyCommand(p, { type: 'BATCH', label: 'Import target list', commands: [add, { type: 'IMPORT_TARGET_FIELDS', mappingId: 'map-core', fields: [{ name: 'DUE' }] }, { type: 'SET_MAPPING_ENTRY', mappingId: 'map-core', entry: { path: 'card.dueDate', target: 'DUE' } }] });
    expect(r.ok && r.project.modelVersion).toBe(p.modelVersion + 1);
    const bad = applyCommand(p, { type: 'BATCH', label: 'x', commands: [add, { type: 'SET_MAPPING_ENTRY', mappingId: 'map-core', entry: { path: 'card.nope', target: 'X' } }] });
    expect(bad.ok).toBe(false);
  });

  it('removing a data field never makes a document with a mapping impossible to store (the entry stays, the checks report it)', () => {
    let p = structuredClone(card());
    p = run(p, { type: 'SET_CUSTOM_FIELDS', fields: [{ key: 'branch', label: 'Branch', type: 'string' }] }, add, { type: 'SET_MAPPING_ENTRY', mappingId: 'map-core', entry: { path: 'custom.branch', target: 'BRANCH' } });
    p = run(p, { type: 'SET_CUSTOM_FIELDS', fields: [] });
    expect(p.mappings![0].entries[0].path).toBe('custom.branch');
    expect(projectFileProblems(p)).toEqual([]);
  });
});

describe('types', () => {
  it('reads target types whatever words the target uses', () => {
    const cases: Array<[string, string]> = [['VARCHAR(40)', 'text'], ['string', 'text'], ['xs:string', 'text'], ['enum', 'text'], ['INTEGER', 'integer'], ['NUMBER(10)', 'integer'], ['NUMBER(10,2)', 'decimal'], ['DECIMAL(12,2)', 'decimal'], ['numeric', 'decimal'], ['float', 'decimal'], ['number', 'number'], ['money', 'money'], ['Currency', 'money'], ['DATE', 'date'], ['xs:date', 'date'], ['DATETIME', 'datetime'], ['date-time', 'datetime'], ['timestamp', 'datetime'], ['boolean', 'boolean'], ['bit', 'boolean'], ['array', 'list'], ['Transaction[]', 'list'], ['repeating group', 'list'], ['', 'unknown'], ['blob', 'unknown']];
    for (const [raw, kind] of cases) expect(targetTypeKind(raw), raw).toBe(kind);
  });
  it('states the type rules: what clashes and what agrees', () => {
    expect(typeClash('cents', 'text')).toBe('An amount in whole cents is mapped to a text field.');
    expect(typeClash('date', 'integer')).toBe('A date is mapped to a whole-number field.');
    expect(typeClash('date', 'number')).toBe('A date is mapped to a number field.');
    expect(typeClash('array', 'text')).toBe('A list is mapped to a single value (a text field).');
    expect(typeClash('string', 'list')).toBe('A single value is mapped to a list.');
    expect(typeClash('bool', 'text')).toBe('A yes-or-no value is mapped to a text field.');
    for (const [t, k] of [['cents', 'integer'], ['cents', 'money'], ['cents', 'decimal'], ['date', 'datetime'], ['string', 'text'], ['enum', 'text'], ['int', 'number'], ['bool', 'boolean'], ['array', 'list'], ['cents', 'unknown']] as const) expect(typeClash(t, k), `${t}→${k}`).toBeNull();
  });
});

describe('mappings in files, templates, slugs and the diff', () => {
  it('project-file checks read mappings as untrusted text', () => {
    const p = run(card(), add, { type: 'SET_MAPPING_ENTRY', mappingId: 'map-core', entry: { path: 'card.dueDate', target: 'DUE' } });
    expect(projectFileProblems(p)).toEqual([]);
    const bad = structuredClone(p) as any;
    bad.mappings[0].entries.push({ path: 'card.tier', target: '<script>' });
    bad.mappings.push({ id: 'map-core', name: 'Dup', system: 'S', entries: [] });
    const problems = projectFileProblems(bad).filter((x) => x.code === 'MAPPING').map((x) => x.message).join(' ');
    expect(problems).toMatch(/cannot contain < or >/);
    expect(problems).toMatch(/share the id/);
    expect(projectFileProblems({ ...structuredClone(p), mappings: 'nope' } as any).some((x) => x.code === 'MAPPING')).toBe(true);
  });
  it('templates and project files carry mappings', () => {
    const p = run(card(), add);
    expect(templateContentOf(p).mappings).toEqual(p.mappings);
    expect(projectFileContentOf(p).mappings).toEqual(p.mappings);
  });
  it('file names are unique and stable; new ids are free', () => {
    expect([...mappingSlugs([{ id: 'a', name: 'Mapping for Core' }, { id: 'b', name: 'mapping for CORE!' }, { id: 'c', name: '***' }]).values()]).toEqual(['mapping-for-core', 'mapping-for-core-2', 'mapping']);
    expect(nextMappingId([{ id: 'map-mapping-for-core' }], 'Mapping for Core')).toBe('map-mapping-for-core-2');
  });
  it('mappable paths include each list column', () => {
    const paths = mappablePaths(card());
    expect(paths.get('card.transactions[].amountCents')).toEqual({ type: 'cents', label: 'Transactions · Amount' });
    expect(paths.has('card.availableCreditCents')).toBe(true);
  });
  it('the project diff reports mappings added, changed and removed, and ignores who and when', () => {
    const a = card();
    const b = run(a, add);
    expect(diffProjects(a, b).mappings).toEqual({ added: [{ id: 'map-core', name: 'Mapping for Core Banking', system: 'Core Banking' }], removed: [], changed: [] });
    expect(diffProjects(a, b).summary.counts.mappings).toBe(1);
    const c = run(b, { type: 'SET_MAPPING_ENTRIES', mappingId: 'map-core', entries: [{ path: 'card.dueDate', target: 'DUE' }, { path: 'card.tier', target: 'TIER' }] }, { type: 'RENAME_MAPPING', mappingId: 'map-core', name: 'Core feed', stamp: STAMP }, { type: 'IMPORT_TARGET_FIELDS', mappingId: 'map-core', fields: [{ name: 'DUE' }] });
    const d = diffProjects(b, c).mappings!;
    expect(d.changed[0]).toMatchObject({ id: 'map-core', renamed: { from: 'Mapping for Core Banking', to: 'Core feed' }, targetFields: { from: 0, to: 1 }, entries: { added: 2, removed: 0, changed: 0 } });
    expect(diffProjects(c, run(a)).mappings!.removed).toHaveLength(1);
    // only the stamp differs: not a change
    const stampOnly = structuredClone(c); stampOnly.mappings![0].changed = { by: 'Someone else', at: '2026-11-15T10:00:00Z' };
    expect(diffProjects(c, stampOnly).mappings).toBeUndefined();
    expect(diffProjects(a, a).mappings).toBeUndefined();
    expect('mappings' in diffProjects(a, structuredClone(a))).toBe(false);
  });
});

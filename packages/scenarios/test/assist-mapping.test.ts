import { describe, expect, it } from 'vitest';
import { applyCommand, type Command, type MappingEntry, type Project, type TargetMapping } from '@iss/model';
import { seedProjects } from '../../model/src/fixtures';
import { depthProject } from '../../model/test/helpers/depthProject';
import { dataDictionary, mappingChecks, mappingCsv, mappingFile, readTargetFieldList, suggestTargetMatches, summarizeChanges } from '../src';

const [card, eob] = seedProjects();
const mapping = (entries: MappingEntry[] = [], targetFields?: TargetMapping['targetFields']): TargetMapping => ({ id: 'map-core', name: 'Mapping for Core', system: 'Core', entries, ...(targetFields ? { targetFields } : {}) });
const TYPES: Record<string, string> = { string: 'VARCHAR(80)', enum: 'VARCHAR(20)', cents: 'BIGINT', int: 'INTEGER', points: 'INTEGER', date: 'DATE', bool: 'BOOLEAN', array: 'ARRAY', number: 'DECIMAL(12,4)' };
/** A mapping that maps every field that must be mapped, each to a target of an agreeing type. */
function fullMapping(p: Project): TargetMapping {
  const rows = mappingChecks(p, mapping()).rows.filter((r) => r.required);
  return mapping(rows.map((r) => ({ path: r.path, target: `T_${r.path.replace(/\W+/g, '_').toUpperCase()}`, targetType: TYPES[r.type] })));
}

describe('mapping checks', () => {
  it('an empty mapping lists every field the document reads as unmapped, and is not complete', () => {
    const c = mappingChecks(card, mapping());
    expect(c.complete).toBe(false);
    expect(c.counts.unmapped).toBe(c.counts.required);
    expect(c.rows.some((r) => r.path === 'documentType')).toBe(false);
    // the fields to map are the dictionary's "needed" fields that are not calculated, plus the columns the document reads
    const dict = dataDictionary(card);
    const inputs = dict.fields.filter((f) => f.needed && !f.calculated && f.path !== 'documentType').map((f) => f.path);
    expect(c.rows.filter((r) => r.required && !r.list).map((r) => r.path)).toEqual(inputs);
    expect(c.rows.filter((r) => r.required && r.list).map((r) => r.path)).toEqual(['card.transactions[].id', 'card.transactions[].date', 'card.transactions[].merchant', 'card.transactions[].amountCents']);
    expect(c.findings.filter((f) => f.kind === 'unmapped')).toHaveLength(c.counts.unmapped);
    expect(c.findings.find((f) => f.kind === 'unmapped')!.message).toMatch(/is not mapped\. Choose the target field, or mark it “not needed by the target” with a reason\./);
  });

  it('is complete once everything is mapped or marked not needed, with agreeing types', () => {
    for (const p of [card, eob, depthProject()]) {
      const m = fullMapping(p);
      const c = mappingChecks(p, m);
      expect(c.complete, p.projectId).toBe(true);
      expect(c.counts.unmapped + c.counts.clashes + c.counts.mappedTwice).toBe(0);
      // "not needed" with a reason counts as decided
      const withNotNeeded = { ...m, entries: m.entries.map((e) => (e.path === 'recordId' ? { path: e.path, notNeeded: { reason: 'The target numbers customers itself' } } : e)) };
      expect(mappingChecks(p, withNotNeeded).counts.notNeeded).toBe(p.projectId === 'gym-notice' ? 1 : 1);
      expect(mappingChecks(p, withNotNeeded).complete).toBe(true);
    }
  });

  it('a list marked not needed does not need its columns', () => {
    const m = fullMapping(card);
    const entries = m.entries.filter((e) => !e.path.startsWith('card.transactions')).concat([{ path: 'card.transactions', notNeeded: { reason: 'The target lists transactions itself' } }]);
    const c = mappingChecks(card, { ...m, entries });
    expect(c.complete).toBe(true);
    expect(c.rows.filter((r) => r.list).every((r) => !r.required)).toBe(true);
  });

  it('a target field mapped from two document fields is a problem', () => {
    const m = fullMapping(card);
    m.entries = m.entries.map((e) => (e.path === 'card.dueDate' || e.path === 'card.statementEnd' ? { ...e, target: 'DATE_1' } : e));
    const c = mappingChecks(card, m);
    expect(c.complete).toBe(false);
    expect(c.counts.mappedTwice).toBe(1);
    const f = c.findings.find((x) => x.kind === 'mapped-twice')!;
    expect(f.paths.sort()).toEqual(['card.dueDate', 'card.statementEnd']);
    expect(f.message).toBe('The target field “DATE_1” is mapped from “Statement period end” and “Payment due date”. A target field takes one document field.');
    // the same name in two lists' columns is not a clash between them (each list is its own structure)
    const twoLists = mappingChecks(eob, { ...fullMapping(eob), entries: fullMapping(eob).entries.map((e) => (e.path === 'claims[].status' ? { ...e, target: 'STATUS' } : e.path === 'claim.status' ? { ...e, target: 'STATUS' } : e)) });
    expect(twoLists.counts.mappedTwice).toBe(0);
  });

  it('reports each type clash in plain words', () => {
    const base = fullMapping(card);
    const withType = (path: string, targetType: string) => mappingChecks(card, { ...base, entries: base.entries.map((e) => (e.path === path ? { ...e, targetType } : e)) });
    const clash = (path: string, t: string) => withType(path, t).findings.find((f) => f.kind === 'type-clash')?.message;
    expect(clash('card.newBalanceCents', 'VARCHAR(20)')).toMatch(/An amount in whole cents is mapped to a text field\. The target’s type “VARCHAR\(20\)” is read as text\./);
    expect(clash('card.dueDate', 'NUMBER(8)')).toMatch(/A date is mapped to a whole-number field/);
    expect(clash('card.transactions', 'VARCHAR(4000)')).toMatch(/A list is mapped to a single value/);
    expect(clash('card.tier', 'array')).toMatch(/A single value is mapped to a list/);
    expect(clash('card.assistanceRequested', 'string')).toMatch(/A yes-or-no value is mapped to a text field/);
    expect(withType('card.dueDate', 'NUMBER(8)').complete).toBe(false);
    // an unrecognised type is never a clash
    expect(withType('card.dueDate', 'BLOB').counts.clashes).toBe(0);
    // the type comes from the target's list when the entry has none
    const fromList = mappingChecks(card, mapping([{ path: 'card.newBalanceCents', target: 'NEW_BAL' }], [{ name: 'new_bal', type: 'CHAR(12)' }]));
    expect(fromList.rows.find((r) => r.path === 'card.newBalanceCents')).toMatchObject({ targetType: 'CHAR(12)', targetKind: 'text' });
    expect(fromList.counts.clashes).toBe(1);
    // cents to money: agrees, with a note to say cents or dollars
    expect(withType('card.newBalanceCents', 'MONEY').findings.find((f) => f.kind === 'amount-format')?.message).toMatch(/Say in the format note whether the target expects cents or dollars/);
  });

  it('lists calculated fields with their formula in plain words, lookup tables and the document’s date', () => {
    const c = mappingChecks(card, mapping());
    expect(c.calculated.find((x) => x.path === 'card.availableCreditCents')).toEqual({ path: 'card.availableCreditCents', label: 'Available credit', inWords: 'Worked out by the studio from “Credit limit” and “New balance”.', formula: null });
    expect(c.findings.find((f) => f.kind === 'calculated' && f.paths[0] === 'card.availableCreditCents')!.message).toMatch(/The target must supply or compute this\.$/);
    const d = depthProject();
    const cd = mappingChecks(d, mapping());
    const late = cd.calculated.find((x) => x.path === 'calc.lateFee')!;
    expect(late.formula).toMatch(/LOOKUP/);
    expect(late.inWords.length).toBeGreaterThan(10);
    expect(cd.rows.find((r) => r.path === 'calc.lateFee')).toMatchObject({ calculated: true, required: false, status: 'optional' });
    expect(cd.lookupTables.map((t) => t.id).sort()).toEqual(['feeByTier', 'rates']);
    expect(cd.findings.some((f) => f.kind === 'lookup-table' && /Late fee by tier/.test(f.message))).toBe(true);
    expect(cd.documentDate).toBe('given for each run (not part of the customer’s data)');
    expect(mappingChecks(depthProject({ dateFrom: 'field' }), mapping()).documentDate).toBe('taken from “Statement date”');
    // mapping a calculated field says the target supplies it; it is never required
    const supplied = mappingChecks(d, mapping([{ path: 'calc.lateFee', target: 'LATE_FEE', targetType: 'money' }]));
    expect(supplied.rows.find((r) => r.path === 'calc.lateFee')!.status).toBe('mapped');
    expect(supplied.counts.optionalMapped).toBe(1);
  });

  it('reports entries for fields the document no longer has, and targets not in the target list', () => {
    const c = mappingChecks(card, mapping([{ path: 'custom.gone', target: 'X' }, { path: 'card.dueDate', target: 'DUE' }], [{ name: 'OTHER' }]));
    expect(c.findings.find((f) => f.kind === 'stale-entry')!.message).toMatch(/no longer a data field of this document\. Clear it\./);
    expect(c.findings.find((f) => f.kind === 'not-in-target-list')!.message).toBe('“Payment due date” goes to “DUE”, which is not in the target’s field list.');
  });
});

describe('suggested matches from a target field list', () => {
  it('reads CSV header variants and says which columns were recognised', () => {
    const r = readTargetFieldList('﻿Field Name,Data Type,Meaning,Owner\nNEW_BALANCE,"DECIMAL(10,2)",Balance,Ops\nDueDate,DATE,,Ops\nNEW_BALANCE,INT,dup,\n,INT,,\n');
    expect(r.columns).toEqual({ name: 'Field Name', type: 'Data Type', description: 'Meaning' });
    expect(r.ignored).toEqual(['Owner']);
    expect(r.fields).toEqual([{ name: 'NEW_BALANCE', type: 'DECIMAL(10,2)', description: 'Balance' }, { name: 'DueDate', type: 'DATE' }]);
    expect(r.problems.join(' ')).toMatch(/listed more than once/);
    expect(r.types).toEqual([{ type: 'DATE', readAs: 'date' }, { type: 'DECIMAL(10,2)', readAs: 'decimal' }]);
    // a bare list of names
    expect(readTargetFieldList('FIRST_NM\nLAST_NM\n').fields.map((f) => f.name)).toEqual(['FIRST_NM', 'LAST_NM']);
    expect(readTargetFieldList('').problems).toEqual(['The file is empty.']);
  });

  it('pre-selects exact and likely matches and only offers guesses', () => {
    const fields = readTargetFieldList('name,type\ncard.dueDate,DATE\nNEW_BALANCE,"DECIMAL(10,2)"\nFirstName,VARCHAR(40)\nMinimum Pymt,money\nRewardz balanse,int\n').fields;
    const s = suggestTargetMatches(card, mapping(), fields);
    const by = (t: string) => s.find((x) => x.target === t)!;
    expect(by('card.dueDate')).toMatchObject({ path: 'card.dueDate', confidence: 'exact', preselected: true });
    expect(by('NEW_BALANCE')).toMatchObject({ path: 'card.newBalanceCents', confidence: 'likely', preselected: true, targetType: 'DECIMAL(10,2)' });
    expect(by('FirstName')).toMatchObject({ path: 'customer.givenName', confidence: 'likely', preselected: true });
    const guesses = s.filter((x) => x.confidence === 'guess');
    expect(guesses.length).toBeGreaterThan(0);
    expect(guesses.every((g) => !g.preselected && /^A guess/.test(g.reason))).toBe(true);
    // fields already decided are left alone
    expect(suggestTargetMatches(card, mapping([{ path: 'card.dueDate', target: 'X' }]), fields).some((x) => x.path === 'card.dueDate')).toBe(false);
  });
});

describe('the mapping file', () => {
  it('has one row per dictionary field (and list column), in dictionary order, deterministically', () => {
    const m = fullMapping(card);
    const f = mappingFile(card, m);
    expect(f.formatVersion).toBe(1);
    expect(f.complete).toBe(true);
    expect(f.fields.map((x) => x.path)).toEqual(mappingChecks(card, m).rows.map((r) => r.path));
    expect(f.fields.find((x) => x.path === 'card.newBalanceCents')).toMatchObject({ target: { name: 'T_CARD_NEWBALANCECENTS', type: 'BIGINT', typeReadAs: 'integer' }, required: true, status: 'mapped' });
    expect(JSON.stringify(mappingFile(card, m))).toBe(JSON.stringify(f));
    const csv = mappingCsv(card, m);
    expect(csv.split('\r\n')[0]).toBe('path,label,type,calculated,required,status,target,targetType,format,notNeededReason,note,example');
    expect(csv.split('\r\n').length).toBe(f.fields.length + 2);
  });
});

describe('change summary', () => {
  it('says what changed in the mappings, in plain words', () => {
    const run = (p: Project, ...cs: Command[]) => cs.reduce((q, c) => { const r = applyCommand(q, c); if (!r.ok) throw new Error(r.message); return r.project; }, p);
    const after = run(card, { type: 'ADD_MAPPING', mapping: { id: 'map-core', name: 'Mapping for Core', system: 'Core' } });
    const s1 = summarizeChanges(card, after, []);
    expect(s1.sections.flatMap((x) => x.items)).toContain('Mapping “Mapping for Core” added, for “Core”');
    const later = run(after, { type: 'SET_MAPPING_ENTRIES', mappingId: 'map-core', entries: [{ path: 'card.dueDate', target: 'DUE' }, { path: 'card.tier', target: 'TIER' }] }, { type: 'RENAME_MAPPING', mappingId: 'map-core', system: 'Core v2' });
    expect(summarizeChanges(after, later, []).sections.flatMap((x) => x.items)).toContain('Mapping “Mapping for Core”: now for “Core v2”; 2 fields mapped');
  });
});

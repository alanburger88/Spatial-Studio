import { describe, expect, it } from 'vitest';
import { applyCommand, calculationUsage, defaultNode, richFromMarkup, type Command, type Project } from '../src';
import { depthProject } from './helpers/depthProject';

const ok = (p: Project, c: Command): Project => { const r = applyCommand(p, c); if (!r.ok) throw new Error(r.message); return r.project; };

describe('calculationUsage gives structured places', () => {
  // Two components and two rules with the same names, all using a calculation, and a calculation whose name has quotes.
  let p = depthProject();
  const lateFee = { op: 'field', path: 'calc.lateFee' } as const;
  p = ok(p, { type: 'INSERT_NODE', node: { ...defaultNode('rich-text', 'fee-note-2', 'custom', p), name: 'Fee note', content: richFromMarkup('Again: {{calc.lateFee}}.') }, parentId: 'doc-root' });
  p = ok(p, { type: 'UPSERT_CALCULATED_FIELD', field: { key: 'doubleFee', label: 'The “double” fee', type: 'money', expr: { op: 'add', a: lateFee, b: lateFee } } });
  const r03 = p.rules.find((r) => r.id === 'R03')!;
  p = ok(p, { type: 'UPSERT_RULE', rule: { ...r03, id: 'R09', priority: 255 } });
  const usage = (key: string) => calculationUsage(p).find((u) => u.key === key)!;

  it('keeps two components with the same name apart, by node id, and names a calculation by key', () => {
    const u = usage('lateFee');
    expect(u.uses.filter((x) => x.kind === 'component' && x.label === 'Fee note').map((x) => x.nodeId)).toEqual(['fee-note', 'fee-note-2']);
    expect(u.uses.filter((x) => x.kind === 'calculation')).toEqual([{ kind: 'calculation', id: 'doubleFee', label: 'calculation “The “double” fee”' }]);
    // the words stay as they were (one entry per name), for the refusal message
    expect(u.where.filter((w) => w === 'Fee note')).toEqual(['Fee note']);
  });

  it('names rules by id, components by node id, and the SMS as a channel', () => {
    const rules = usage('renewSoon').uses.filter((x) => x.kind === 'rule');
    expect(rules.map((x) => x.id)).toEqual(['R03', 'R09']);
    expect(p.rules.find((r) => r.id === 'R09')!.title).toBe(p.rules.find((r) => r.id === 'R03')!.title);
    const days = usage('daysToRenewal').uses;
    expect(days.some((x) => x.kind === 'channel')).toBe(true);
    expect(days.filter((x) => x.kind === 'calculation').map((x) => x.id)).toEqual(['renewSoon']);
    const spin = usage('spinTotal').uses.filter((x) => x.kind === 'component');
    expect(spin.map((x) => x.nodeId)).toEqual(expect.arrayContaining(['spin-note', 'sessions']));
    expect(spin.every((x) => x.nodeId === x.id)).toBe(true);
  });

  it('every structured place has words that are also in `where`', () => {
    for (const u of calculationUsage(p)) for (const x of u.uses) expect(u.where).toContain(x.label);
  });
});

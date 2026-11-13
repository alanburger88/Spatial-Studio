import { calcTypeOfField, validateCalculatedFields, formulaInWords, wordsScopeOf, projectFieldIndex, type CalculatedField, type Expr, type FieldDef, type Project } from '@iss/model';
import { keyFromLabel } from './model';

/**
 * Worked examples to start from, made only from fields the document really has (and checked with the engine before
 * they are offered), so an example is never something the document's data cannot support. No test of the kind of
 * document: the fields decide.
 */

export interface CalcExample { id: string; title: string; field: CalculatedField; words: string }

const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function examplesFor(project: Project): CalcExample[] {
  const fields = [...projectFieldIndex(project).values()];
  const plain = fields.filter((f) => !f.calculated && !f.documentDate);
  const taken = new Set((project.calculatedFields ?? []).map((c) => c.key));
  const labels = new Set([...(project.calculatedFields ?? []).map((c) => c.label.toLowerCase()), ...fields.map((f) => f.label.toLowerCase())]);
  const of = (t: string) => plain.filter((f) => f.type !== 'array' && calcTypeOfField(f) === t);
  const candidates: Array<{ id: string; label: string; type: CalculatedField['type']; description: string; expr: Expr }> = [];

  const dates = of('date');
  if (dates.length >= 2) {
    const [a, b] = dates;
    candidates.push({ id: 'days', label: `Days from ${a.label.toLowerCase()} to ${b.label.toLowerCase()}`, type: 'number', description: 'The number of days between two dates in the customer’s data.', expr: { op: 'days', from: { op: 'field', path: a.path }, to: { op: 'field', path: b.path } } });
  } else if (dates.length === 1 && project.documentDate) {
    candidates.push({ id: 'days', label: `Days from ${dates[0].label.toLowerCase()} to the document date`, type: 'number', description: 'The number of days from a date in the customer’s data to the document’s date.', expr: { op: 'days', from: { op: 'field', path: dates[0].path }, to: { op: 'issueDate' } } });
  }
  const money = of('money');
  if (money.length >= 2) {
    const [a, b] = money;
    candidates.push({ id: 'difference', label: `${a.label} less ${b.label.toLowerCase()}`, type: 'money', description: 'One amount taken away from another.', expr: { op: 'sub', a: { op: 'field', path: a.path }, b: { op: 'field', path: b.path } } });
  }
  if (money.length >= 1) {
    const a = money[0];
    candidates.push({ id: 'percent', label: `Ten percent of ${a.label.toLowerCase()}`, type: 'money', description: 'A share of an amount, rounded to the cent.', expr: { op: 'round', places: 2, arg: { op: 'mul', a: { op: 'field', path: a.path }, b: { op: 'number', value: 0.1 } } } });
  }
  for (const list of plain.filter((f) => f.type === 'array' && f.itemFields?.length)) {
    const col = list.itemFields!.find((c) => calcTypeOfField(c) === 'money') ?? list.itemFields!.find((c) => calcTypeOfField(c) === 'number');
    if (col) {
      const t = calcTypeOfField(col)!;
      candidates.push({ id: `total-${list.path}`, label: `Total of ${col.label.toLowerCase()} in ${list.label.toLowerCase()}`, type: t, description: 'The total of one column of a list.', expr: { op: 'sum', list: list.path, column: col.key } });
    }
    candidates.push({ id: `count-${list.path}`, label: `Number of rows in ${list.label.toLowerCase()}`, type: 'number', description: 'How many rows a list has.', expr: { op: 'count', list: list.path } });
  }
  const counts = of('number');
  if (counts.length) {
    const f = counts[0] as FieldDef;
    candidates.push({ id: 'atleast', label: `${f.label} is at least 2`, type: 'bool', description: 'Yes when a number reaches a limit.', expr: { op: 'if', when: { op: 'gte', path: f.path, value: 2 }, then: { op: 'bool', value: true }, else: { op: 'bool', value: false } } });
  }

  const out: CalcExample[] = [];
  const all = project.calculatedFields ?? [];
  for (const c of candidates) {
    if (out.length >= 3) break;
    const label = trim(c.label.charAt(0).toUpperCase() + c.label.slice(1), 60);
    if (labels.has(label.toLowerCase())) continue;
    const field: CalculatedField = { key: keyFromLabel(label, taken, `calc${out.length + 1}`), label, type: c.type, description: c.description, expr: c.expr };
    if (validateCalculatedFields(project, [...all, field]).length) continue;
    out.push({ id: c.id, title: label, field, words: formulaInWords(c.expr, wordsScopeOf(project, projectFieldIndex(project))) });
  }
  return out;
}

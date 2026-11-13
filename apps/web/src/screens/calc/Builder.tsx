import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { checkExpr, exprChildren, type CalcType, type CalcValue, type EvalStep, type Expr, type FieldDef } from '@iss/model';
import { Icon } from '../../ui/icons';
import { ConditionEditor } from './ConditionEditor';
import {
  KIND_LABEL, childWant, conditionFields, defaultFor, formatCalcValue, kindOf, kindsFor, listColumns, listsFor, pickableCalcs, pickableFields, replaceAt, rowFieldsOf, seedCondition, slotLabel, tablesFor,
  type Ctx, type Expected, type KindId,
} from './model';

/**
 * The builder view: the calculation as a tree of steps. Each step is chosen from a list that offers only what is valid
 * where it sits, and shows its own value for the current customer (the engine's step-by-step evaluation).
 */

interface Shared {
  root: Expr;
  ctx: Ctx;
  steps: Map<string, EvalStep>;
  haveSteps: boolean;
  problems: Map<string, string[]>;
  types: Map<string, CalcType | null>;
  locale: string;
  tech: boolean;
  disabled: boolean;
  change: (path: string, next: Expr) => void;
}
const B = createContext<Shared>(null as unknown as Shared);

function TextBox({ value, onCommit, label, className }: { value: string; onCommit: (s: string) => void; label: string; className?: string }) {
  return <input className={`input ${className ?? ''}`} aria-label={label} value={value} onChange={(e) => onCommit(e.target.value)} />;
}

/** A number or an amount in dollars: kept as typed until it reads as one. */
function NumBox({ value, onCommit, label, money }: { value: number; onCommit: (n: number) => void; label: string; money?: boolean }) {
  const show = (n: number) => (money ? (n / 100).toFixed(2) : String(n));
  const [txt, setTxt] = useState(show(value));
  const re = money ? /^-?\d+(\.\d{1,2})?$/ : /^-?\d+(\.\d+)?$/;
  useEffect(() => { setTxt((t) => ((money ? Math.round(Number(t) * 100) : Number(t)) === value && re.test(t.trim()) ? t : show(value))); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const ok = re.test(txt.trim());
  return (
    <span className="cb-valwrap">
      {money && <span className="muted" aria-hidden="true">$</span>}
      <input className="input cb-num" aria-label={label} inputMode="decimal" value={txt} aria-invalid={!ok || undefined}
        onChange={(e) => { setTxt(e.target.value); const t = e.target.value.trim(); if (re.test(t)) onCommit(money ? Math.round(Number(t) * 100) : Number(t)); }} />
    </span>
  );
}

const PLACES_MONEY = [{ v: 2, l: 'to the cent' }, { v: 1, l: 'to ten cents' }, { v: 0, l: 'to the dollar' }];

function Params({ e, at, want, label }: { e: Expr; at: string; want: Expected; label: string }) {
  const { ctx, change, disabled, tech } = useContext(B);
  const set = (next: Expr) => change(at, next);
  switch (e.op) {
    case 'field': {
      if (e.path === 'document.date') return <span className="muted">the document’s date</span>;
      if (e.path.startsWith('calc.')) {
        const list = pickableCalcs(ctx, want);
        const cur = e.path.slice(5);
        return (
          <select className="select cb-pick" aria-label={`${label}: calculation`} disabled={disabled} value={cur} onChange={(x) => set({ op: 'field', path: `calc.${x.target.value}` })}>
            {!list.some((c) => c.key === cur) && <option value={cur}>{ctx.project.calculatedFields?.find((c) => c.key === cur)?.label ?? cur} (not allowed here)</option>}
            {list.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        );
      }
      const list = pickableFields(ctx, want);
      return (
        <span className="cb-pickwrap">
          <select className="select cb-pick" aria-label={`${label}: data field`} disabled={disabled} value={e.path} onChange={(x) => set({ op: 'field', path: x.target.value })}>
            {!list.some((f) => f.path === e.path) && <option value={e.path}>{ctx.fields.find((f) => f.path === e.path)?.label ?? e.path} (not allowed here)</option>}
            {list.map((f) => <option key={f.path} value={f.path}>{f.label}</option>)}
          </select>
          {tech && <span className="chip code" title="Field path">{e.path}</span>}
        </span>
      );
    }
    case 'number': return <NumBox label={`${label}: number`} value={e.value} onCommit={(value) => set({ op: 'number', value })} />;
    case 'money': return <NumBox money label={`${label}: amount in dollars`} value={e.cents} onCommit={(cents) => set({ op: 'money', cents })} />;
    case 'text': return <TextBox label={`${label}: fixed text`} value={e.value} onCommit={(value) => set({ op: 'text', value })} />;
    case 'date': return <input className="input" type="date" aria-label={`${label}: date`} disabled={disabled} value={e.value} onChange={(x) => x.target.value && set({ op: 'date', value: x.target.value })} />;
    case 'bool': return <select className="select" aria-label={`${label}: yes or no`} disabled={disabled} value={String(e.value)} onChange={(x) => set({ op: 'bool', value: x.target.value === 'true' })}><option value="true">Yes</option><option value="false">No</option></select>;
    case 'round': {
      const money = want === 'money';
      const opts = money ? PLACES_MONEY : Array.from({ length: 7 }, (_, i) => ({ v: i, l: i === 0 ? 'to a whole number' : `to ${i} decimal place${i === 1 ? '' : 's'}` }));
      return (
        <select className="select" aria-label={`${label}: how it rounds`} disabled={disabled} value={e.places} onChange={(x) => set({ ...e, places: Number(x.target.value) })}>
          {!opts.some((o) => o.v === e.places) && <option value={e.places}>{e.places} places</option>}
          {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
        </select>
      );
    }
    case 'join': return <label className="cb-inline">between parts <TextBox className="cb-sep" label={`${label}: text between the parts`} value={e.sep} onCommit={(sep) => set({ ...e, sep })} /></label>;
    case 'count': case 'sum': case 'smallest': case 'largest': {
      const lists = e.op === 'count' ? ctx.lists : listsFor(ctx, e.op, want as CalcType);
      const list = ctx.fields.find((f) => f.path === e.list);
      const t = (want === 'joinable' ? 'number' : want) as CalcType;
      const cols = e.op === 'count' ? [] : listColumns(list, [t]);
      const rowFields = rowFieldsOf(ctx.scope, e.list);
      return (
        <>
          <select className="select cb-pick" aria-label={`${label}: list`} disabled={disabled} value={e.list} onChange={(x) => {
            const nl = ctx.fields.find((f) => f.path === x.target.value);
            const column = e.op === 'count' ? '' : listColumns(nl, [t])[0]?.key ?? '';
            set(e.op === 'count' ? { op: 'count', list: x.target.value } : { op: e.op, list: x.target.value, column });
          }}>
            {!lists.some((l) => l.path === e.list) && <option value={e.list}>{list?.label ?? (e.list || 'Choose a list')}</option>}
            {lists.map((l) => <option key={l.path} value={l.path}>{l.label}</option>)}
          </select>
          {e.op !== 'count' && (
            <select className="select" aria-label={`${label}: column`} disabled={disabled} value={e.column} onChange={(x) => set({ ...e, column: x.target.value })}>
              {!cols.some((c) => c.key === e.column) && <option value={e.column}>{e.column || 'Choose a column'}</option>}
              {cols.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          )}
          <label className="cb-inline"><input type="checkbox" disabled={disabled || !rowFields} checked={!!e.where} onChange={(x) => {
            const { where: _w, ...rest } = e;
            set(x.target.checked && rowFields ? { ...rest, where: seedCondition([...rowFields.values()]) } as Expr : rest as Expr);
          }} /> only rows where…</label>
        </>
      );
    }
    case 'lookup': {
      const t = (want === 'joinable' ? 'text' : want) as CalcType;
      const tables = tablesFor(ctx, t);
      const table = ctx.tables.find((x) => x.id === e.table);
      return (
        <>
          <select className="select cb-pick" aria-label={`${label}: table`} disabled={disabled} value={e.table} onChange={(x) => set(relookup(e, x.target.value, t, ctx))}>
            {!tables.some((x) => x.id === e.table) && <option value={e.table}>{table?.title ?? (e.table || 'Choose a table')}</option>}
            {tables.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
          </select>
          <select className="select" aria-label={`${label}: column of the table`} disabled={disabled} value={e.column} onChange={(x) => set({ ...e, column: x.target.value })}>
            {!(table?.columns ?? []).some((c) => c.key === e.column) && <option value={e.column}>{e.column || 'Choose a column'}</option>}
            {(table?.columns ?? []).filter((c) => c.type === t).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </>
      );
    }
    default: return null;
  }
}

/** Another table: its first column of the right kind, and a starting value for each of its keys. */
function relookup(e: Extract<Expr, { op: 'lookup' }>, tableId: string, t: CalcType, ctx: Ctx): Expr {
  const table = ctx.tables.find((x) => x.id === tableId);
  const seeded = defaultFor('lookup', t, { ...ctx, tables: table ? [table] : ctx.tables }) as Extract<Expr, { op: 'lookup' }>;
  return { ...e, table: tableId, column: table?.columns.find((c) => c.type === t)?.key ?? '', keys: seeded.keys };
}

function valueText(s: Shared, at: string): { text: string; missing: boolean; raw: string } | null {
  const st = s.steps.get(at);
  if (!st) return s.haveSteps ? { text: 'not needed for this customer', missing: false, raw: '' } : null;
  if (st.value === null) return { text: st.missing?.message ?? 'no value', missing: true, raw: '' };
  const t = s.types.get(at) ?? null;
  return { text: formatCalcValue(t, st.value as CalcValue, s.locale), missing: false, raw: String(st.value) };
}

function Step({ e, at, want, parent, slot, onRemove }: { e: Expr; at: string; want: Expected; parent: Expr | null; slot: string; onRemove?: () => void }) {
  const s = useContext(B);
  const { ctx, change, disabled } = s;
  const id = at || 'root';
  const label = slotLabel(parent, slot, ctx);
  const kind = kindOf(e);
  const kinds = kindsFor(want, ctx);
  const own = problems(s, at);
  const v = valueText(s, at);
  const kids = exprChildren(e);
  return (
    <li className="cb-step" data-testid={`step-${id}`} data-kind={kind}>
      <div className="cb-line">
        <span className="cb-slot">{label}</span>
        <div className="cb-controls">
        <select className="select cb-kind" aria-label={`${label}: kind of step`} data-testid={`step-kind-${id}`} disabled={disabled} value={kind}
          onChange={(x) => change(at, defaultFor(x.target.value as KindId, want, ctx))}>
          {!kinds.includes(kind) && <option value={kind}>{KIND_LABEL[kind]}</option>}
          {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <Params e={e} at={at} want={want} label={label} />
        </div>
        {v && <span className={`cb-val${v.missing ? ' missing' : ''}${v.raw === '' && !v.missing ? ' off' : ''}`} data-testid={`step-value-${id}`} data-raw={v.raw} title={v.missing ? v.text : undefined}>{v.missing ? <><Icon.warning width={12} height={12} /> {v.text}</> : v.raw === '' ? v.text : <>= <strong>{v.text}</strong></>}</span>}
        {onRemove && <button type="button" className="btn ghost sm icon" aria-label={`Remove ${label.toLowerCase()}`} disabled={disabled} onClick={onRemove}><Icon.close /></button>}
      </div>
      {own.map((m, i) => <p key={i} className="cb-problem" data-testid={`step-problem-${id}`}><Icon.warning width={13} height={13} /> {m}</p>)}
      {e.op === 'if' && (
        <div className="cb-if">
          <span className="cb-slot">When</span>
          <ConditionEditor label={`${label}: condition`} value={e.when} fields={conditionFields(ctx)} fieldIndex={ctx.scope.fields} onChange={(when) => change(at, { ...e, when })} />
        </div>
      )}
      {(e.op === 'count' || e.op === 'sum' || e.op === 'smallest' || e.op === 'largest') && e.where && rowFieldsOf(ctx.scope, e.list) && (
        <div className="cb-if">
          <span className="cb-slot">Rows where</span>
          <ConditionEditor label={`${label}: row condition`} value={e.where} fields={[...rowFieldsOf(ctx.scope, e.list)!.values()] as FieldDef[]} fieldIndex={rowFieldsOf(ctx.scope, e.list)!} onChange={(where) => change(at, { ...e, where })} />
        </div>
      )}
      {kids.length > 0 && (
        <ul className="cb-children">
          {kids.map(([k, c]) => {
            const path = at ? `${at}.${k}` : k;
            const variadic = (e.op === 'min' || e.op === 'max' || e.op === 'join') && k.includes('.');
            const count = e.op === 'min' || e.op === 'max' ? e.args.length : e.op === 'join' ? e.parts.length : 0;
            const minCount = e.op === 'join' ? 1 : 2;
            const idx = Number(k.split('.')[1]);
            const remove = variadic && count > minCount
              ? () => change(at, e.op === 'join' ? { ...e, parts: e.parts.filter((_, i) => i !== idx) } : { ...(e as Extract<Expr, { op: 'min' | 'max' }>), args: (e as Extract<Expr, { op: 'min' | 'max' }>).args.filter((_, i) => i !== idx) })
              : undefined;
            return <Step key={path} e={c} at={path} want={childWant(e, k, want, ctx)} parent={e} slot={k} onRemove={remove} />;
          })}
          {(e.op === 'min' || e.op === 'max' || e.op === 'join') && (
            <li className="cb-add">
              <button type="button" className="btn sm" disabled={disabled || (e.op === 'join' ? e.parts.length >= 20 : e.args.length >= 20)} data-testid={`step-add-${id}`}
                onClick={() => change(at, e.op === 'join' ? { ...e, parts: [...e.parts, defaultFor('constText', 'joinable', ctx)] } : { ...e, args: [...e.args, defaultFor(want === 'money' ? 'constMoney' : 'constNumber', want, ctx)] })}>
                <Icon.plus /> Add a {e.op === 'join' ? 'part' : 'value'}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

const problems = (s: Shared, at: string): string[] => s.problems.get(at) ?? [];

export interface BuilderProps {
  expr: Expr;
  want: CalcType;
  ctx: Ctx;
  steps: EvalStep[];
  problems: Map<string, string[]>;
  locale: string;
  tech: boolean;
  disabled: boolean;
  onChange: (e: Expr) => void;
}

export function Builder(p: BuilderProps) {
  const stepMap = useMemo(() => new Map(p.steps.map((x) => [x.at, x])), [p.steps]);
  const types = useMemo(() => {
    const m = new Map<string, CalcType | null>();
    const walk = (e: Expr, at: string) => { m.set(at, checkExpr(e, p.ctx.scope).type); for (const [k, c] of exprChildren(e)) walk(c, at ? `${at}.${k}` : k); };
    walk(p.expr, '');
    return m;
  }, [p.expr, p.ctx]);
  const shared: Shared = { root: p.expr, ctx: p.ctx, steps: stepMap, haveSteps: p.steps.length > 0, problems: p.problems, types, locale: p.locale, tech: p.tech, disabled: p.disabled, change: (path, next) => p.onChange(replaceAt(p.expr, path, next)) };
  return (
    <B.Provider value={shared}>
      <ul className="cb-tree" data-testid="calc-builder" aria-label="Steps of the calculation">
        <Step e={p.expr} at="" want={p.want} parent={null} slot="" />
      </ul>
    </B.Provider>
  );
}

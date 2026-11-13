import { useEffect, useId, useState } from 'react';
import { Tech } from '../../ui/common';
import { Icon } from '../../ui/icons';
import { blankRow, countFields, getIn, otherValues, underPath, type GroupNode, type ListNode, type OtherValue, type RowField, type TreeNode } from './explorerModel';
import { FieldRow, ScalarInput, useEditor } from './Fields';

const PAGE = 25;

/** A collapsible group of fields that mirrors one object of the record. Top level groups are the record's sections. */
export function GroupView({ node, depth }: { node: GroupNode; depth: number }) {
  const ed = useEditor();
  const [open, setOpen] = useState(depth === 0);
  const bodyId = useId();
  useEffect(() => { if (ed.jump && underPath(ed.jump.path, node.path)) setOpen(true); }, [ed.jump, node.path]);
  const bad = ed.problems.filter((p) => p.path && underPath(p.path, node.path)).length;
  const n = countFields(node);
  return (
    <section className={`dx-group depth-${depth}${bad ? ' has-problem' : ''}`} data-testid={depth === 0 ? `dx-section-${node.key}` : `dx-nest-${node.path}`}>
      <h3 className="dx-group-head">
        <button type="button" className="dx-toggle" aria-expanded={open} aria-controls={bodyId} data-testid={depth === 0 ? `dx-section-toggle-${node.key}` : `dx-nest-toggle-${node.path}`} onClick={() => setOpen(!open)}>
          <Icon.chevron className="dx-chev" aria-hidden="true" width={14} height={14} />
          <span className="dx-group-title">{node.label}</span>
          {!(node.children.length === 1 && node.children[0].kind === 'list') && <span className="chip count">{n} {n === 1 ? 'field' : 'fields'}</span>}
          {bad > 0 && <span className="chip warning dx-bad-mark" title={`${bad} value${bad === 1 ? '' : 's'} to fix`}><Icon.warning width={12} height={12} aria-hidden="true" />{bad} to fix</span>}
        </button>
      </h3>
      {open && <div className="dx-group-body" id={bodyId}>{node.children.map((c) => <NodeView key={c.kind === 'group' ? `g${c.key}` : c.def.path} node={c} depth={depth} />)}</div>}
    </section>
  );
}

function NodeView({ node, depth }: { node: TreeNode; depth: number }) {
  const ed = useEditor();
  if (node.kind === 'group') return <GroupView node={node} depth={depth + 1} />;
  if (node.kind === 'list') return <ListBlock node={node} />;
  const d = node.def;
  return (
    <FieldRow path={d.path} label={d.label} type={d.type} required={d.required} enumValues={d.enumValues} derived={d.derived} clearable
      value={getIn(ed.record, node.segs)} derivedValue={getIn(ed.values, node.segs)} isLocale={d.path === 'customer.locale'}
      onChange={(v) => ed.set(node.segs, v)} />
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A list inside the tree: a compact editable table; items with more fields than columns get an expander. */
function ListBlock({ node }: { node: ListNode }) {
  const ed = useEditor();
  const path = node.def.path;
  const rows: Array<Record<string, unknown>> = Array.isArray(getIn(ed.record, node.segs)) ? getIn(ed.record, node.segs) : [];
  const [open, setOpen] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const bodyId = useId();
  const extra = node.rowFields.length > node.columns.length;
  const bad = ed.problems.filter((p) => p.path && underPath(p.path, path)).length;
  const label = node.def.label;

  useEffect(() => {
    const j = ed.jump;
    if (!j || !underPath(j.path, path)) return;
    setOpen(true);
    const m = /\[(\d+)\]\.([A-Za-z0-9_]+)/.exec(j.path.slice(path.length));
    if (m) {
      const i = Number(m[1]);
      setLimit((l) => Math.max(l, i + 1));
      if (!node.columns.some((c) => c.key === m[2])) setExpanded((s) => new Set(s).add(i));
    }
  }, [ed.jump, path, node.columns]);

  const put = (next: Array<Record<string, unknown>>) => ed.set(node.segs, next);
  const add = () => { put([...rows, blankRow(node.rowFields)]); setLimit((l) => Math.max(l, rows.length + 1)); };
  const del = (i: number) => { put(rows.filter((_, k) => k !== i)); setExpanded(new Set([...expanded].filter((k) => k !== i).map((k) => (k > i ? k - 1 : k)))); };
  const dup = (i: number) => { const copy = [...rows]; copy.splice(i + 1, 0, JSON.parse(JSON.stringify(rows[i]))); put(copy); setExpanded(new Set([...expanded].map((k) => (k > i ? k + 1 : k)))); };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d; if (j < 0 || j >= rows.length) return;
    const copy = [...rows]; [copy[i], copy[j]] = [copy[j], copy[i]]; put(copy);
    setExpanded(new Set([...expanded].map((k) => (k === i ? j : k === j ? i : k))));
  };
  const toggleRow = (i: number) => setExpanded((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const shown = rows.slice(0, limit);
  const cell = (c: RowField, i: number, compact: boolean) => {
    const p = `${path}[${i}].${c.key}`;
    return <ScalarInput type={c.type} value={rows[i]?.[c.key]} label={`${c.label}, row ${i + 1}`} path={p} testId={`dx-c-${path}-${i}-${c.key}`} enumValues={c.enumValues} required={c.required}
      disabled={ed.readOnly} compact={compact} invalid={ed.problems.some((q) => q.path === p)} onChange={(v) => ed.set([...node.segs, i, c.key], v)} />;
  };

  return (
    <div className={`dx-list${bad ? ' has-problem' : ''}`} data-testid={`dx-list-${path}`}>
      <div className="dx-list-head">
        <button type="button" className="dx-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
          <Icon.chevron className="dx-chev" aria-hidden="true" width={14} height={14} />
          <span className="dx-group-title" data-testid={`dx-list-title-${path}`}>{label} · {plural(rows.length, 'row', 'rows')}</span>
          <Tech><span className="chip code">{path}</span></Tech>
          {bad > 0 && <span className="chip warning dx-bad-mark"><Icon.warning width={12} height={12} aria-hidden="true" />{bad} to fix</span>}
        </button>
        <button type="button" className="btn sm" data-testid="dx-list-add" disabled={ed.readOnly} onClick={add} aria-label={`Add row to ${label}`}><Icon.plus width={14} height={14} /> Add row</button>
      </div>
      {open && (
        <div id={bodyId} className="dx-list-body">
          {rows.length === 0 ? <p className="muted dx-empty-list">No rows yet.{!ed.readOnly && ' Use “Add row” to add the first one.'}</p> : (
            <div className="dx-table-wrap" tabIndex={0} role="region" aria-label={`${label} table`}>
              <table className="table dx-table">
                <thead><tr>
                  <th scope="col" className="dx-n">#</th>
                  {node.columns.map((c) => <th key={c.key} scope="col" className={c.type === 'cents' ? 'num' : ''}>{c.label}</th>)}
                  <th scope="col" className="dx-actions-h"><span className="dx-sr">Row actions</span></th>
                </tr></thead>
                <tbody>
                  {shown.map((_, i) => {
                    const isOpen = expanded.has(i);
                    return (
                      <RowGroup key={i}>
                        <tr data-testid={`dx-trow-${path}-${i}`} className={isOpen ? 'open' : ''}>
                          <td className="dx-n">{i + 1}</td>
                          {node.columns.map((c) => { const hl = ed.highlight.includes(`${path}[${i}].${c.key}`); return <td key={c.key} className={`dx-cell t-${c.type}${hl ? ' highlight' : ''}`} data-highlight={hl ? 'yes' : undefined}>{cell(c, i, true)}</td>; })}
                          <td className="dx-actions">
                            {extra && <button type="button" className="btn ghost sm icon" data-testid="dx-row-expand" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} all fields of row ${i + 1}`} title="All fields of this row" onClick={() => toggleRow(i)}><Icon.chevron className="dx-chev" width={14} height={14} /></button>}
                            <button type="button" className="btn ghost sm icon" data-testid="dx-row-up" disabled={ed.readOnly || i === 0} aria-label={`Move row ${i + 1} up`} title="Move up" onClick={() => move(i, -1)}>↑</button>
                            <button type="button" className="btn ghost sm icon" data-testid="dx-row-down" disabled={ed.readOnly || i === rows.length - 1} aria-label={`Move row ${i + 1} down`} title="Move down" onClick={() => move(i, 1)}>↓</button>
                            <button type="button" className="btn ghost sm icon" data-testid="dx-row-dup" disabled={ed.readOnly} aria-label={`Duplicate row ${i + 1}`} title="Duplicate" onClick={() => dup(i)}><Icon.copy width={14} height={14} /></button>
                            <button type="button" className="btn ghost sm icon" data-testid="dx-row-del" disabled={ed.readOnly} aria-label={`Delete row ${i + 1}`} title="Delete" onClick={() => del(i)}><Icon.trash width={14} height={14} /></button>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="dx-detail-row" data-testid={`dx-detail-${path}-${i}`}>
                            <td colSpan={node.columns.length + 2}>
                              <div className="dx-nested" role="group" aria-label={`All fields of row ${i + 1}`}>
                                <div className="dx-nested-title">Row {i + 1} · more fields</div>
                                {node.rowFields.filter((f) => !node.columns.some((c) => c.key === f.key)).map((f) => (
                                  <FieldRow key={f.key} path={`${path}[${i}].${f.key}`} testId={`dx-x-${path}-${i}-${f.key}`} label={f.fullLabel ?? f.label} type={f.type} required={f.required} enumValues={f.enumValues}
                                    value={rows[i]?.[f.key]} clearable onChange={(v) => ed.set([...node.segs, i, f.key], v)} />
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </RowGroup>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {rows.length > limit && (
            <div className="dx-more">
              <span className="muted">Showing {limit} of {rows.length} rows</span>
              <button type="button" className="btn sm" data-testid="dx-list-more" onClick={() => setLimit(limit + PAGE)}>Show {Math.min(PAGE, rows.length - limit)} more</button>
              <button type="button" className="btn ghost sm" onClick={() => setLimit(rows.length)}>Show all</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RowGroup({ children }: { children: React.ReactNode }) { return <>{children}</>; }

/** Values the data contract does not know. They are kept on save but cannot be changed here. */
export function OtherValues({ items }: { items: OtherValue[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!items.length) return null;
  const MAX = 60;
  return (
    <section className="dx-group depth-0 dx-other" data-testid="dx-other">
      <h3 className="dx-group-head">
        <button type="button" className="dx-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          <Icon.chevron className="dx-chev" aria-hidden="true" width={14} height={14} />
          <span className="dx-group-title">Other values</span>
          <span className="chip count">{items.length}</span>
        </button>
      </h3>
      {open && (
        <div className="dx-group-body" id={id}>
          <p className="muted dx-other-note">These values are not part of this document’s data fields. They are kept when you save, but cannot be changed here. Use the JSON view to change them.</p>
          <dl className="dx-other-list">
            {items.slice(0, MAX).map((o) => (
              <div key={o.path} className="dx-other-row"><dt>{o.path.split('.').slice(-1)[0].replace(/\[\d+\]/, '')}<span className="chip code" title={o.path}>{o.path}</span></dt><dd><code>{typeof o.value === 'string' ? o.value : JSON.stringify(o.value)}</code></dd></div>
            ))}
          </dl>
          {items.length > MAX && <p className="muted">and {items.length - MAX} more.</p>}
        </div>
      )}
    </section>
  );
}

export { otherValues };

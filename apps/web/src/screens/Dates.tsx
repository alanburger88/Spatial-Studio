import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { dayNumber, dayWords, documentDateUse, isIsoDay, type DocumentDateSource, type Project, type SyntheticRecord } from '@iss/model';
import { dateChecks, documentTimeline, type DateCheck, type TimelineEntry } from '@iss/scenarios';
import { Empty, Loading, ScreenHeader } from '../ui/common';
import { nodeTitle, ruleTitle } from '../ui/plain';
import { recordSummary } from '../shell/RecordPicker';
import { editBlockedReason, usePreviewDate, useStudio } from '../state/store';
import { boundaryDays, dateFieldsOf, nextBoundary, quickPicks, sourceWords } from './dates/model';
import './Dates.css';

/**
 * S24 Dates: where the document's date comes from, the "As issued on" preview date, the timeline of every day on which
 * something changes (from the engine's `documentTimeline`), and problems in time (`dateChecks`). The source is part of
 * the model (one undoable command); the preview date is a scenario setting and never changes the model.
 */
export function Dates() {
  const project = useStudio((s) => s.project);
  if (!project) return <Loading label="Loading project…" />;
  return (
    <section className="screen" data-testid="dates-screen">
      <ScreenHeader id="S24" title="Dates" subtitle="Where the document’s date comes from, the day the preview is worked out for (“As issued on”), what starts and ends on which day and how many test customers it reaches, and gaps and overlaps in time. The studio never uses today’s date." />
      {project.documentDate ? <DatedBody project={project} /> : (
        <div className="screen-body dt-body dt-body-empty">
          <div className="panel"><div className="panel-body"><SourcePanel project={project} /></div></div>
          <div className="panel" data-testid="dates-empty">
            <div className="panel-body">
              <Empty title="This document does not use dates" message="Every customer gets the same document whatever day it is issued on.">
                <div className="dt-empty-text">
                  <p>Dates let part of the document change on a day you choose: a rule that applies from 1 January, a message that is used only in winter, a section shown until the end of an offer. The studio decides this from <strong>the document’s own date</strong> (a date in the customer’s data, or a date given for each run), never from today’s date.</p>
                  <p><strong>To start:</strong> choose where the document’s date comes from (on the left). Then put a rule in effect from a date in Rules &amp; Data, or give a message’s alternative or a conditional section a period in the Design Studio. The timeline and the checks for gaps and overlaps appear here.</p>
                </div>
              </Empty>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
export default Dates;

/* ----------------------------------------------------------- where the date comes from */

function SourcePanel({ project }: { project: Project }) {
  const dispatch = useStudio((s) => s.dispatch);
  const blocked = useStudio((s) => editBlockedReason(s.session));
  const fields = useMemo(() => dateFieldsOf(project), [project]);
  const src = project.documentDate;
  const [fieldPath, setFieldPath] = useState(src?.source === 'field' ? src.path : fields[0]?.path ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (src?.source === 'field') setFieldPath(src.path); }, [src]);
  const use = documentDateUse(project);
  const choose = (next: DocumentDateSource | null) => {
    const out = dispatch({ type: 'SET_DOCUMENT_DATE', source: next });
    setError(out.ok ? null : out.message);
  };
  const kind = src?.source ?? 'none';
  return (
    <div className="dt-source">
      <h2 className="section-title">Where the document’s date comes from</h2>
      <div role="radiogroup" aria-label="Where the document’s date comes from" className="dt-source-options" data-testid="dates-source" data-value={kind}>
        <label className="dt-option">
          <input type="radio" name="dt-source" checked={kind === 'none'} disabled={!!blocked} onChange={() => choose(null)} data-testid="dates-source-none" />
          <span><strong>None</strong><span className="muted">The document does not use dates.</span></span>
        </label>
        <label className="dt-option">
          <input type="radio" name="dt-source" checked={kind === 'field'} disabled={!!blocked || !fields.length} onChange={() => fieldPath && choose({ source: 'field', path: fieldPath })} data-testid="dates-source-field" />
          <span><strong>A date in the customer’s data</strong><span className="muted">{fields.length ? 'For example the statement date. Each customer’s own date is used.' : 'This document has no date field in its data yet. Add one under Data fields in Rules & Data.'}</span></span>
        </label>
        {fields.length > 0 && (
          <div className="dt-field-pick">
            <label htmlFor="dt-field">Date field</label>
            <select id="dt-field" className="select" value={fieldPath} disabled={!!blocked} onChange={(e) => { setFieldPath(e.target.value); if (kind === 'field') choose({ source: 'field', path: e.target.value }); }} data-testid="dates-source-field-select">
              {fields.map((f) => <option key={f.path} value={f.path}>{f.label}</option>)}
            </select>
          </div>
        )}
        <label className="dt-option">
          <input type="radio" name="dt-source" checked={kind === 'run'} disabled={!!blocked} onChange={() => choose({ source: 'run' })} data-testid="dates-source-run" />
          <span><strong>Given for each run</strong><span className="muted">The date is given when documents are produced (for a batch, a release run, or “As issued on” here).</span></span>
        </label>
      </div>
      {error && <div className="callout error" role="alert" data-testid="dates-source-error">{error}</div>}
      {blocked && <p className="hint">{blocked}.</p>}
      <p className="hint" data-testid="dates-source-words">{sourceWords(project)}{use.uses ? ` It is used by ${[use.periods ? `${use.periods} period${use.periods === 1 ? '' : 's'}` : '', use.calcs.length ? `${use.calcs.length} calculation${use.calcs.length === 1 ? '' : 's'}` : '', use.referenced ? 'conditions or wording' : ''].filter(Boolean).join(', ')}.` : ''}</p>
    </div>
  );
}

/* ----------------------------------------------------------- As issued on */

function IssuedOnPanel({ project }: { project: Project }) {
  const issueDate = usePreviewDate();
  const setIssueDate = useStudio((s) => s.setIssueDate);
  const [text, setText] = useState(issueDate ?? '');
  useEffect(() => setText(issueDate ?? ''), [issueDate]);
  const picks = useMemo(() => quickPicks(project), [project]);
  const src = project.documentDate!;
  return (
    <div className="dt-issued">
      <h2 className="section-title">As issued on</h2>
      <p className="dt-today"><strong>Today’s date is not used: pick a date.</strong> Every preview, check, export and test in the studio is then worked out as if the document were issued on that day. This is a preview setting: it does not change the document.</p>
      <div className="row dt-issued-row">
        <label htmlFor="dt-issued" className="dt-issued-label">Preview as issued on</label>
        <input id="dt-issued" type="date" className="input" value={text} onChange={(e) => { setText(e.target.value); if (isIsoDay(e.target.value)) setIssueDate(e.target.value); else if (!e.target.value) setIssueDate(null); }} data-testid="dates-issue-date" />
        <button type="button" className="btn sm" disabled={!issueDate} onClick={() => setIssueDate(null)} data-testid="dates-issue-clear">Clear</button>
      </div>
      <p className="hint" data-testid="dates-issue-words">
        {issueDate ? `Previewing as issued on ${dayWords(issueDate)}.` : src.source === 'field' ? 'No preview date: each customer’s own date is used.' : 'No preview date: the document has no date yet, so customers are stopped until a date is given (“this customer has no document date”).'}
      </p>
      {picks.length > 0 && (
        <>
          <h3 className="dt-subtitle">Quick picks</h3>
          <ul className="dt-picks" aria-label="Quick picks: each day something changes and the day before it">
            {picks.map((p) => (
              <li key={`${p.side}-${p.boundary}`}>
                <button type="button" className="btn sm" aria-pressed={issueDate === p.day} onClick={() => setIssueDate(p.day)} data-testid={p.side === 'on' ? `dates-pick-${p.day}` : `dates-pick-before-${p.boundary}`}>
                  {p.side === 'on' ? dayWords(p.day) : `${dayWords(p.day)} (day before)`}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- the dated document */

function DatedBody({ project }: { project: Project }) {
  const records = useStudio((s) => s.records);
  const issueDate = usePreviewDate();
  const checks = useMemo(() => dateChecks(project), [project]);
  // The timeline resolves every customer on each side of every boundary: worked out shortly after the model settles.
  const [timeline, setTimeline] = useState<{ for: Project; entries: TimelineEntry[] } | null>(null);
  useEffect(() => {
    const h = setTimeout(() => { try { setTimeline({ for: project, entries: documentTimeline(project, records) }); } catch { setTimeline({ for: project, entries: [] }); } }, 120);
    return () => clearTimeout(h);
  }, [project, records]);
  const days = boundaryDays(project);
  return (
    <div className="screen-body dt-body">
      <aside className="panel" data-side="left" data-side-title="Date settings" aria-label="Date settings">
        <div className="panel-body">
          <SourcePanel project={project} />
          <IssuedOnPanel project={project} />
        </div>
      </aside>
      <div className="panel dt-main" aria-label="Timeline">
        <div className="panel-head">Timeline <span className="sub">{days.length ? `${days.length} day${days.length === 1 ? '' : 's'} on which something changes` : 'nothing changes on any day yet'}</span></div>
        <div className="panel-body">
          {!days.length ? (
            <Empty title="Nothing starts or ends on a day yet" message="Put a rule in effect from a date in Rules & Data, or give an alternative of a message or a conditional section a period in the Design Studio. Each day something starts or ends then appears here." />
          ) : !timeline || timeline.for !== project ? <Loading label="Working out the timeline…" /> : (
            <Timeline entries={timeline.entries} issueDate={issueDate} records={records} project={project} />
          )}
        </div>
      </div>
      <aside className="panel" data-side="right" data-side-title="Problems in time" aria-label="Problems in time">
        <div className="panel-head">Problems in time <span className="sub">{checks.length ? `${checks.length} found` : 'none'}</span></div>
        <div className="panel-body flush">
          <Problems project={project} checks={checks} />
        </div>
      </aside>
    </div>
  );
}

function Timeline({ entries, issueDate, records, project }: { entries: TimelineEntry[]; issueDate: string | null; records: SyntheticRecord[]; project: Project }) {
  const setIssueDate = useStudio((s) => s.setIssueDate);
  const personas = useStudio((s) => s.personas);
  const byId = useMemo(() => new Map(records.map((r) => [r.recordId, r])), [records]);
  const next = nextBoundary(project, issueDate);
  return (
    <>
      <Strip entries={entries} issueDate={issueDate} />
      <ol className="dt-timeline list-rows" data-testid="dates-timeline" aria-label="Each day on which something changes, in date order">
        {entries.map((e) => {
          const starts = e.changes.filter((c) => c.change === 'starts');
          const ends = e.changes.filter((c) => c.change === 'ends');
          const current = issueDate === e.date;
          return (
            <li key={e.date} className={current ? 'selected' : ''} aria-current={current || undefined} data-testid={`dates-boundary-${e.date}`} data-reached={e.reached.length} data-evaluated={e.evaluated}>
              <div className="dt-day-head">
                <h3 className="dt-day">{dayWords(e.date)}</h3>
                {current && <span className="chip accent" data-testid={`dates-current-${e.date}`}>Previewing this day</span>}
                {next === e.date && issueDate && <span className="chip info">Next change after the preview date</span>}
                <span className="chip count" data-testid={`dates-boundary-reached-${e.date}`}>Reaches {e.reached.length} of {e.evaluated} synthetic customers</span>
              </div>
              {starts.length > 0 && <><div className="dt-what">Starts</div><ul className="dt-changes">{starts.map((c, i) => <li key={i}><ChangeWords project={project} change={c} /></li>)}</ul></>}
              {ends.length > 0 && <><div className="dt-what">Ends</div><ul className="dt-changes">{ends.map((c, i) => <li key={i}><ChangeWords project={project} change={c} /></li>)}</ul></>}
              {e.reached.length > 0 && (
                <details className="dt-reached">
                  <summary>Who it reaches ({e.reached.length})</summary>
                  <ul>{e.reached.map((id) => { const r = byId.get(id); const s = r ? recordSummary(r, personas) : null; return <li key={id}>{s?.name ?? id}{s?.tag ? <span className="muted"> · {s.tag}</span> : null}</li>; })}</ul>
                </details>
              )}
              <div className="row dt-day-actions">
                <button type="button" className="btn sm" aria-pressed={current} onClick={() => setIssueDate(e.date)} data-testid={`dates-use-${e.date}`}>Preview as issued on {dayWords(e.date)}</button>
                <button type="button" className="btn sm ghost" aria-pressed={issueDate === e.dayBefore} onClick={() => setIssueDate(e.dayBefore)} data-testid={`dates-use-before-${e.date}`}>The day before ({dayWords(e.dayBefore)})</button>
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** What changes on a day, in words; a dated row of a lookup table links to its table. */
function ChangeWords({ project, change }: { project: Project; change: TimelineEntry['changes'][number] }) {
  if (change.kind !== 'lookup-row' || !change.nodeId || !project.lookupTables?.some((t) => t.id === change.nodeId)) return <>{change.words}</>;
  return (
    <>{change.words}{' '}
      <Link to={`/studio/${project.projectId}/lookup-tables?table=${encodeURIComponent(change.nodeId)}`} data-testid={`dates-table-link-${change.nodeId}`}>Open the table</Link>
    </>
  );
}

/** A simple visual strip of the same days (it carries nothing the list does not: the list is the primary form). */
function Strip({ entries, issueDate }: { entries: TimelineEntry[]; issueDate: string | null }) {
  if (!entries.length) return null;
  const n = dayNumber;
  const first = n(entries[0].date), last = n(entries[entries.length - 1].date);
  const span = Math.max(1, last - first);
  const pos = (d: string) => (entries.length === 1 ? 50 : 6 + (88 * (n(d) - first)) / span);
  const inRange = issueDate && n(issueDate) >= first - span * 0.06 && n(issueDate) <= last + span * 0.06;
  // Days close together would print their labels over each other: the second goes on a lower row, and a third in the
  // same place gets no label here (the list below names every day).
  const LABEL_WIDTH = 15; // per cent of the strip a label needs
  const lastAt = [-100, -100];
  const rows = entries.map((e) => {
    const at = pos(e.date);
    const row = at - lastAt[0] >= LABEL_WIDTH ? 0 : at - lastAt[1] >= LABEL_WIDTH ? 1 : -1;
    if (row >= 0) lastAt[row] = at;
    return row;
  });
  return (
    <div className="dt-strip" aria-hidden="true" data-testid="dates-strip">
      <div className="dt-strip-line" />
      {entries.map((e, i) => (
        <div key={e.date} className={`dt-strip-mark ${issueDate === e.date ? 'on' : ''} ${rows[i] === 1 ? 'low' : ''}`} style={{ left: `${pos(e.date)}%` }}>
          <span className="dt-strip-dot" />
          {rows[i] >= 0 && <span className="dt-strip-label">{dayWords(e.date)}</span>}
        </div>
      ))}
      {issueDate && inRange && entries.every((e) => e.date !== issueDate) && <div className="dt-strip-preview" style={{ left: `${Math.min(100, Math.max(0, pos(issueDate)))}%` }} />}
    </div>
  );
}

/* ----------------------------------------------------------- problems in time */

function spanWords(c: DateCheck): string {
  return c.from && c.until ? `${dayWords(c.from)} to ${dayWords(c.until)} (not included)` : c.from ? `from ${dayWords(c.from)} on` : c.until ? `before ${dayWords(c.until)}` : 'every day';
}

function Problems({ project, checks }: { project: Project; checks: DateCheck[] }) {
  const navigate = useNavigate();
  const pid = project.projectId;
  if (!checks.length) return <div className="panel-body" data-testid="dates-problems"><p className="muted">No gaps or overlaps in time: every message has an alternative in effect on every day it is needed, and no two rules tie only during a period.</p></div>;
  const openPart = (nodeId: string) => { useStudio.getState().select(nodeId); navigate(`/studio/${pid}/design`); };
  return (
    <ul className="list-rows dt-problems" data-testid="dates-problems">
      {checks.map((c, i) => (
        <li key={i} data-testid={`dates-problem-${c.kind}`} data-from={c.from ?? ''} data-until={c.until ?? ''}>
          <div className="row"><span className={`chip ${c.severity === 'blocking' ? 'error' : 'warning'}`}>{c.kind === 'gap' ? 'Gap' : 'Overlap'}</span><strong>{spanWords(c)}</strong></div>
          <p className="dt-problem-msg">{c.message}</p>
          <div className="row wrap">
            {c.kind === 'overlap' && c.ruleIds?.map((id) => {
              const r = project.rules.find((x) => x.id === id);
              return <button key={id} type="button" className="btn sm" onClick={() => navigate(`/studio/${pid}/rules-data?rule=${encodeURIComponent(id)}`)} data-testid={`dates-problem-open-rule-${id}`}>Open rule “{r ? ruleTitle(project, r) : id}”</button>;
            })}
            {c.kind === 'gap' && c.nodeId && <button type="button" className="btn sm" onClick={() => openPart(c.nodeId!)} data-testid={`dates-problem-open-${c.nodeId}`}>Open “{nodeTitle(project, c.nodeId)}” in the Design Studio</button>}
          </div>
        </li>
      ))}
    </ul>
  );
}

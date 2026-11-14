import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { languageName, projectContentDigest, WORKFLOW_LABEL } from '@iss/model';
import {
  COMPARISON_OUTCOME_LABEL, DEFAULT_DUPLICATE_KINDS, DEFAULT_DUPLICATE_THRESHOLD, DUPLICATE_KINDS, DUPLICATE_KIND_LABEL, MIN_DUPLICATE_THRESHOLD,
  type DuplicateGroup, type DuplicateKind, type DuplicateMember,
} from '@iss/scenarios';
import { api, type LibraryDuplicatesDto, type LibraryLinkDraftsDto, type LibraryLinkPreviewDto } from '../../api/client';
import { useCan, useStudio } from '../../state/store';
import { Dialog, ErrorState, Loading } from '../../ui/common';
import { wordDiff } from '../compare/wordDiff';
import { errorText, useLibrary } from './libraryData';
import './Duplicates.css';

/**
 * The Library's Duplicates view (wave 3, section 2): wording that is the same or nearly the same in many documents, so
 * it can be kept once in the library. The scan is the server's (`GET /api/v1/library/duplicates`, the pure
 * `findDuplicateWording`); this view only filters what it returned. Nothing changes a document from here except through
 * that document: "Link here" opens it and makes one undoable, unsaved change; linking in bulk is only for exact copies in
 * draft documents and is done by the server, which refuses everything else.
 */

const LIST_LIMIT = 200;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const where = (m: DuplicateMember) => (m.source === 'library' ? `/library?item=${encodeURIComponent(m.itemId!)}` : `/studio/${m.projectId}/content`);
const clip = (s: string, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type Match = 'all' | 'exact' | 'near';

export function Duplicates() {
  const [threshold, setThreshold] = useState(DEFAULT_DUPLICATE_THRESHOLD);
  const [thresholdText, setThresholdText] = useState(String(Math.round(DEFAULT_DUPLICATE_THRESHOLD * 100)));
  const [kinds, setKinds] = useState<DuplicateKind[]>([...DEFAULT_DUPLICATE_KINDS]);
  const [language, setLanguage] = useState('');
  const [match, setMatch] = useState<Match>('all');
  const [q, setQ] = useState('');
  const [scan, setScan] = useState<LibraryDuplicatesDto | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const seq = useRef(0);

  const load = async () => {
    const n = ++seq.current;
    setStatus('loading'); setError(null);
    try {
      const r = await api.libraryDuplicates({ threshold, kinds });
      if (n === seq.current) { setScan(r); setStatus('ready'); }
    } catch (e) { if (n === seq.current) { setError(errorText(e)); setStatus('error'); } }
  };
  useEffect(() => { void load(); }, [threshold, kinds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // The threshold is typed as a percentage and applied when it is a whole number from 50 to 100.
  const commitThreshold = (text: string) => {
    setThresholdText(text);
    const n = Number(text);
    if (Number.isInteger(n) && n >= MIN_DUPLICATE_THRESHOLD * 100 && n <= 100 && n / 100 !== threshold) setThreshold(n / 100);
  };
  const thresholdBad = !(Number.isInteger(Number(thresholdText)) && Number(thresholdText) >= MIN_DUPLICATE_THRESHOLD * 100 && Number(thresholdText) <= 100);

  const groups = useMemo(() => {
    if (!scan) return [];
    const needle = q.trim().toLowerCase();
    return scan.groups.filter((g) => (!language || g.locale === language) && (match === 'all' || g.match === match)
      && (!needle || g.members.some((m) => m.plain.toLowerCase().includes(needle) || (m.projectTitle ?? m.itemTitle ?? '').toLowerCase().includes(needle))));
  }, [scan, language, match, q]);
  const selected = groups.find((g) => g.id === selectedId) ?? groups[0] ?? null;
  const filtered = !!(language || match !== 'all' || q.trim());

  return (
    <div className="screen-body dup" data-testid="dup-view">
      <div className="dup-top">
        <div className="dup-controls" role="group" aria-label="What to compare">
          <label className="dup-field">
            <span>Nearly the same from</span>
            <span className="dup-threshold">
              <input className="input" type="number" min={MIN_DUPLICATE_THRESHOLD * 100} max={100} step={1} value={thresholdText} aria-invalid={thresholdBad || undefined}
                onChange={(e) => commitThreshold(e.target.value)} data-testid="dup-threshold" aria-describedby="dup-threshold-help" />
              <span aria-hidden="true">%</span>
            </span>
          </label>
          <fieldset className="dup-kinds">
            <legend>Kinds of text</legend>
            {DUPLICATE_KINDS.map((k) => (
              <label key={k} className="dup-check">
                <input type="checkbox" checked={kinds.includes(k)} disabled={kinds.length === 1 && kinds.includes(k)}
                  onChange={(e) => setKinds((cur) => (e.target.checked ? DUPLICATE_KINDS.filter((x) => x === k || cur.includes(x)) : cur.filter((x) => x !== k)))} data-testid={`dup-kind-${k}`} />
                {DUPLICATE_KIND_LABEL[k]}
              </label>
            ))}
          </fieldset>
          <label className="dup-field">
            <span>Language</span>
            <select className="select" value={language} onChange={(e) => setLanguage(e.target.value)} data-testid="dup-language">
              <option value="">All languages</option>
              {(scan?.coverage.languages ?? []).map((l) => <option key={l} value={l}>{languageName(l)}</option>)}
            </select>
          </label>
          <div className="dup-field">
            <span id="dup-match-label">Show</span>
            <div className="segmented" role="group" aria-labelledby="dup-match-label">
              {(['all', 'exact', 'near'] as const).map((m) => <button key={m} type="button" aria-pressed={match === m} onClick={() => setMatch(m)} data-testid={`dup-match-${m}`}>{m === 'all' ? 'All' : m === 'exact' ? 'Exactly the same' : 'Nearly the same'}</button>)}
            </div>
          </div>
          <label className="dup-field dup-grow">
            <span>Find</span>
            <input className="input" type="search" placeholder="Words or a document" value={q} onChange={(e) => setQ(e.target.value)} data-testid="dup-search" />
          </label>
        </div>
        <p className="muted dup-note" id="dup-threshold-help" data-testid="dup-limit-note">
          Texts count as nearly the same when at least {pct(threshold)} of their words match, in order. Case, spacing, punctuation, quote style and formatting are ignored, and data placeholders are compared by position. It compares words, not meaning: two sentences that say the same thing in different words are not found.
        </p>
        {scan && (
          <p className="dup-coverage" data-testid="dup-coverage" data-documents={scan.coverage.documents} data-texts={scan.coverage.texts}>
            Compared {plural(scan.coverage.texts, 'text')} in {plural(scan.coverage.documents, 'saved document')}{scan.coverage.libraryItems ? ` and ${plural(scan.coverage.libraryItems, 'library wording item')}` : ''}
            {' '}({scan.coverage.languages.map((l) => languageName(l)).join(', ') || 'no languages'}) in {plural(scan.tookMs, 'millisecond')}{scan.cached ? ', from the last scan (nothing has changed since)' : ''}.
            {scan.coverage.skippedShort > 0 && <> {plural(scan.coverage.skippedShort, 'text')} under {scan.minWords} words {scan.coverage.skippedShort === 1 ? 'was' : 'were'} skipped.</>}
            {' '}<button type="button" className="btn sm ghost" onClick={() => void load()} data-testid="dup-rescan">Scan again</button>
          </p>
        )}
      </div>

      {status === 'error' ? <ErrorState title="The scan could not be done" message={error ?? ''} onRetry={() => void load()} />
        : !scan ? <Loading label="Comparing the wording of every saved document…" />
        : !groups.length ? (
          <div className="empty dup-empty" data-testid="dup-empty">
            <strong>{filtered ? 'No duplicate wording matches these filters' : `No duplicate wording found in ${plural(scan.coverage.documents, 'document')}`}</strong>
            <span>{filtered ? `The scan found ${plural(scan.groups.length, 'group')} in ${plural(scan.coverage.documents, 'document')}; change the filters to see them.` : `No ${scan.kinds.map((k) => DUPLICATE_KIND_LABEL[k].toLowerCase()).join(' or ')} of ${scan.minWords} words or more are the same or at least ${pct(scan.threshold)} the same in two places. Lower the threshold, or compare other kinds of text.`}</span>
          </div>
        ) : (
          <div className="dup-body workbench" aria-busy={status === 'loading' || undefined}>
            <aside className="panel dup-list" aria-label="Duplicate wording" data-side="left" data-side-title="Groups">
              <div className="panel-head">Groups <span className="sub" data-testid="dup-count">{groups.length} of {scan.groups.length}</span></div>
              <div className="panel-body flush">
                <ul className="list-rows" data-testid="dup-group-list">
                  {groups.slice(0, LIST_LIMIT).map((g) => {
                    const lead = g.members.find((m) => m.key === g.suggested)!;
                    return (
                      <li key={g.id} aria-current={g.id === selected?.id ? 'true' : undefined}>
                        <button type="button" className="dup-row" onClick={() => setSelectedId(g.id)} aria-pressed={g.id === selected?.id} data-testid="dup-group" data-group={g.id} data-match={g.match} data-documents={g.documents}>
                          <span className="dup-row-text">{clip(lead.plain)}</span>
                          <span className="dup-row-meta">
                            <span className="chip count">{plural(g.documents, 'document')}</span>
                            <span className={`chip ${g.match === 'exact' ? '' : 'variant'}`}>{g.match === 'exact' ? 'Exactly the same' : `Nearly the same · ${pct(g.lowestSimilarity)}`}</span>
                            {g.locale !== 'en-US' && <span className="chip">{languageName(g.locale)}</span>}
                            {g.allLinked ? <span className="chip accent">All linked</span> : g.library.length ? <span className="chip info">In the library</span> : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {groups.length > LIST_LIMIT && <p className="muted dup-pad">Showing the first {LIST_LIMIT} groups. Narrow them with the filters above.</p>}
              </div>
            </aside>
            <div className="dup-detail-wrap">{selected && <GroupDetail key={selected.id} group={selected} scan={scan} onChanged={() => void load()} />}</div>
          </div>
        )}
    </div>
  );
}

/* ------------------------------------------------------------------ one group */

function GroupDetail({ group, scan, onChanged }: { group: DuplicateGroup; scan: LibraryDuplicatesDto; onChanged: () => void }) {
  const canEdit = useCan('edit'), canApproveRole = useCan('approve');
  const can = { create: scan.can.create && canEdit, approve: scan.can.approve && canApproveRole, link: scan.can.link && canEdit };
  const [keeping, setKeeping] = useState(false);
  const [linking, setLinking] = useState<DuplicateMember | null>(null);
  const [bulk, setBulk] = useState<LibraryLinkDraftsDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const docs = new Map(scan.documents.map((d) => [d.projectId, d]));
  const suggested = group.members.find((m) => m.key === group.suggested)!;
  // The library wording this group can be linked to: an approved item in the group (a member, or linked from a member).
  const approvedItem = group.library.find((l) => l.state === 'approved') ?? group.library.find((l) => l.state === 'linked') ?? null;
  const draftItem = group.library.find((l) => l.state === 'draft') ?? null;
  const forms = [...new Set(group.members.map((m) => m.form))];
  const toLink = approvedItem ? group.members.filter((m) => m.source === 'document' && m.linkable && m.linked?.itemId !== approvedItem.itemId) : [];
  const draftTargets = toLink.filter((m) => docs.get(m.projectId!)?.workflowState === 'draft' && !m.linked);

  const approveDraft = async () => {
    if (!draftItem) return;
    setBusy(true); setMsg(null);
    try { const r = await api.approveLibraryDraft(draftItem.itemId); setMsg({ kind: 'ok', text: `Version ${r.version} of “${draftItem.title}” is approved and frozen. Each document can now link to it.` }); await useLibrary.getState().load(true); onChanged(); }
    catch (e) { setMsg({ kind: 'error', text: errorText(e) }); } finally { setBusy(false); }
  };
  const linkDrafts = async () => {
    if (!approvedItem) return;
    setBusy(true); setMsg(null);
    try { setBulk(await api.linkLibraryDrafts(approvedItem.itemId, draftTargets.map((m) => ({ projectId: m.projectId!, partId: m.partId!, modelVersion: docs.get(m.projectId!)?.modelVersion })))); await useLibrary.getState().load(true); onChanged(); }
    catch (e) { setMsg({ kind: 'error', text: errorText(e) }); } finally { setBusy(false); }
  };

  return (
    <article className="panel dup-detail" aria-labelledby="dup-detail-title" data-testid="dup-detail" data-group={group.id}>
      <div className="panel-head dup-detail-head">
        <h2 id="dup-detail-title" className="dup-detail-title">{group.match === 'exact' ? 'The same wording' : 'Nearly the same wording'} in {plural(group.documents, 'document')}</h2>
        <span className="chip">{languageName(group.locale)}</span>
        {group.kinds.map((k) => <span key={k} className="chip">{DUPLICATE_KIND_LABEL[k]}</span>)}
        {group.match === 'near' && <span className="chip variant">Lowest similarity {pct(group.lowestSimilarity)}</span>}
      </div>
      <div className="panel-body dup-detail-body">
        {group.placeholderNamesOnly && <div className="callout" data-testid="dup-placeholder-names">These texts have the same words. Only the names of their data placeholders differ, so they may fill in different data: check before keeping one.</div>}

        <section aria-labelledby="dup-lib-h">
          <h3 className="section-title" id="dup-lib-h">In the library</h3>
          {!group.library.length ? <p className="muted" data-testid="dup-lib-none">Not in the library yet.</p> : (
            <ul className="list-rows" data-testid="dup-lib">
              {group.library.map((l) => (
                <li key={l.itemId} data-state={l.state}>
                  <Link to={`/library?item=${encodeURIComponent(l.itemId)}`}>{l.title}</Link>{' '}
                  <span className={`chip ${l.state === 'draft' ? 'warning' : 'accent'}`}>{l.state === 'draft' ? `Draft version ${l.version}, waiting for approval` : `Version ${l.version}${l.state === 'linked' ? ', linked from a document' : ''}`}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="row wrap dup-actions" data-testid="dup-actions">
            {!group.library.length && can.create && group.locale === 'en-US' && <button type="button" className="btn sm primary" onClick={() => setKeeping(true)} disabled={busy} data-testid="dup-keep">Keep this wording in the library</button>}
            {!group.library.length && group.locale !== 'en-US' && <span className="muted">The library keeps English wording with its translations: keep the English group, and translations that every document shares come with it.</span>}
            {!group.library.length && !can.create && <span className="muted" data-testid="dup-readonly">Authors keep wording in the library; approvers approve it.</span>}
            {draftItem && can.approve && <button type="button" className="btn sm primary" onClick={approveDraft} disabled={busy} data-testid="dup-approve">Approve “{draftItem.title}”</button>}
            {draftItem && !can.approve && <span className="muted">An approver approves the draft; then each document can link to it.</span>}
            {approvedItem && can.link && draftTargets.length > 0 && <button type="button" className="btn sm" onClick={linkDrafts} disabled={busy} data-testid="dup-link-drafts" title="Saves a new version of each draft document whose text is exactly the library’s, so nothing a customer reads changes. Documents in review or approved are not changed.">Link in all draft documents ({draftTargets.length})</button>}
          </div>
          {msg && <div className={`callout ${msg.kind === 'error' ? 'error' : 'accent'}`} role={msg.kind === 'error' ? 'alert' : 'status'} data-testid="dup-message">{msg.text}</div>}
          {bulk && <BulkReport result={bulk} />}
        </section>

        <section aria-labelledby="dup-texts-h">
          <h3 className="section-title" id="dup-texts-h">The texts{forms.length > 1 ? ` (${forms.length} wordings)` : ''}</h3>
          <p className="muted dup-small">Words that differ from the most used wording are <mark className="dup-changed">underlined and highlighted</mark> and listed under each text.</p>
          <div className="dup-forms">
            {forms.map((f) => {
              const members = group.members.filter((m) => m.form === f);
              const first = members[0];
              return (
                <section key={f} className="dup-form" aria-label={f === 0 ? 'The most used wording' : `Wording ${f + 1}`} data-testid="dup-form" data-form={f}>
                  <div className="dup-form-head">
                    <strong>{f === 0 ? 'Most used wording' : `Wording ${f + 1}`}</strong>
                    {f > 0 && <span className="chip variant">{pct(first.similarity)} the same</span>}
                    <span className="chip count">{plural(members.length, 'use')}</span>
                  </div>
                  <p className="dup-text" data-testid="dup-text">
                    {first.pieces.map((p, i) => (p.changed ? <mark key={i} className="dup-changed" data-testid="dup-changed"><span className="sr-only">(differs: </span>{p.text}<span className="sr-only">)</span></mark> : <span key={i}>{p.text}</span>))}
                  </p>
                  {f > 0 && (
                    <p className="dup-small dup-diffwords" data-testid="dup-diffwords">
                      {first.pieces.some((p) => p.changed) && <>Different words: {first.pieces.filter((p) => p.changed).map((p) => `“${p.text.trim()}”`).join(', ')}. </>}
                      {first.missing.length > 0 && <>Not in this text: {first.missing.map((w) => `“${w}”`).join(', ')}.</>}
                    </p>
                  )}
                  <ul className="list-rows dup-uses">
                    {members.map((m) => {
                      const doc = m.projectId ? docs.get(m.projectId) : undefined;
                      const linkedHere = !!approvedItem && m.linked?.itemId === approvedItem.itemId;
                      return (
                        <li key={m.key} className="dup-use" data-testid="dup-member" data-project={m.projectId ?? ''} data-item={m.itemId ?? ''} data-linked={m.linked ? 'true' : 'false'} data-form={m.form}>
                          <span className="dup-use-where">
                            <Link to={where(m)}>{m.source === 'library' ? `Library: ${m.itemTitle}` : m.projectTitle}</Link>
                            <span className="muted"> · {m.title} · {DUPLICATE_KIND_LABEL[m.kind].toLowerCase()}</span>
                            {m.key === suggested.key && <span className="chip accent">Suggested to keep</span>}
                            {m.placeholderNamesDiffer && <span className="chip warning" title="The same words, but its data placeholders have other names">Other placeholder names</span>}
                            {doc && doc.workflowState !== 'draft' && <span className="chip">{WORKFLOW_LABEL[doc.workflowState]}</span>}
                            {m.linked && <span className="chip accent" data-testid="dup-linked">Linked: {m.linked.title} v{m.linked.version}</span>}
                            {m.source === 'library' && <span className={`chip ${m.itemState === 'draft' ? 'warning' : 'accent'}`}>{m.itemState === 'draft' ? 'Library draft' : 'Library item'}</span>}
                          </span>
                          {approvedItem && m.source === 'document' && !linkedHere && (
                            m.linkable
                              ? (can.link ? <button type="button" className="btn sm" onClick={() => setLinking(m)} data-testid="dup-link-here">Link here</button> : null)
                              : <span className="muted dup-small">Not a message, so it cannot be linked: <Link to={where(m)}>change it in the document</Link></span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        </section>
      </div>
      {keeping && <KeepDialog group={group} onClose={() => setKeeping(false)} onDone={() => { void useLibrary.getState().load(true); onChanged(); }} canApprove={can.approve} />}
      {linking && approvedItem && <LinkHereDialog member={linking} item={approvedItem} onClose={() => setLinking(null)} />}
    </article>
  );
}

function BulkReport({ result }: { result: LibraryLinkDraftsDto }) {
  return (
    <div className="callout dup-bulk" role="status" data-testid="dup-link-drafts-result">
      <p><strong>{result.linked.length ? `Linked “${result.item.title}” in ${plural(result.linked.length, 'document')} and saved a new version of each.` : 'No document was linked.'}</strong> Nothing was approved; each document goes through its own review.</p>
      {result.linked.length > 0 && <ul className="lib-bullets">{result.linked.map((l) => <li key={l.projectId}><Link to={`/studio/${l.projectId}/content`}>{l.title}</Link>: version {l.fromVersion} → {l.toVersion}</li>)}</ul>}
      {result.refused.length > 0 && (
        <>
          <p>Not linked here (link these in the document, where the change is reviewed):</p>
          <ul className="lib-bullets" data-testid="dup-link-drafts-refused">{result.refused.map((r) => <li key={r.projectId}>{r.title ? <Link to={`/studio/${r.projectId}/content`}>{r.title}</Link> : r.projectId}: {r.reason}</li>)}</ul>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ keeping the wording */

function KeepDialog({ group, onClose, onDone, canApprove }: { group: DuplicateGroup; onClose: () => void; onDone: () => void; canApprove: boolean }) {
  const suggested = group.members.find((m) => m.key === group.suggested)!;
  const forms = [...new Set(group.members.map((m) => m.form))].map((f) => group.members.find((m) => m.form === f && (f !== suggested.form || m.key === suggested.key))!);
  const [choice, setChoice] = useState(suggested.key);
  const chosen = group.members.find((m) => m.key === choice)!;
  const [text, setText] = useState(suggested.text);
  const [title, setTitle] = useState(suggested.title.slice(0, 80));
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ itemId: string; title: string; translations: string[]; notCarried: string[]; edited: boolean; approved?: number } | null>(null);
  const isDisclosure = group.kinds.includes('disclosures');
  const source = (chosen.source === 'document' && chosen.linkable ? chosen : group.members.find((m) => m.source === 'document' && m.linkable));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.keepDuplicateWording({
        title: title.trim(), text: text.trim(), type: isDisclosure ? 'disclosure' : 'text', description: description.trim() || undefined,
        members: group.members.map((m) => (m.source === 'library' ? { itemId: m.itemId! } : { projectId: m.projectId!, textId: m.textId })),
        ...(source ? { source: { projectId: source.projectId!, ref: source.partId! } } : {}),
      });
      setDone({ itemId: r.item.id, title: r.item.title, translations: r.translations, notCarried: r.notCarried, edited: r.edited });
      onDone();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const approve = async () => {
    if (!done) return;
    setBusy(true); setError(null);
    try { const r = await api.approveLibraryDraft(done.itemId); setDone({ ...done, approved: r.version }); onDone(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog title="Keep this wording in the library" onClose={onClose} labelledBy="dup-keep-title"
      footer={done
        ? <>{canApprove && !done.approved && <button className="btn primary" onClick={approve} disabled={busy} data-testid="dup-keep-approve">Approve version 1</button>}<button className="btn" onClick={onClose} data-testid="dup-keep-close">Close</button></>
        : <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={busy || title.trim().length < 2 || !text.trim()} data-testid="dup-keep-save">Add to the library as a draft</button></>}>
      <div className="lib-form dup-keep" data-testid="dup-keep-dialog">
        {done ? (
          <div className="callout accent" role="status" data-testid="dup-keep-done">
            {done.approved
              ? <><strong>Version {done.approved} of “{done.title}” is approved.</strong> Each document can now link to it with “Link here”.</>
              : <><strong>“{done.title}” version 1 is a draft in the library.</strong> {canApprove ? 'Approve it to freeze it; then each document can link to it.' : 'An approver approves it; then each document can link to it.'}</>}
            <p className="dup-small">
              {done.translations.length ? `Translations carried, because every text had the same approved one: ${done.translations.map(languageName).join(', ')}. ` : 'No translation was carried. '}
              {done.edited ? 'The wording was edited, so the translations of the old wording were left out. ' : ''}
              {done.notCarried.length ? `Not carried (missing or different in some texts): ${done.notCarried.map(languageName).join(', ')}; translate them in the library.` : ''}
            </p>
          </div>
        ) : (
          <>
            {forms.length > 1 && (
              <fieldset className="lib-choice">
                <legend>Which wording to keep</legend>
                {forms.map((m) => (
                  <label key={m.key} className="dup-choice"><input type="radio" name="dup-keep-form" checked={choice === m.key} onChange={() => { setChoice(m.key); setText(m.text); }} data-testid={`dup-keep-form-${m.form}`} />
                    <span>{clip(m.plain, 160)} <span className="muted">({m.form === suggested.form ? 'most used' : `${pct(m.similarity)} the same`})</span></span>
                  </label>
                ))}
              </fieldset>
            )}
            <label className="field">Wording (you can edit it)<textarea className="textarea" rows={4} value={text} onChange={(e) => setText(e.target.value)} data-testid="dup-keep-text" /></label>
            <label className="field">Name in the library<input className="input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} data-testid="dup-keep-title" /></label>
            <label className="field">What it is for (optional)<input className="input" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} /></label>
            <p className="muted dup-small">It becomes a draft {isDisclosure ? 'disclosure' : 'message'} in the library, with the heading customers already see. Translations come with it only where every text in this group has the same approved translation. Nothing in any document changes until each one links to it.</p>
          </>
        )}
        {error && <div className="callout error" role="alert" data-testid="dup-keep-error">{error}</div>}
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ linking one document */

/**
 * "Link here": the difference in words and who would read something different (the same dry run a library update shows),
 * then the document opens and the link is made as one undoable, unsaved change for the person to review and save.
 */
function LinkHereDialog({ member, item, onClose }: { member: DuplicateMember; item: { itemId: string; title: string }; onClose: () => void }) {
  const navigate = useNavigate();
  const open = useStudio((s) => s.project);
  const savedDigest = useStudio((s) => s.savedDigest);
  const projectId = member.projectId!, partId = member.partId!;
  const otherUnsaved = open && open.projectId !== projectId && projectContentDigest(open) !== savedDigest ? open : null;
  const sameOpen = open && open.projectId === projectId ? open : null;
  const [preview, setPreview] = useState<LibraryLinkPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (otherUnsaved) return;
    let live = true;
    api.libraryLinkPreview(item.itemId, { projectId, partId, ...(sameOpen ? { project: sameOpen } : {}) }).then((r) => { if (live) setPreview(r); }).catch((e) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [item.itemId, projectId, partId]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = preview ? preview.comparison.customers.filter((c) => c.outcome !== 'same') : [];
  const locales = preview ? [...new Set([...Object.keys(preview.before.approvedLocales), ...Object.keys(preview.after.approvedLocales)])].sort((a, b) => (a === 'en-US' ? -1 : b === 'en-US' ? 1 : a.localeCompare(b))) : [];
  const apply = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      await useStudio.getState().openProject(projectId);
      const st = useStudio.getState();
      if (st.project?.projectId !== projectId) throw new Error(st.projectError ?? 'The document could not be opened.');
      const r = st.dispatch({ type: 'LINK_LIBRARY_ITEM', item: { id: item.itemId, kind: 'wording', title: preview.title }, version: preview.version.version, content: preview.content, placement: { partId } });
      if (!r.ok) { setError(r.message); return; }
      st.toast({ kind: 'success', title: 'Linked to the library (not saved yet)', message: `“${member.title}” now uses “${preview.title}” version ${preview.version.version}. One undo step; save the document, then it goes through its own review.` });
      onClose();
      navigate(`/studio/${projectId}/content`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog title={`Link “${member.title}” in “${member.projectTitle}” to the library`} onClose={onClose} labelledBy="dup-link-title"
      footer={<><button className="btn" onClick={onClose}>Not now</button><button className="btn primary" onClick={apply} disabled={!preview || busy || !!otherUnsaved} data-testid="dup-link-apply">Open the document and link</button></>}>
      <div className="lib-update dup-link" data-testid="dup-link-dialog">
        {otherUnsaved ? (
          <div className="callout warning" role="alert" data-testid="dup-link-unsaved">“{otherUnsaved.title}” is open with unsaved changes. <Link to={`/studio/${otherUnsaved.projectId}/overview`}>Save or discard them</Link> before opening another document.</div>
        ) : error ? <div className="callout error" role="alert" data-testid="dup-link-error">{error}</div>
          : !preview ? <Loading label="Working out what would change for the synthetic customers…" /> : (
            <>
              <p className="lib-impact-count" data-testid="dup-link-impact" data-changed={changed.length} data-evaluated={preview.comparison.evaluated} data-identical={preview.identical ? 'true' : 'false'}>
                {changed.length
                  ? <><strong>{changed.length} of {preview.comparison.evaluated} synthetic customers</strong> would read something different.</>
                  : <><strong>No synthetic customer would read anything different</strong> ({preview.comparison.evaluated} worked out).</>}
              </p>
              {preview.difference && <p className="muted">{preview.difference}</p>}
              <section aria-labelledby="dup-words-h">
                <h3 className="section-title" id="dup-words-h">The wording, now and from the library</h3>
                {preview.before.title !== preview.after.title && <p>Heading: <del>{preview.before.title}</del> → <ins>{preview.after.title}</ins></p>}
                <dl className="dup-wordlist">
                  {locales.map((l) => {
                    const before = preview.before.approvedLocales[l] ?? '', after = preview.after.approvedLocales[l] ?? '';
                    if (before === after) return <div key={l}><dt>{languageName(l)}</dt><dd>{after} <span className="muted">(the same)</span></dd></div>;
                    const d = wordDiff(before, after);
                    return (
                      <div key={l} data-testid="dup-link-diff">
                        <dt>{languageName(l)}</dt>
                        <dd><span className="muted">Now: </span>{before ? d.before.map((p, i) => (p.changed ? <del key={i} className="dup-del">{p.text}</del> : <span key={i}>{p.text}</span>)) : <em>none</em>}</dd>
                        <dd><span className="muted">From the library: </span>{after ? d.after.map((p, i) => (p.changed ? <ins key={i} className="dup-ins">{p.text}</ins> : <span key={i}>{p.text}</span>)) : <em>none (this translation would go)</em>}</dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
              {changed.length > 0 && (
                <section aria-labelledby="dup-who-h">
                  <h3 className="section-title" id="dup-who-h">Who would read something different</h3>
                  <ul className="list-rows lib-impact-list" data-testid="dup-link-who">
                    {changed.slice(0, 8).map((c) => <li key={c.recordId}><strong>{c.name}</strong> <span className="chip">{COMPARISON_OUTCOME_LABEL[c.outcome]}</span></li>)}
                    {changed.length > 8 && <li className="muted">…and {changed.length - 8} more synthetic customers</li>}
                  </ul>
                </section>
              )}
              <p className="muted lib-small">The document opens with the link made as one undoable change. Nothing is saved until you save it, and the document then goes through its own review and approval. The wording becomes read-only there.</p>
            </>
          )}
      </div>
    </Dialog>
  );
}

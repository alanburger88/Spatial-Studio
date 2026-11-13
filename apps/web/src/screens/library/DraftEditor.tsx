import { useEffect, useMemo, useState } from 'react';
import {
  LIBRARY_KINDS, LIBRARY_KIND_HINT, LIBRARY_KIND_LABEL, SOURCE_LANGUAGE, WORDING_RULE_KIND_LABEL, checkLibraryContent, languageName, partRefsOf,
  type BrandKit, type LibraryContent, type LibraryGlossaryContent, type LibraryKind, type LibraryWordingContent, type LibraryWordingRulesContent, type Project, type WordingRule,
} from '@iss/model';
import { api, type LibraryItemDto, type ProjectSummary } from '../../api/client';
import { Dialog } from '../../ui/common';
import { errorText, useLibrary } from './libraryData';

/** Kinds whose content can be typed here; the others are always taken from a document. */
const EDITABLE: LibraryKind[] = ['wording', 'brand', 'glossary', 'wording-rules'];
const FONTS = ['Arial', 'Georgia', 'Verdana', 'Trebuchet MS'] as const;

const emptyContent = (kind: LibraryKind): LibraryContent | null => {
  switch (kind) {
    case 'wording': return { part: { id: 'wording', title: '', type: 'text', approvedLocales: { [SOURCE_LANGUAGE]: '' } } };
    case 'brand': return { primary: '#1F4E79', accent: '#4EAF60', text: '#0F172A', fontFamily: 'Arial' };
    case 'glossary': return { entries: { 'es-US': [] } };
    case 'wording-rules': return { rules: [] };
    default: return null;
  }
};

/**
 * Making a draft in the library: a new item, a new version of an item, or editing the draft there is. Content is typed
 * here (wording, brand, glossary, wording rules) or taken from a saved document (any kind). Nothing is approved here.
 */
export function DraftEditor({ item, start, onClose, onSaved }: { item: LibraryItemDto | null; start: LibraryContent | null; onClose: () => void; onSaved: (itemId: string) => void }) {
  const [kind, setKind] = useState<LibraryKind>(item?.kind ?? 'wording');
  const editable = EDITABLE.includes(kind);
  const [mode, setMode] = useState<'type' | 'document'>(editable ? 'type' : 'document');
  const [content, setContent] = useState<LibraryContent | null>(() => start ?? emptyContent(kind));
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docs, setDocs] = useState<ProjectSummary[]>([]);
  const [docId, setDocId] = useState('');
  const [doc, setDoc] = useState<Project | null>(null);
  const [ref, setRef] = useState('');
  useEffect(() => { void api.projects().then((r) => { setDocs(r.projects); setDocId((d) => d || item?.source?.projectId || r.projects[0]?.projectId || ''); }).catch(() => undefined); }, [item?.source?.projectId]);
  useEffect(() => { if (!docId) return; setDoc(null); void api.project(docId).then((r) => setDoc(r.project)).catch(() => undefined); }, [docId]);
  const changeKind = (k: LibraryKind) => { setKind(k); setContent(emptyContent(k)); setMode(EDITABLE.includes(k) ? 'type' : 'document'); setRef(''); setError(null); };
  const refs = useMemo(() => refsOf(doc, kind), [doc, kind]);
  useEffect(() => { if (!refs.some((r) => r.id === ref)) setRef((item?.source?.projectId === docId && refs.some((r) => r.id === item?.source?.ref) ? item!.source!.ref : refs[0]?.id) ?? ''); }, [refs]); // eslint-disable-line react-hooks/exhaustive-deps
  const typed = mode === 'type' && content ? checkLibraryContent(kind, content) : null;
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = mode === 'type' ? { content } : { projectId: docId, ref };
      let id = item?.id;
      if (!item) id = (await api.createLibraryItem({ kind, title: title.trim(), description: description.trim() || undefined, note: note.trim() || undefined, ...(mode === 'type' ? { content } : { projectId: docId, ref, source: { projectId: docId, ref } }) })).item.id;
      else await api.saveLibraryDraft(item.id, { ...body, note: note.trim() || undefined, ...(title.trim() && title.trim() !== item.title ? { title: title.trim() } : {}), ...(description.trim() !== item.description ? { description: description.trim() } : {}) });
      await useLibrary.getState().load(true);
      onSaved(id!);
      onClose();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const verb = !item ? 'Add to the library' : item.draft !== null ? `Save draft version ${item.draft}` : `Save as draft version ${(item.versions[0]?.version ?? 0) + 1}`;
  const ready = (item || title.trim().length >= 2) && (mode === 'document' ? !!docId && (kind === 'brand' || kind === 'glossary' || kind === 'wording-rules' || !!ref) : typed?.ok);
  return (
    <Dialog title={!item ? 'New library item' : item.draft !== null ? `Edit the draft of “${item.title}”` : `New version of “${item.title}”`} onClose={onClose} labelledBy="lib-draft-title"
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save} disabled={busy || !ready} data-testid="lib-draft-save">{verb}</button></>}>
      <div className="lib-form" data-testid="lib-draft-dialog">
        {!item && (
          <label className="field">Kind of item
            <select className="select" value={kind} onChange={(e) => changeKind(e.target.value as LibraryKind)} data-testid="lib-draft-kind">
              {LIBRARY_KINDS.map((k) => <option key={k} value={k}>{LIBRARY_KIND_LABEL[k]} — {LIBRARY_KIND_HINT[k]}</option>)}
            </select>
          </label>
        )}
        <label className="field">Name<input className="input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} data-testid="lib-draft-name" /></label>
        <label className="field">What it is for (optional)<input className="input" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} /></label>
        {editable && (
          <div className="segmented" role="group" aria-label="Where the content comes from">
            <button type="button" aria-pressed={mode === 'type'} onClick={() => setMode('type')} data-testid="lib-draft-mode-type">Type it here</button>
            <button type="button" aria-pressed={mode === 'document'} onClick={() => setMode('document')} data-testid="lib-draft-mode-document">Take it from a document</button>
          </div>
        )}
        {mode === 'document' ? (
          <div className="lib-from-doc">
            <label className="field">Document<select className="select" value={docId} onChange={(e) => setDocId(e.target.value)} data-testid="lib-draft-document">{docs.map((d) => <option key={d.projectId} value={d.projectId}>{d.title}</option>)}</select></label>
            {(kind === 'block' || kind === 'wording' || kind === 'lookup-table') && (
              <label className="field">{kind === 'block' ? 'Component' : kind === 'wording' ? 'Message or notice' : 'Lookup table'}
                <select className="select" value={ref} onChange={(e) => setRef(e.target.value)} data-testid="lib-draft-ref">{refs.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
              </label>
            )}
            {doc && (kind === 'block' || kind === 'wording' || kind === 'lookup-table') && !refs.length && <p className="muted">That document has nothing of this kind.</p>}
            <p className="muted lib-small">The document’s last saved version is used.</p>
          </div>
        ) : content && <ContentEditor kind={kind} content={content} onChange={setContent} />}
        {typed && !typed.ok && <ul className="lib-problems" data-testid="lib-draft-problems">{typed.problems.slice(0, 4).map((p) => <li key={p}>{p}</li>)}</ul>}
        <label className="field">Note for the approver (optional)<input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} data-testid="lib-draft-note" /></label>
        {error && <div className="callout error" role="alert" data-testid="lib-draft-error">{error}</div>}
      </div>
    </Dialog>
  );
}

/** What a document offers for a kind: components (not the page itself), messages and notices, lookup tables. */
function refsOf(doc: Project | null, kind: LibraryKind): Array<{ id: string; label: string }> {
  if (!doc) return [];
  if (kind === 'block') return doc.nodes.filter((n) => n.id !== doc.rootNodeId).map((n) => ({ id: n.id, label: n.name ?? n.label ?? n.id }));
  if (kind === 'wording') {
    const used = new Set(doc.nodes.flatMap(partRefsOf));
    return doc.contentParts.filter((c) => used.has(c.id)).map((c) => ({ id: c.id, label: c.title }));
  }
  if (kind === 'lookup-table') return (doc.lookupTables ?? []).map((t) => ({ id: t.id, label: t.title }));
  return [];
}

function ContentEditor({ kind, content, onChange }: { kind: LibraryKind; content: LibraryContent; onChange: (c: LibraryContent) => void }) {
  if (kind === 'wording') {
    const w = content as LibraryWordingContent;
    const set = (p: Partial<LibraryWordingContent['part']>) => onChange({ ...w, part: { ...w.part, ...p } });
    return (
      <div className="lib-editor" data-testid="lib-edit-wording">
        <label className="field">Heading<input className="input" value={w.part.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} data-testid="lib-edit-wording-title" /></label>
        <label className="field">Kind<select className="select" value={w.part.type} onChange={(e) => set({ type: e.target.value as 'text' | 'disclosure' })}><option value="text">Message</option><option value="disclosure">Disclosure</option></select></label>
        {Object.entries(w.part.approvedLocales).map(([loc, text]) => (
          <label key={loc} className="field">{languageName(loc)}{loc === SOURCE_LANGUAGE ? '' : ' (approved translation)'}
            <textarea className="textarea" lang={loc} value={text} rows={3} maxLength={4000} onChange={(e) => set({ approvedLocales: { ...w.part.approvedLocales, [loc]: e.target.value } })} data-testid={`lib-edit-wording-${loc}`} />
          </label>
        ))}
        {!w.part.approvedLocales['es-US'] && w.part.approvedLocales['es-US'] !== '' && <button type="button" className="btn sm" onClick={() => set({ approvedLocales: { ...w.part.approvedLocales, 'es-US': '' } })}>Add a Spanish (US) translation</button>}
      </div>
    );
  }
  if (kind === 'brand') {
    const b = content as BrandKit;
    const set = (p: Partial<BrandKit>) => onChange({ ...b, ...p });
    const colour = (label: string, k: 'primary' | 'accent' | 'text') => (
      <label className="field">{label}<span className="row" style={{ gap: 6 }}><input type="color" value={b[k] ?? '#000000'} onChange={(e) => set({ [k]: e.target.value.toUpperCase() })} aria-label={`${label} picker`} /><input className="input" value={b[k] ?? ''} maxLength={7} onChange={(e) => set({ [k]: e.target.value })} data-testid={`lib-edit-brand-${k}`} /></span></label>
    );
    return (
      <div className="lib-editor" data-testid="lib-edit-brand">
        {colour('Primary colour', 'primary')}{colour('Accent colour', 'accent')}{colour('Text colour', 'text')}
        <label className="field">Document font<select className="select" value={b.fontFamily ?? 'Arial'} onChange={(e) => set({ fontFamily: e.target.value as BrandKit['fontFamily'] })}>{FONTS.map((f) => <option key={f}>{f}</option>)}</select></label>
        {b.logoDataUri && <p className="muted">The logo is kept as it is. To change it, take the brand from a document whose brand has the new logo.</p>}
      </div>
    );
  }
  if (kind === 'glossary') {
    const g = content as LibraryGlossaryContent;
    const loc = Object.keys(g.entries)[0] ?? 'es-US';
    const lines = (g.entries[loc] ?? []).map((e) => `${e.source} = ${e.target}`).join('\n');
    return (
      <div className="lib-editor" data-testid="lib-edit-glossary">
        <label className="field">Terms in {languageName(loc)}: one per line, “English term = translation”
          <textarea className="textarea" rows={6} defaultValue={lines} onBlur={(e) => onChange({ entries: { ...g.entries, [loc]: e.target.value.split('\n').map((l) => l.split('=')).filter((p) => p.length >= 2).map(([s, ...t]) => ({ source: s.trim(), target: t.join('=').trim() })) } })} data-testid="lib-edit-glossary-terms" />
        </label>
      </div>
    );
  }
  const r = content as LibraryWordingRulesContent;
  const setRule = (i: number, p: Partial<WordingRule>) => onChange({ rules: r.rules.map((x, j) => (j === i ? clean({ ...x, ...p }) : x)) });
  return (
    <div className="lib-editor" data-testid="lib-edit-rules">
      <ul className="list-rows">
        {r.rules.map((x, i) => (
          <li key={i} className="row wrap" style={{ gap: 6, alignItems: 'flex-end' }}>
            <label className="field">Rule<select className="select" value={x.kind} onChange={(e) => setRule(i, { kind: e.target.value as WordingRule['kind'] })}>{Object.entries(WORDING_RULE_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="field">Must or should<select className="select" value={x.severity} onChange={(e) => setRule(i, { severity: e.target.value as 'must' | 'should' })}><option value="must">Must (a blocker)</option><option value="should">Should (a warning)</option></select></label>
            {(x.kind === 'banned' || x.kind === 'required' || x.kind === 'preferred') && <label className="field">Phrase<input className="input" value={x.phrase ?? ''} onChange={(e) => setRule(i, { phrase: e.target.value })} /></label>}
            {(x.kind === 'banned' || x.kind === 'preferred') && <label className="field">{x.kind === 'preferred' ? 'Write instead' : 'Replacement (optional)'}<input className="input" value={x.replacement ?? ''} onChange={(e) => setRule(i, { replacement: e.target.value || undefined })} /></label>}
            {(x.kind === 'reading-level' || x.kind === 'sentence-length') && <label className="field">{x.kind === 'reading-level' ? 'Grade at most' : 'Words at most'}<input className="input" type="number" value={x.limit ?? ''} onChange={(e) => setRule(i, { limit: e.target.value === '' ? undefined : Number(e.target.value) })} style={{ width: 90 }} /></label>}
            <button type="button" className="btn sm ghost" onClick={() => onChange({ rules: r.rules.filter((_, j) => j !== i) })}>Remove</button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn sm" onClick={() => onChange({ rules: [...r.rules, { id: `rule-${r.rules.length + 1}`, kind: 'banned', severity: 'should', phrase: '' }] })} data-testid="lib-edit-rules-add">Add a rule</button>
    </div>
  );
}

/** Keeps only the fields a rule of its kind takes (the validator refuses the others). */
function clean(x: WordingRule): WordingRule {
  const phrase = x.kind === 'banned' || x.kind === 'required' || x.kind === 'preferred';
  const limit = x.kind === 'reading-level' || x.kind === 'sentence-length';
  return { id: x.id, kind: x.kind, severity: x.severity, ...(phrase ? { phrase: x.phrase ?? '' } : {}), ...((x.kind === 'banned' || x.kind === 'preferred') && x.replacement !== undefined ? { replacement: x.replacement } : {}), ...(limit ? { limit: x.limit ?? (x.kind === 'reading-level' ? 8 : 25) } : {}), ...(x.appliesTo ? { appliesTo: x.appliesTo } : {}) };
}

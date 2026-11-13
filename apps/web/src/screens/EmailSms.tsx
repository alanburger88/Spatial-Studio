import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CHANNEL_TEXT_LIMITS, CHANNEL_TOKENS, EMAIL_SECTION_LABELS, channelConfig, defaultChannels, languageName, projectFieldIndex, projectLanguages, translationStatus,
  type ChannelConfig, type EmailSectionId, type Project,
} from '@iss/model';
import { api, ApiFailure, type ScenarioRequest } from '../api/client';
import { editBlockedReason, useRecord, useResolution, useScenarioRequest, useStudio } from '../state/store';
import { recordSummary } from '../shell/RecordPicker';
import { Dialog, ErrorState, Loading, Named, ScreenHeader, Tech } from '../ui/common';
import { Icon } from '../ui/icons';
import { fitSms, smsEncoding } from '@iss/renderers';
import { NeedsAi, useBusy } from '../assist/common';
import { WordingFindings } from './wording/WordingFindings';
import { GuardedSuggestion, WritingHelp, lengthChange, recordAssist, useReadOnlyReason } from '../assist/WritingHelp';
import './EmailSms.css';

type Channel = 'email' | 'sms';
type FieldKey = 'subject' | 'preheader' | 'title' | 'intro' | 'closing' | 'keyFactsHeading' | 'sms';
type EmailDto = Awaited<ReturnType<typeof api.composeEmail>>;
type SmsDto = Awaited<ReturnType<typeof api.composeSms>>;
type ParityDto = EmailDto['parity'];
interface Issue { code?: string; severity?: string; message?: string; nodeId?: string }

const getText = (c: ChannelConfig, k: FieldKey) => (k === 'sms' ? c.sms.text : c.email[k]);
function withText(c: ChannelConfig, k: FieldKey, v: string): ChannelConfig {
  const next: ChannelConfig = { email: { ...c.email, sections: c.email.sections.map((s) => ({ ...s })) }, sms: { ...c.sms } };
  if (k === 'sms') next.sms.text = v; else next.email[k] = v;
  return next;
}
const LIMIT: Record<FieldKey, number> = { subject: CHANNEL_TEXT_LIMITS.subject, preheader: CHANNEL_TEXT_LIMITS.preheader, title: CHANNEL_TEXT_LIMITS.title, intro: CHANNEL_TEXT_LIMITS.intro, closing: CHANNEL_TEXT_LIMITS.closing, keyFactsHeading: CHANNEL_TEXT_LIMITS.keyFactsHeading, sms: CHANNEL_TEXT_LIMITS.sms };
const TRANSLATION_ID: Record<FieldKey, string> = { subject: '@email/subject', preheader: '@email/preheader', title: '@email/title', intro: '@email/intro', closing: '@email/closing', keyFactsHeading: '@email/keyFactsHeading', sms: '@sms/text' };
const TOKEN_DESCRIPTION: Record<(typeof CHANNEL_TOKENS)[number], string> = {
  'issuer.name': 'Issuer name', 'issuer.product': 'Product name', keyFacts: 'Key figures list', link: 'Link to the online document',
};
const SECTION_DESCRIPTION: Record<EmailSectionId, string> = {
  keyFacts: 'The most important figures of this document as a short list.',
  messages: 'The messages chosen for this customer, such as payment guidance.',
  tables: 'Tables that are short enough to read in an email.',
  summaries: 'A one-line summary in place of a long table or chart, with a pointer to the full document.',
  actions: 'Buttons that link to online actions, such as paying or getting help.',
};
const ALWAYS_INCLUDED = ['Logo and issuer name', 'Heading', 'Greeting', 'Required notices and disclosures', 'Footer'];
const TOKEN_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/* ------------------------------------------------------------------ live composition */

interface Composed<T> {
  data?: T;
  /** Why the shown preview is a draft: blocking issues in the document, or unapproved translations. */
  draft: null | 'blocking' | 'translations';
  issues: Issue[];
  busy: boolean;
  error?: { code: string; message: string };
  retry: () => void;
}

/** Composes a channel for the live (possibly unsaved) model ~600 ms after the last change; keeps the previous result on screen meanwhile. */
function useCompose<T>(call: (req: ScenarioRequest) => Promise<T>, req: ScenarioRequest | null, enabled: boolean, wantDrafts: boolean): Composed<T> {
  const [state, setState] = useState<{ data?: T; draft: Composed<T>['draft']; issues: Issue[]; busy: boolean; error?: { code: string; message: string } }>({ draft: null, issues: [], busy: true });
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  const first = useRef(true);
  const key = useMemo(() => (req ? JSON.stringify(req) : ''), [req]) + (wantDrafts ? '#d' : '') + '#' + tick;
  useEffect(() => {
    if (!enabled || !req) return undefined;
    const my = ++latest.current;
    setState((s) => ({ ...s, busy: true }));
    const delay = first.current ? 0 : 600;
    first.current = false;
    const t = setTimeout(async () => {
      try {
        let data: T; let draft: Composed<T>['draft'] = null; let issues: Issue[] = [];
        if (wantDrafts) { data = await call({ ...req, allowDraft: true, includeDrafts: true }); draft = 'translations'; }
        else {
          try { data = await call(req); } catch (e) {
            if (!(e instanceof ApiFailure) || e.code !== 'BLOCKING_DIAGNOSTICS') throw e;
            issues = e.body?.error?.issues ?? [];
            data = await call({ ...req, allowDraft: true, includeDrafts: true });
            draft = 'blocking';
          }
        }
        if (latest.current === my) setState({ data, draft, issues, busy: false });
      } catch (e) {
        if (latest.current === my) setState((s) => ({ ...s, busy: false, error: { code: e instanceof ApiFailure ? e.code : 'UNKNOWN', message: e instanceof Error ? e.message : String(e) } }));
      }
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return { ...state, retry: () => setTick((n) => n + 1) };
}

/* ------------------------------------------------------------------ insert-a-field menu */

function InsertFieldMenu({ project, disabled, onPick }: { project: Project; disabled: boolean; onPick: (token: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const wrap = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const index = useMemo(() => projectFieldIndex(project), [project]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const needle = q.trim().toLowerCase();
  const fields = [...index.values()].filter((f) => !needle || `${f.label} ${f.path}`.toLowerCase().includes(needle));
  const tokens = CHANNEL_TOKENS.filter((t) => !needle || `${TOKEN_DESCRIPTION[t]} ${t}`.toLowerCase().includes(needle));
  const pick = (path: string) => { setOpen(false); setQ(''); onPick(path); };
  return (
    <span className="chx-insert" ref={wrap}>
      <button type="button" className="btn sm" ref={btn} disabled={disabled} aria-haspopup="true" aria-expanded={open} data-testid="ch-insert-field" onClick={() => setOpen((o) => !o)}>
        <Icon.plus width={12} height={12} /> Insert field
      </button>
      {open && (
        <div className="chx-menu" role="group" aria-label="Insert a data field" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.current?.focus(); } }}>
          <input className="input" autoFocus type="search" placeholder="Search fields…" aria-label="Search fields" value={q} onChange={(e) => setQ(e.target.value)} data-testid="ch-field-search" />
          <div className="chx-menu-list">
            {tokens.length > 0 && <div className="chx-menu-group">Channel values</div>}
            {tokens.map((t) => (
              <button type="button" key={t} className="chx-menu-item" onClick={() => pick(t)} data-testid={`ch-field-option-${t}`}>
                <span>{TOKEN_DESCRIPTION[t]}</span><Tech><span className="chip code">{t}</span></Tech>
              </button>
            ))}
            {fields.length > 0 && <div className="chx-menu-group">Document data</div>}
            {fields.map((f) => (
              <button type="button" key={f.path} className="chx-menu-item" onClick={() => pick(f.path)} data-testid={`ch-field-option-${f.path}`}>
                <span>{f.label}</span><Tech><span className="chip code">{f.path}</span></Tech>
              </button>
            ))}
            {!fields.length && !tokens.length && <div className="chx-menu-empty muted">No field matches “{q}”.</div>}
          </div>
        </div>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ one editable text */

function TranslationStatus({ project, field, text, statuses }: { project: Project; field: FieldKey; text: string; statuses: Array<{ locale: string; status?: 'approved' | 'draft' | 'missing'; sourceChanged?: boolean }> }) {
  const navigate = useNavigate();
  if (!statuses.length || !text.trim()) return null;
  const label = { approved: 'Approved', draft: 'Draft', missing: 'Missing' } as const;
  const glyph = { approved: '✓', draft: '✎', missing: '○' } as const;
  return (
    <div className="chx-trans" data-testid={`ch-translations-${field}`}>
      <span className="muted">Translations:</span>
      {statuses.map((s) => {
        const st = s.status ?? 'missing';
        return (
          <span key={s.locale} className={'chip ' + (st === 'approved' && !s.sourceChanged ? 'accent' : st === 'missing' ? 'error' : 'warning')} data-status={st} data-locale={s.locale}>
            <span aria-hidden="true">{glyph[st]}</span> {languageName(s.locale)}: {label[st]}{s.sourceChanged ? ' · English changed' : ''}
          </span>
        );
      })}
      <button type="button" className="btn sm ghost" onClick={() => navigate(`/studio/${project.projectId}/content`)}>Translate in Content &amp; Translations</button>
    </div>
  );
}

interface TextFieldProps {
  project: Project; field: FieldKey; label: string; hint?: string; testId: string; multiline?: boolean; optional?: boolean; rows?: number;
  value: string; error?: string; disabled: boolean; extra?: React.ReactNode;
  statuses: Array<{ locale: string; status?: 'approved' | 'draft' | 'missing'; sourceChanged?: boolean }>;
  onChange: (text: string) => void; onCommit: (text: string) => void;
}

function TextField(p: TextFieldProps) {
  const el = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const caret = useRef<number | null>(null);
  const index = useMemo(() => projectFieldIndex(p.project), [p.project]);
  const limit = LIMIT[p.field];
  const id = `ch-f-${p.field}`;
  const unknown = useMemo(() => {
    const out: string[] = [];
    for (const m of p.value.matchAll(TOKEN_RE)) if (!index.has(m[1]) && !(CHANNEL_TOKENS as readonly string[]).includes(m[1]) && !out.includes(m[1])) out.push(m[1]);
    return out;
  }, [p.value, index]);
  const used = useMemo(() => {
    const out: string[] = [];
    for (const m of p.value.matchAll(TOKEN_RE)) if ((index.has(m[1]) || (CHANNEL_TOKENS as readonly string[]).includes(m[1])) && !out.includes(m[1])) out.push(m[1]);
    return out;
  }, [p.value, index]);
  useLayoutEffect(() => {
    if (caret.current !== null && el.current) { el.current.focus(); el.current.setSelectionRange(caret.current, caret.current); caret.current = null; }
  });
  const insert = (path: string) => {
    const node = el.current; const tok = `{{${path}}}`;
    const start = node?.selectionStart ?? p.value.length; const end = node?.selectionEnd ?? start;
    caret.current = start + tok.length;
    p.onChange(p.value.slice(0, start) + tok + p.value.slice(end));
  };
  const common = {
    id, ref: el, value: p.value, disabled: p.disabled, 'data-testid': p.testId, spellCheck: true,
    'aria-describedby': `${id}-hint ${id}-count`, 'aria-invalid': p.error || unknown.length ? true : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => p.onChange(e.target.value),
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => p.onCommit(e.target.value),
  };
  const near = p.value.length > limit * 0.9;
  return (
    <div className="field chx-field" data-testid={`ch-field-${p.field}`}>
      <div className="chx-field-head">
        <label htmlFor={id}>{p.label}{p.optional && <span className="muted"> (optional)</span>}</label>
        <InsertFieldMenu project={p.project} disabled={p.disabled} onPick={insert} />
      </div>
      {p.multiline ? <textarea className="textarea chx-area" rows={p.rows ?? 3} {...common} /> : <input className="input" type="text" {...common} />}
      <div className="chx-field-foot">
        <span className="hint" id={`${id}-hint`}>{p.hint}</span>
        <span className={'chx-count' + (near ? ' near' : '')} id={`${id}-count`} data-testid={`${p.testId}-count`}>{p.value.length} / {limit}</span>
      </div>
      {used.length > 0 && (
        <div className="chx-used" aria-label="Data in this text">
          {used.map((u) => (CHANNEL_TOKENS as readonly string[]).includes(u)
            ? <span key={u} className="chip info" title={u}>{TOKEN_DESCRIPTION[u as (typeof CHANNEL_TOKENS)[number]]}</span>
            : <span key={u} className="chip info"><Named name={index.get(u)!.label} code={u} /></span>)}
        </div>
      )}
      {unknown.length > 0 && (
        <div className="callout warning chx-note" role="status" data-testid="ch-token-warning">
          Not a data field of this document: {unknown.map((u) => <code key={u}>{`{{${u}}}`}</code>)}. It cannot be saved; remove it or use Insert field.
        </div>
      )}
      {p.error && <div className="callout error chx-note" role="alert" data-testid={`${p.testId}-error`}>{p.error}</div>}
      {p.extra}
      {/* Wording rules: findings as the person types; a replacement goes into this field like typing does. */}
      <WordingFindings text={p.value} scope={p.field === 'sms' ? 'sms' : 'email'} onApply={p.onChange} blockedReason={p.disabled ? 'The wording cannot be changed here right now.' : null} testId={`${p.testId}-wording`} />
      <TranslationStatus project={p.project} field={p.field} text={p.value} statuses={p.statuses} />
    </div>
  );
}

/* ------------------------------------------------------------------ preview pieces */

function ParityChips({ parity, testId }: { parity: ParityDto; testId: string }) {
  const shown = parity.checks.filter((c) => c.status !== 'not-applicable');
  return (
    <div className="chx-parity" data-testid={testId} role="group" aria-label="Comparison with the PDF">
      <span className={'chip ' + (parity.ok ? 'accent' : 'error')} data-testid={`${testId}-overall`} data-ok={parity.ok}>{parity.ok ? '✓ Same facts as the PDF' : '✗ Differs from the PDF'}</span>
      {shown.map((c) => (
        <span key={c.id} className={'chip ' + (c.status === 'match' ? 'info' : 'error')} title={c.label + (c.note ? ` — ${c.note}` : '')} data-status={c.status}>
          {c.status === 'match' ? '✓' : '✗'} {c.label.split(' (')[0]}
        </span>
      ))}
    </div>
  );
}

function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return <ul className="chx-warnings" aria-label="Warnings">{items.map((w, i) => <li key={i} className="callout warning" data-testid="ch-warning"><span className="sev">warning</span> {w}</li>)}</ul>;
}

function DraftMarker({ draft, issues }: { draft: Composed<unknown>['draft']; issues: Issue[] }) {
  if (!draft) return null;
  return (
    <div className="callout warning chx-draft" role="status" data-testid="ch-preview-draft" data-reason={draft}>
      <strong>Draft preview, not for sending.</strong>{' '}
      {draft === 'blocking'
        ? <>The document has blocking issues, so this is shown as a draft. Fix them in Validate &amp; Compare before sending.</>
        : <>It shows translations that are not approved yet. Approve them in Content &amp; Translations.</>}
      {issues.length > 0 && <ul>{issues.slice(0, 4).map((i, k) => <li key={k}>{i.message ?? i.code}</li>)}</ul>}
    </div>
  );
}

/* ------------------------------------------------------------------ the screen */

export function EmailSms() {
  const project = useStudio((s) => s.project);
  if (!project) return <section className="screen" data-testid="channels-view"><Loading label="Loading email and SMS…" /></section>;
  return <ChannelsEditor project={project} />;
}

function ChannelsEditor({ project }: { project: Project }) {
  const cfg = useMemo(() => channelConfig(project), [project]);
  const session = useStudio((s) => s.session);
  const blockedReason = editBlockedReason(session);
  const baseReq = useScenarioRequest();
  const record = useRecord();
  const personas = useStudio((s) => s.personas);
  const resolution = useResolution();

  const [channel, setChannel] = useState<Channel>('email');
  const [edits, setEdits] = useState<Partial<Record<FieldKey, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [confirmReset, setConfirmReset] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [width, setWidth] = useState<'desktop' | 'mobile'>('desktop');
  const [plain, setPlain] = useState(false);
  const timers = useRef<Partial<Record<FieldKey, ReturnType<typeof setTimeout>>>>({});
  const listRef = useRef<HTMLUListElement>(null);
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => () => { Object.values(timers.current).forEach((t) => t && clearTimeout(t)); }, []);

  const valueOf = (k: FieldKey) => edits[k] ?? getText(cfg, k);
  const setErr = (k: FieldKey, msg: string | null) => setErrors((e) => { const n = { ...e }; if (msg) n[k] = msg; else delete n[k]; return n; });

  const commit = (k: FieldKey, text: string) => {
    const t = timers.current[k]; if (t) { clearTimeout(t); delete timers.current[k]; }
    const live = useStudio.getState().project; if (!live) return;
    const cur = channelConfig(live);
    const settle = () => setEdits((e) => { if (e[k] !== text) return e; const n = { ...e }; delete n[k]; return n; });
    if (getText(cur, k) === text) { settle(); setErr(k, null); return; }
    const res = useStudio.getState().dispatch({ type: 'SET_CHANNELS', channels: withText(cur, k, text) });
    if (!res.ok) { setErr(k, res.message); return; }
    setErr(k, null); settle();
  };
  const change = (k: FieldKey, text: string) => {
    setEdits((e) => ({ ...e, [k]: text })); setErr(k, null);
    const t = timers.current[k]; if (t) clearTimeout(t);
    timers.current[k] = setTimeout(() => commit(k, text), 1000);
  };

  const saveSections = (sections: ChannelConfig['email']['sections']) => {
    const live = useStudio.getState().project; if (!live) return false;
    const cur = channelConfig(live);
    const res = useStudio.getState().dispatch({ type: 'SET_CHANNELS', channels: { email: { ...cur.email, sections }, sms: cur.sms } });
    return res.ok;
  };
  const toggle = (id: EmailSectionId) => {
    const s = cfg.email.sections.map((x) => (x.id === id ? { ...x, show: !x.show } : x));
    if (saveSections(s)) setAnnounce(`${EMAIL_SECTION_LABELS[id]} ${s.find((x) => x.id === id)!.show ? 'shown' : 'hidden'}.`);
  };
  const move = (id: EmailSectionId, dir: -1 | 1) => {
    const from = cfg.email.sections.findIndex((x) => x.id === id); const to = from + dir;
    if (from < 0 || to < 0 || to >= cfg.email.sections.length) return;
    const s = cfg.email.sections.map((x) => ({ ...x })); [s[from], s[to]] = [s[to], s[from]];
    pendingFocus.current = `ch-section-${dir < 0 ? 'up' : 'down'}-${id}`;
    if (saveSections(s)) setAnnounce(`${EMAIL_SECTION_LABELS[id]} moved to position ${to + 1} of ${s.length}.`);
  };
  useLayoutEffect(() => {
    const want = pendingFocus.current; if (!want) return;
    pendingFocus.current = null;
    let target = listRef.current?.querySelector<HTMLButtonElement>(`[data-testid="${want}"]`);
    if (target?.disabled) target = listRef.current?.querySelector<HTMLButtonElement>(`[data-testid="${want.replace(/-(up|down)-/, (_m, d) => (d === 'up' ? '-down-' : '-up-'))}"]`);
    target?.focus();
  });

  const reset = () => {
    setConfirmReset(false);
    Object.values(timers.current).forEach((t) => t && clearTimeout(t)); timers.current = {};
    const res = useStudio.getState().dispatch({ type: 'SET_CHANNELS', channels: defaultChannels(project) });
    if (res.ok) { setEdits({}); setErrors({}); setAnnounce('Email and SMS wording reset to the default.'); }
  };

  /* translations (read-only) */
  const languages = useMemo(() => projectLanguages(project), [project]);
  const statusByLocale = useMemo(() => languages.map((l) => ({ locale: l, rows: translationStatus(project, l).rows })), [project, languages]);
  const statusesFor = (k: FieldKey) => statusByLocale.map(({ locale, rows }) => {
    const r = rows.find((x) => x.partId === TRANSLATION_ID[k]);
    return { locale, status: r?.status.status, sourceChanged: r?.sourceChanged };
  });

  /* preview */
  const req = useMemo<ScenarioRequest | null>(() => (baseReq ? { ...baseReq, outputContext: { profileId: 'html-responsive' } } : null), [baseReq]);
  const previewLocale = resolution?.locale ?? record?.customer.locale ?? 'en-US';
  const wantDrafts = useMemo(
    () => previewLocale !== 'en-US' && (statusByLocale.find((s) => s.locale === previewLocale)?.rows ?? translationStatus(project, previewLocale).rows).some((r) => r.status.pendingDraft || r.status.status === 'draft'),
    [project, previewLocale, statusByLocale],
  );
  const email = useCompose<EmailDto>(api.composeEmail, req, channel === 'email', wantDrafts);
  const sms = useCompose<SmsDto>(api.composeSms, req, channel === 'sms', wantDrafts);
  const active = channel === 'email' ? email : sms;
  const customer = record ? recordSummary(record, personas) : null;
  const shownLocale = (active.data as { locale?: string } | undefined)?.locale ?? previewLocale;
  const subjectLen = email.data?.subject.length ?? 0;

  const field = (k: FieldKey, props: Pick<TextFieldProps, 'label' | 'testId'> & Partial<TextFieldProps>) => (
    <TextField project={project} field={k} value={valueOf(k)} error={errors[k]} disabled={!!blockedReason} statuses={statusesFor(k)}
      onChange={(t) => change(k, t)} onCommit={(t) => commit(k, t)} {...props} />
  );

  return (
    <section className="screen" data-testid="channels-view">
      <ScreenHeader id="S15" title="Email & SMS"
        subtitle="Edit the email subject, preview text, heading, opening and closing text and the text message, choose which document sections the email shows and in what order, and check the result for the customer shown in the top bar."
        actions={<button className="btn" onClick={() => setConfirmReset(true)} disabled={!!blockedReason} data-testid="ch-reset"><Icon.reset /> Reset to default wording</button>} />
      <div className="screen-body chx-body">
        <div className="chx-editor" data-testid="ch-editor">
          <div className="chx-bar">
            <div className="segmented" role="group" aria-label="Channel">
              <button aria-pressed={channel === 'email'} onClick={() => setChannel('email')} data-testid="ch-tab-email">Email</button>
              <button aria-pressed={channel === 'sms'} onClick={() => setChannel('sms')} data-testid="ch-tab-sms">SMS</button>
            </div>
          </div>
          {blockedReason && <div className="callout warning" role="status" data-testid="ch-readonly">{blockedReason}. The wording and sections are shown but cannot be changed.</div>}

          {channel === 'email' ? (
            <>
              <div className="panel chx-card">
                <h2 className="section-title">Wording</h2>
                {field('subject', {
                  label: 'Subject', testId: 'ch-email-subject', hint: 'The first line an inbox shows.',
                  extra: <>
                    {subjectLen > 78 && valueOf('subject').trim() ? <div className="callout warning chx-note" role="status" data-testid="ch-subject-long">The subject for this customer is {subjectLen} characters. Many inboxes cut it off after about 78.</div> : null}
                    <SubjectSuggest project={project} current={valueOf('subject')} onUse={(t) => change('subject', t)} />
                  </>,
                })}
                {field('preheader', { label: 'Preview text', testId: 'ch-email-preheader', hint: 'The grey line an inbox shows after the subject. It is cut at 140 characters.' })}
                {field('title', { label: 'Heading', testId: 'ch-email-title', hint: 'The large heading at the top of the email.' })}
                {field('intro', { label: 'Opening text', testId: 'ch-email-intro', multiline: true, optional: true, rows: 3, hint: 'Shown after the greeting. Blank line = new paragraph; **bold** and [link text](https://…) work.',
                  extra: <WritingHelp text={valueOf('intro')} kind="email" locale="en-US" onUse={(t) => change('intro', t)} testId="writing-help-intro" /> })}
                {field('keyFactsHeading', { label: 'Key figures heading', testId: 'ch-email-keyfacts-heading', hint: 'The title above the list of key figures.' })}
                {field('closing', { label: 'Closing text', testId: 'ch-email-closing', multiline: true, optional: true, rows: 3, hint: 'Shown before the required notices. Same formatting as the opening text.',
                  extra: <WritingHelp text={valueOf('closing')} kind="email" locale="en-US" onUse={(t) => change('closing', t)} testId="writing-help-closing" /> })}
              </div>

              <div className="panel chx-card" data-testid="ch-sections">
                <h2 className="section-title">Sections</h2>
                <p className="muted chx-lead">Choose which generated sections the email shows and their order.</p>
                <ul className="list-rows chx-sections" ref={listRef} aria-label="Email sections in order">
                  {cfg.email.sections.map((s, i, all) => (
                    <li key={s.id} className={'chx-section' + (s.show ? '' : ' off')} data-testid={`ch-section-${s.id}`} data-show={s.show}>
                      <div className="chx-section-text">
                        <strong id={`ch-sec-${s.id}`}>{EMAIL_SECTION_LABELS[s.id]}</strong>
                        <span className="muted">{SECTION_DESCRIPTION[s.id]}</span>
                      </div>
                      <button type="button" role="switch" aria-checked={s.show} aria-labelledby={`ch-sec-${s.id}`} disabled={!!blockedReason} className={'chx-switch' + (s.show ? ' on' : '')} onClick={() => toggle(s.id)} data-testid={`ch-section-toggle-${s.id}`}>
                        <span className="chx-switch-knob" /><span className="chx-switch-text">{s.show ? 'Shown' : 'Hidden'}</span>
                      </button>
                      <span className="chx-move">
                        <button type="button" className="btn sm ghost icon" aria-label={`Move ${EMAIL_SECTION_LABELS[s.id]} up`} disabled={!!blockedReason || i === 0} onClick={() => move(s.id, -1)} data-testid={`ch-section-up-${s.id}`}><Icon.chevron width={14} height={14} style={{ transform: 'rotate(-90deg)' }} /></button>
                        <button type="button" className="btn sm ghost icon" aria-label={`Move ${EMAIL_SECTION_LABELS[s.id]} down`} disabled={!!blockedReason || i === all.length - 1} onClick={() => move(s.id, 1)} data-testid={`ch-section-down-${s.id}`}><Icon.chevron width={14} height={14} style={{ transform: 'rotate(90deg)' }} /></button>
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="chx-always" data-testid="ch-always">
                  <strong>Always included</strong>
                  <span className="muted">These cannot be hidden.</span>
                  <div className="chx-always-list">{ALWAYS_INCLUDED.map((a) => <span key={a} className="chip"><Icon.lock width={11} height={11} /> {a}</span>)}</div>
                </div>
                <p className="chx-sr" role="status" aria-live="polite" data-testid="ch-announce">{announce}</p>
              </div>
            </>
          ) : (
            <div className="panel chx-card">
              <h2 className="section-title">Text message</h2>
              {field('sms', {
                label: 'Message', testId: 'ch-sms-text', multiline: true, rows: 4, hint: 'Plain text only. Data fields change the length, so the meter measures the message for the customer in the top bar.',
                extra: <><SmsMeter data={sms.data} busy={sms.busy} /><SmsAssist project={project} value={valueOf('sms')} composed={sms.data?.text} customer={customer?.name} onUse={(t) => change('sms', t)} /></>,
              })}
            </div>
          )}
        </div>

        <aside className="panel chx-preview" data-side="right" data-side-title="Preview" aria-label="Preview" data-testid="ch-preview">
          <div className="chx-pv-head">
            <h2 className="section-title">Preview</h2>
            <span className="muted chx-pv-for" data-testid="ch-preview-for">
              For {customer ? <strong>{customer.name}</strong> : 'the selected customer'} · {languageName(shownLocale)}
            </span>
            {active.busy && <span className="chip info" role="status" data-testid="ch-preview-busy"><span className="spinner" /> Updating…</span>}
          </div>
          <div className="chx-pv-body">
            {active.error && !active.data && <ErrorState title="The preview could not be composed" message={active.error.message} onRetry={active.retry} />}
            {!active.data && !active.error && <Loading label={`Composing ${channel === 'email' ? 'email' : 'SMS'}…`} />}
            {active.error && active.data && (
              <div className="callout error" role="alert" data-testid="ch-compose-error">{active.error.message} <button className="btn sm" onClick={active.retry}>Retry</button></div>
            )}
            {active.data && <DraftMarker draft={active.draft} issues={active.issues} />}
            {channel === 'email' && email.data && (
              <>
                <div className="chx-inbox" aria-label="How the inbox row looks">
                  <div className="chx-inbox-subject" data-testid="ch-preview-subject">{email.data.subject}</div>
                  <div className="chx-inbox-pre" data-testid="ch-preview-preheader">{email.data.preheader.length > 140 ? email.data.preheader.slice(0, 140) + '…' : email.data.preheader}</div>
                </div>
                <div className="chx-pv-tools">
                  <div className="segmented" role="group" aria-label="Email preview width">
                    <button aria-pressed={width === 'desktop'} onClick={() => setWidth('desktop')} data-testid="ch-width-desktop">Desktop 600</button>
                    <button aria-pressed={width === 'mobile'} onClick={() => setWidth('mobile')} data-testid="ch-width-mobile">Mobile 360</button>
                  </div>
                  <button className="btn" aria-pressed={plain} onClick={() => setPlain((p) => !p)} data-testid="ch-plain-toggle">{plain ? 'Show email' : 'Plain text'}</button>
                </div>
                <ParityChips parity={email.data.parity} testId="ch-parity" />
                <div className="chx-stage" data-testid="ch-email-stage">
                  {plain
                    ? <pre className="chx-plain" tabIndex={0} aria-label="Plain-text version" data-testid="ch-email-plain">{email.data.text}</pre>
                    : <iframe title={`Email preview at ${width === 'desktop' ? 600 : 360} pixels`} sandbox="" srcDoc={email.data.html} style={{ width: width === 'desktop' ? 600 : 360 }} data-testid="ch-email-preview" />}
                </div>
                <Warnings items={email.data.warnings} />
              </>
            )}
            {channel === 'sms' && sms.data && <SmsPreview data={sms.data} />}
          </div>
        </aside>
      </div>

      {confirmReset && (
        <Dialog title="Reset to default wording?" onClose={() => setConfirmReset(false)}
          footer={<><button className="btn ghost" onClick={() => setConfirmReset(false)}>Keep my wording</button><button className="btn danger" onClick={reset} data-testid="ch-reset-confirm">Reset wording and sections</button></>}>
          <p>This replaces the email wording, the section choices and order, and the text message with the default wording. English only; translations are kept. You can undo this from the top bar.</p>
        </Dialog>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ SMS pieces */

function SmsMeter({ data, busy }: { data?: SmsDto; busy: boolean }) {
  if (!data) return <div className="chx-meter muted" data-testid="ch-sms-meter" role="status">{busy ? 'Measuring…' : 'No measurement yet.'}</div>;
  const multi = data.segments > 1; const ucs = data.encoding === 'UCS-2';
  const chars = [...new Set((data.nonGsm ?? []).map((n) => `${n.char} (${n.codePoint})`))];
  return (
    <div className={'chx-meter' + (multi || ucs ? ' warn' : '')} data-testid="ch-sms-meter" data-segments={data.segments} data-encoding={data.encoding} role="status" aria-live="polite">
      <div className="chx-meter-main">
        <strong>{data.length}</strong> characters · <span className={'chip ' + (ucs ? 'warning' : 'accent')}>{data.encoding}</span> · <span className={'chip ' + (multi ? 'warning' : 'accent')}>{data.segments} segment{data.segments === 1 ? '' : 's'}</span>
        {busy && <span className="muted"> · updating…</span>}
      </div>
      <div className="muted chx-meter-fine">
        {ucs ? `One segment holds ${data.perSegment} characters in this encoding.` : `One segment holds ${data.perSegment} characters.`} Measured for this customer after the data fields are filled in.
      </div>
      {ucs && <div className="chx-meter-why" data-testid="ch-sms-nongsm">A character outside the standard SMS alphabet switches the whole message to UCS-2, which fits far fewer characters per segment: {chars.join(', ')}.</div>}
      {multi && <div className="chx-meter-why">This message needs {data.segments} segments, and each one is billed and delivered separately.</div>}
    </div>
  );
}

function SmsPreview({ data }: { data: SmsDto }) {
  const pieces = useMemo(() => {
    const bad = new Map((data.nonGsm ?? []).map((n) => [n.index, n]));
    const out: Array<{ t: string; bad?: { codePoint: string } }> = [];
    let i = 0;
    for (const ch of data.text) { const b = bad.get(i); out.push(b ? { t: ch, bad: b } : { t: ch }); i += ch.length; }
    return out;
  }, [data]);
  return (
    <>
      <div className="chx-phone" role="img" aria-label={`Phone preview of the text message: ${data.text}`}>
        <div className="chx-phone-bar">Text message · now</div>
        <p className="chx-bubble" data-testid="ch-sms-preview">
          {pieces.map((p, i) => (p.bad ? <mark key={i} className="chx-nongsm" title={`Not in the standard SMS alphabet: ${p.bad.codePoint}`}>{p.t}</mark> : <span key={i}>{p.t}</span>))}
        </p>
      </div>
      <ParityChips parity={data.parity} testId="ch-parity" />
      <Warnings items={data.warnings} />
    </>
  );
}

/* ------------------------------------------------------------------ writing assistance */

/** Three alternative subject lines with their length. Needs a live model; "Use this" fills the subject field. */
function SubjectSuggest({ project, current, onUse }: { project: Project; current: string; onUse: (text: string) => void }) {
  const [res, setRes] = useState<{ mode: 'ai' | 'unavailable'; message: string; options: Array<{ text: string }> } | null>(null);
  const [busy, run] = useBusy();
  const ro = useReadOnlyReason();
  const seq = useRef(0);
  const ask = async () => {
    const my = ++seq.current; setRes(null);
    const r = await run(() => api.assistSubjectLines(project.projectId, { current, project }));
    if (r && seq.current === my) setRes(r);
  };
  return (
    <div className="wh-block" data-testid="subject-assist">
      <div className="wh-row">
        <button type="button" className="btn sm ghost" onClick={ask} disabled={busy} aria-busy={busy} data-testid="subject-suggest"><Icon.ai width={12} height={12} /> {busy ? 'Thinking…' : 'Suggest subject lines'}</button>
        {res && <button type="button" className="btn sm ghost" onClick={() => { seq.current++; setRes(null); }}>Hide suggestions</button>}
      </div>
      <div aria-live="polite">
        {res?.mode === 'unavailable' && <NeedsAi message={res.message} />}
        {res?.mode === 'ai' && res.options.length === 0 && <p className="muted wh-note">{res.message || 'The assistant returned no subject lines.'}</p>}
        {res?.mode === 'ai' && res.options.length > 0 && (
          <ul className="wh-options" aria-label="Subject line suggestions">
            {res.options.map((o, i) => (
              <li key={i} className="wh-option" data-testid="subject-option">
                <span className="wh-option-text" data-testid="subject-option-text">{o.text}</span>
                <button type="button" className="btn sm primary" disabled={!!ro} title={ro ?? undefined} data-testid="subject-option-use" onClick={() => { onUse(o.text); recordAssist('subject', 'Used a suggested email subject line', 'ai'); setRes(null); }}>Use this</button>
                <span className={'wh-option-meta' + (o.text.length > 70 ? ' warn' : '')} data-testid="subject-option-length">
                  <span className="chip ai-chip info">AI suggestion</span> {o.text.length} characters{o.text.length > 70 ? ' · long: many inboxes cut a subject off after about 70' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Fills a template's data fields with what the composed preview actually shows for the customer in the top bar.
 * The values are read back out of the composed message by matching it against the template; when that is not
 * possible (another language, or the preview is behind the text) the template itself is measured.
 */
function sampleFrom(template: string, composed: string | undefined): ((t: string) => string) | undefined {
  if (!composed) return undefined;
  const tokens = [...template.matchAll(TOKEN_RE)];
  if (!tokens.length) return undefined;
  const lit = (t: string) => escapeRe(t).replace(/\s+/g, '\\s+');
  let re = ''; let last = 0;
  for (const m of tokens) { re += lit(template.slice(last, m.index)) + '([\\s\\S]+?)'; last = m.index! + m[0].length; }
  re += lit(template.slice(last));
  const hit = new RegExp(`^\\s*${re}\\s*$`).exec(composed);
  if (!hit) return undefined;
  const values = new Map<string, string>();
  tokens.forEach((m, i) => { if (!values.has(m[1])) values.set(m[1], hit[i + 1]); });
  return (t) => t.replace(TOKEN_RE, (m, name: string) => values.get(name) ?? m);
}

const measureLine = (m: { length: number; encoding: string; segments: number }) => `${m.length} characters · ${m.encoding} · ${m.segments} segment${m.segments === 1 ? '' : 's'}`;

/** "Fit in one message" (built-in, no model) and "Rewrite to fit (AI)". Accepting fills the SMS field; autosave then applies. */
function SmsAssist({ project, value, composed, customer, onUse }: { project: Project; value: string; composed?: string; customer?: string; onUse: (text: string) => void }) {
  const [fit, setFit] = useState<{ original: string; result: ReturnType<typeof fitSms>; measured: boolean } | null>(null);
  const [ai, setAi] = useState<{ original: string; mode: 'ai' | 'unavailable'; message: string; options: Array<{ text: string; tokenCheck: { ok: boolean; missing: string[]; extra: string[] } }>; sample?: (t: string) => string } | null>(null);
  const [aiBusy, run] = useBusy();
  const [dismissedAi, setDismissedAi] = useState<Set<number>>(new Set());
  const seq = useRef(0);
  const sample = useMemo(() => sampleFrom(value, composed), [value, composed]);
  const measuredFor = (measured: boolean) => (measured ? `Measured with the data fields filled in${customer ? ` for ${customer}` : ''}.` : 'Measured on the wording only: the data fields could not be filled in from the preview, so the real message may be longer.');
  const runFit = () => { setAi(null); setFit({ original: value, result: fitSms(value, { sample }), measured: !!sample }); };
  const runAi = async () => {
    const my = ++seq.current; setFit(null); setAi(null); setDismissedAi(new Set());
    const r = await run(() => api.assistRewrite(project.projectId, { text: value, style: 'one-sms', kind: 'sms', locale: 'en-US', project }));
    if (r && seq.current === my) setAi({ original: value, mode: r.mode, message: r.message, options: r.options ?? [], sample });
  };
  const f = fit?.result;
  const changed = !!f && f.text !== fit!.original;
  return (
    <div className="wh-block" data-testid="sms-assist">
      <div className="wh-row">
        <button type="button" className="btn sm" onClick={runFit} disabled={!value.trim()} data-testid="sms-fit"><Icon.ai width={12} height={12} /> Fit in one message</button>
        <button type="button" className="btn sm ghost" onClick={runAi} disabled={aiBusy || !value.trim()} aria-busy={aiBusy} data-testid="sms-fit-ai">{aiBusy ? <><span className="spinner" aria-hidden="true" /> Rewriting…</> : 'Rewrite to fit (AI)'}</button>
        {(fit || ai) && <button type="button" className="btn sm ghost" onClick={() => { seq.current++; setFit(null); setAi(null); }}>Close</button>}
      </div>
      <div aria-live="polite" className="wh-block">
        {f && !changed && (
          <p className="callout accent wh-note" role="status" data-testid="sms-fit-nochange" style={{ margin: 0 }}>
            {f.fits ? <>This message already fits in one message ({measureLine(f.before)}). {measuredFor(fit!.measured)}</> : <span data-testid="sms-fit-notfit">Could not fit one message without rewording. It is {measureLine(f.before)}. {measuredFor(fit!.measured)} Try “Rewrite to fit (AI)” or shorten the wording yourself.</span>}
          </p>
        )}
        {f && changed && (
          <GuardedSuggestion original={fit!.original} suggestion={f.text} source="builtin"
            note={<div data-testid="sms-fit-detail">
              <ul className="wh-changes" data-testid="sms-fit-changes">{f.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
              <div className="wh-measure"><span>Before: <strong data-testid="sms-fit-before">{measureLine(f.before)}</strong></span><span aria-hidden="true">→</span><span>After: <strong data-testid="sms-fit-after">{measureLine(f.after)}</strong></span></div>
              <div className="muted">{measuredFor(fit!.measured)} Data fields, links and capital-letter safety sentences are kept as they are.</div>
              {!f.fits && <p className="wh-stillnot" data-testid="sms-fit-notfit">Could not fit one message without rewording. This is the closest the built-in fix gets.</p>}
            </div>}
            onAccept={() => { onUse(f.text); recordAssist('sms-fit', 'Fitted the text message to fewer characters', 'builtin'); setFit(null); }}
            onDiscard={() => setFit(null)} />
        )}
        {ai?.mode === 'unavailable' && <NeedsAi message={ai.message} />}
        {ai?.mode === 'ai' && ai.options.length === 0 && <p className="muted wh-note">{ai.message || 'The assistant returned no usable message.'}</p>}
        {ai?.mode === 'ai' && ai.options.map((o, i) => {
          if (dismissedAi.has(i)) return null;
          const m = smsEncoding(ai.sample ? ai.sample(o.text) : o.text);
          return (
            <GuardedSuggestion key={i} original={ai.original} suggestion={o.text} source="ai"
              blockedReason={o.tokenCheck.ok ? null : 'This suggestion changes the data fields in the text, so it cannot be used.'}
              note={<span data-testid="sms-fit-ai-detail">{lengthChange(ai.original, o.text)} · {measureLine({ length: m.length, encoding: m.encoding, segments: m.segments })}{!ai.sample && ' (wording only)'}{m.encoding !== 'GSM-7' || m.segments > 1 ? ' · still more than one message' : ' · fits one message'}</span>}
              onAccept={() => { onUse(o.text); recordAssist('sms-fit', 'Used an AI rewrite to fit the text message', 'ai'); setAi(null); }}
              onDiscard={() => setDismissedAi((d) => new Set(d).add(i))} />
          );
        })}
      </div>
    </div>
  );
}

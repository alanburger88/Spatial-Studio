import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { BrandLogo } from '../ui/Brand';
import './review.css';

/**
 * The public review page (`/review/:token`, docs/api/REVIEW_LINKS.md). It is outside the studio: no menu, no top bar,
 * no studio data, no sign-in. It talks only to the five `/api/v1/review/:token/` routes, through the tiny client below.
 * The web page output runs in a sandboxed frame without access to this page, as in the studio's Preview.
 */

type OutputId = 'pdf' | 'html' | 'email' | 'sms';
interface Summary {
  banner: string; label: string;
  document: { title: string; kind: string };
  version: { kind: 'release' | 'version'; releaseNumber: number | null; version: number };
  newerExists: boolean; withdrawn: boolean; expiresAt: string;
  customers: Array<{ key: string; name: string; language: string | null }>;
  languages: Array<{ code: string; name: string }>;
  outputs: Array<{ id: OutputId; label: string }>;
  parts: Array<{ key: string; name: string }>;
  limits: { nameMax: number; commentMax: number };
}
interface OutputAnswer {
  customer: { key: string; name: string }; output: OutputId; language: { code: string; name: string };
  stopped?: { reasons: string[] };
  html?: string;
  email?: { subject: string; preheader: string; html: string; text: string };
  sms?: { text: string };
  pdf?: { query: string };
}
interface ReviewComment {
  id: string; author: string; body: string; createdAt: string; resolved: boolean;
  customer: { key: string; name: string | null }; output: { id: OutputId; label: string }; language: { code: string; name: string }; part: string | null;
  replies: Array<{ id: string; author: string; body: string; createdAt: string; fromStudio: boolean }>;
}

const DEAD = 'This review link is not available. Ask the person who sent it for a new one.';
class Failure extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

async function call<T>(token: string, rest: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/review/${encodeURIComponent(token)}${rest}`, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined });
  } catch {
    throw new Failure(0, 'NETWORK', 'The studio cannot be reached right now. Try again in a moment.');
  }
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (!res.ok) throw new Failure(res.status, body?.error?.code ?? `HTTP_${res.status}`, body?.error?.message ?? 'That did not work.');
  return body as T;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const NAME_KEY = 'iss.review.name';
const readName = () => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } };
const keepName = (n: string) => { try { localStorage.setItem(NAME_KEY, n); } catch { /* private window: fine */ } };

/** Rule 12 for the page itself: no referrer leaves it and search engines do not keep it. */
function useHardenedHead(title: string) {
  useEffect(() => {
    const metas = [['referrer', 'no-referrer'], ['robots', 'noindex, nofollow']].map(([name, content]) => {
      const m = document.createElement('meta'); m.name = name; m.content = content; document.head.appendChild(m); return m;
    });
    return () => metas.forEach((m) => m.remove());
  }, []);
  useEffect(() => { document.title = title; }, [title]);
}

export function ReviewPage({ token }: { token: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [rev, setRev] = useState(0);
  useHardenedHead(summary ? `Review: ${summary.document.title}` : 'Review link');

  useEffect(() => {
    let live = true;
    call<Summary>(token, '').then((s) => { if (live) { setSummary(s); setFailure(null); } }, (e) => { if (live) setFailure(e instanceof Failure ? e : new Failure(0, 'X', String(e))); });
    return () => { live = false; };
  }, [token, rev]);

  if (failure && !summary) {
    const deadLink = failure.code === 'REVIEW_LINK_NOT_AVAILABLE';
    return (
      <Frame banner={null}>
        <section className="rv-dead panel" data-testid="review-dead" role="alert">
          <h1>{deadLink ? 'Review link not available' : 'The review could not be loaded'}</h1>
          <p>{deadLink ? DEAD : failure.message}</p>
          {!deadLink && <button type="button" className="btn" onClick={() => setRev((r) => r + 1)}>Try again</button>}
        </section>
      </Frame>
    );
  }
  if (!summary) return <Frame banner={null}><p className="rv-loading muted" role="status"><span className="spinner" /> Opening the review…</p></Frame>;
  return <Review token={token} s={summary} />;
}

function Frame({ banner, children }: { banner: string | null; children: ReactNode }) {
  return (
    <div className="rv-page" data-testid="review-page">
      <header className="rv-top">
        <BrandLogo height={24} alt="InfoSlips" />
        <span className="rv-top-name">Document review</span>
      </header>
      {banner && <div className="rv-banner" role="note" data-testid="review-banner"><strong>{banner}</strong></div>}
      <main className="rv-main" id="main">{children}</main>
    </div>
  );
}

function Review({ token, s }: { token: string; s: Summary }) {
  const [customer, setCustomer] = useState(s.customers[0]?.key ?? '');
  const [output, setOutput] = useState<OutputId>(s.outputs[0]?.id ?? 'pdf');
  const current = s.customers.find((c) => c.key === customer) ?? null;
  const preferred = current?.language && s.languages.some((l) => l.code === current.language) ? current.language : s.languages[0]?.code ?? '';
  const [language, setLanguage] = useState<string>(preferred);
  // A new customer starts in their own language when the link offers it.
  const pickCustomer = (key: string) => {
    setCustomer(key);
    const c = s.customers.find((x) => x.key === key);
    if (c?.language && s.languages.some((l) => l.code === c.language)) setLanguage(c.language);
  };
  const version = s.version.kind === 'release' ? `Release ${s.version.releaseNumber} (version ${s.version.version})` : `Saved version ${s.version.version}`;

  return (
    <Frame banner={s.banner}>
      <section className="rv-intro" aria-labelledby="rv-title">
        <h1 id="rv-title" data-testid="review-title">{s.document.title}</h1>
        <p className="rv-meta">
          <span>{s.document.kind}</span>
          <span data-testid="review-version">{version}</span>
          <span>Shared as “{s.label}”</span>
          <span>Open until {day(s.expiresAt)}</span>
        </p>
        <p className="rv-lead muted">You can look at this document for the customers below and leave comments. The customers are made up for testing. Your comments go to the team that writes the document.</p>
        {s.newerExists && <div className="callout accent" role="note" data-testid="review-newer">A newer version of this document exists. This page shows the version you were sent. Ask for a new link to see the newer one.</div>}
        {s.withdrawn && <div className="callout warning" role="note" data-testid="review-withdrawn">This release was withdrawn. It is no longer used for customers. You can still look at it and comment.</div>}
      </section>

      {s.customers.length === 0 ? (
        <div className="callout warning" role="status" data-testid="review-no-customers">None of the customers in this link can be shown any more. Ask the person who sent it for a new link.</div>
      ) : (
        <>
          <div className="rv-controls" role="group" aria-label="What to show">
            <label className="field rv-field">
              <span className="label">Customer</span>
              <select className="select" value={customer} onChange={(e) => pickCustomer(e.target.value)} data-testid="review-customer">
                {s.customers.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
              </select>
            </label>
            <div className="field rv-field">
              <span className="label" id="rv-output-label">Output</span>
              <div className="segmented rv-seg" role="group" aria-labelledby="rv-output-label" data-testid="review-outputs">
                {s.outputs.map((o) => <button key={o.id} type="button" aria-pressed={output === o.id} onClick={() => setOutput(o.id)} data-testid={`review-output-${o.id}`}>{o.label}</button>)}
              </div>
            </div>
            {s.languages.length > 1 ? (
              <label className="field rv-field">
                <span className="label">Language</span>
                <select className="select" value={language} onChange={(e) => setLanguage(e.target.value)} data-testid="review-language">
                  {s.languages.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
                </select>
              </label>
            ) : <p className="field rv-field"><span className="label">Language</span><span data-testid="review-language-only">{s.languages[0]?.name}</span></p>}
          </div>

          <div className="rv-layout">
            <OutputView token={token} customer={customer} customerName={current?.name ?? ''} output={output} language={language} label={s.outputs.find((o) => o.id === output)?.label ?? output} />
            <Comments token={token} s={s} customer={customer} customerName={current?.name ?? ''} output={output} language={language} />
          </div>
        </>
      )}
      <footer className="rv-foot muted">This page is served by the studio that made it. It shows made-up customers only. Nothing you do here changes the document.</footer>
    </Frame>
  );
}

function OutputView({ token, customer, customerName, output, language, label }: { token: string; customer: string; customerName: string; output: OutputId; language: string; label: string }) {
  const [state, setState] = useState<{ key: string; data: OutputAnswer | null; error: string | null }>({ key: '', data: null, error: null });
  const key = `${customer}|${output}|${language}`;
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ key, data: null, error: null });
    call<OutputAnswer>(token, `/output?customer=${encodeURIComponent(customer)}&output=${output}&language=${encodeURIComponent(language)}`)
      .then((d) => { if (live) setState({ key, data: d, error: null }); }, (e) => { if (live) setState({ key, data: null, error: e instanceof Failure && e.code === 'REVIEW_LINK_NOT_AVAILABLE' ? DEAD : e.message }); });
    return () => { live = false; };
  }, [token, key, customer, output, language, retry]);
  const d = state.key === key ? state.data : null;
  const err = state.key === key ? state.error : null;
  const pdfUrl = d?.pdf ? `/api/v1/review/${encodeURIComponent(token)}/pdf?${d.pdf.query}` : null;

  return (
    <section className="panel rv-output" aria-labelledby="rv-output-h" data-testid="review-output" data-output={output} data-customer={customer} data-language={language} aria-busy={!d && !err}>
      <div className="panel-head rv-output-head">
        <h2 className="section-title" id="rv-output-h">{label} for {customerName}</h2>
        {d && <span className="muted rv-output-lang" data-testid="review-output-language">{d.language.name}</span>}
      </div>
      <div className="rv-output-body">
        {err ? <div className="callout error" role="alert">{err} <button type="button" className="btn sm" onClick={() => setRetry((r) => r + 1)}>Try again</button></div>
          : !d ? <p className="muted" role="status"><span className="spinner" /> Making the {label.toLowerCase()}…</p>
          : d.stopped ? (
            <div className="callout warning" role="status" data-testid="review-stopped">
              <strong>This document is not sent to this customer as things stand.</strong> The studio stops it because {d.stopped.reasons.join('; ')}. The team that writes the document can see why.
            </div>
          )
          : d.html ? <iframe className="rv-frame rv-frame-web" title={`Web page for ${customerName}`} sandbox="allow-scripts allow-popups" srcDoc={d.html} data-testid="review-html" />
          : d.email ? (
            <div className="rv-email" data-testid="review-email">
              <dl className="rv-email-head">
                <dt>Subject</dt><dd data-testid="review-email-subject">{d.email.subject}</dd>
                <dt>Preview text</dt><dd>{d.email.preheader}</dd>
              </dl>
              <iframe className="rv-frame rv-frame-email" title={`Email for ${customerName}`} sandbox="" srcDoc={d.email.html} />
            </div>
          )
          : d.sms ? (
            <div className="rv-sms" data-testid="review-sms">
              <p className="rv-sms-bubble">{d.sms.text}</p>
              <p className="muted rv-sms-count">{d.sms.text.length} characters</p>
            </div>
          )
          : pdfUrl ? (
            <div className="rv-pdf" data-testid="review-pdf">
              <p><a className="btn" href={pdfUrl} target="_blank" rel="noopener noreferrer" data-testid="review-pdf-open">Open the PDF</a> <span className="muted">It opens in a new tab. It may take a few seconds to make.</span></p>
              <object className="rv-frame rv-frame-pdf" data={pdfUrl} type="application/pdf" aria-label={`PDF for ${customerName}`}>
                <p className="muted">Your browser does not show PDF files on the page. Use “Open the PDF”.</p>
              </object>
            </div>
          ) : <p className="muted">Nothing to show.</p>}
      </div>
    </section>
  );
}

function Comments({ token, s, customer, customerName, output, language }: { token: string; s: Summary; customer: string; customerName: string; output: OutputId; language: string }) {
  const [list, setList] = useState<ReviewComment[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState(readName);
  const [part, setPart] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(() => {
    call<{ comments: ReviewComment[] }>(token, '/comments').then((r) => { setList(r.comments); setLoadError(null); }, (e) => setLoadError(e instanceof Failure && e.code === 'REVIEW_LINK_NOT_AVAILABLE' ? DEAD : e.message));
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null); setDone(null);
    if (!name.trim()) { setError('Type your name.'); return; }
    if (!body.trim()) { setError('Write a comment first.'); return; }
    setBusy(true);
    try {
      await call(token, '/comments', { method: 'POST', body: JSON.stringify({ name: name.trim(), body, customer, output, language, ...(part ? { part } : {}) }) });
      keepName(name.trim());
      setBody(''); setDone('Thank you. Your comment was sent.');
      load();
    } catch (err) {
      setError(err instanceof Failure && err.code === 'REVIEW_LINK_NOT_AVAILABLE' ? DEAD : err instanceof Error ? err.message : 'That did not work.');
    } finally { setBusy(false); }
  };
  const outputLabel = s.outputs.find((o) => o.id === output)?.label ?? output;
  const languageName = s.languages.find((l) => l.code === language)?.name ?? language;
  const sorted = useMemo(() => [...(list ?? [])].reverse(), [list]);

  return (
    <aside className="panel rv-comments" aria-labelledby="rv-comments-h" data-testid="review-comments">
      <div className="panel-head"><h2 className="section-title" id="rv-comments-h">Comments {list && <span className="chip count">{list.length}</span>}</h2></div>
      <div className="rv-comments-body">
        <form className="rv-form" onSubmit={submit} aria-describedby="rv-form-about" data-testid="review-comment-form">
          <p className="muted rv-about" id="rv-form-about">About <strong>{customerName}</strong>, {outputLabel.toLowerCase()}, {languageName}.</p>
          <label className="field">
            <span className="label">Your name</span>
            <input className="input" value={name} maxLength={s.limits.nameMax} onChange={(e) => setName(e.target.value)} autoComplete="name" required data-testid="review-name" />
          </label>
          {s.parts.length > 0 && (
            <label className="field">
              <span className="label">Which part</span>
              <select className="select" value={part} onChange={(e) => setPart(e.target.value)} data-testid="review-part">
                <option value="">The whole document</option>
                {s.parts.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
              </select>
            </label>
          )}
          <label className="field">
            <span className="label">Comment</span>
            <textarea className="textarea" value={body} maxLength={s.limits.commentMax} onChange={(e) => setBody(e.target.value)} required data-testid="review-body" />
            <span className="muted rv-count" aria-live="polite">{body.length} of {s.limits.commentMax.toLocaleString()} characters</span>
          </label>
          {error && <div className="callout error" role="alert" data-testid="review-comment-error">{error}</div>}
          {done && <div className="callout accent" role="status" data-testid="review-comment-done">{done}</div>}
          <button type="submit" className="btn primary" disabled={busy} data-testid="review-send">{busy ? 'Sending…' : 'Send comment'}</button>
          <p className="muted rv-fine">Your name is shown with your comment. It is not checked. Please do not type real customer details.</p>
        </form>

        <h3 className="rv-thread-h">Comments through this link</h3>
        {loadError ? <div className="callout error" role="alert">{loadError}</div>
          : !list ? <p className="muted" role="status"><span className="spinner" /> Loading comments…</p>
          : list.length === 0 ? <p className="muted" data-testid="review-no-comments">No comments yet.</p>
          : (
            <ol className="rv-thread" data-testid="review-thread">
              {sorted.map((c) => (
                <li key={c.id} className="rv-comment" data-testid="review-comment" data-id={c.id}>
                  <div className="rv-comment-head">
                    <strong>{c.author}</strong>
                    <time className="muted" dateTime={c.createdAt}>{when(c.createdAt)}</time>
                    {c.resolved && <span className="chip accent" data-testid="review-comment-resolved">Resolved</span>}
                  </div>
                  <p className="muted rv-comment-about">{c.customer.name ?? 'A customer no longer in this link'} · {c.output.label} · {c.language.name}{c.part ? ` · ${c.part}` : ''}</p>
                  <p className="rv-comment-body">{c.body}</p>
                  {c.replies.length > 0 && (
                    <ul className="rv-replies">
                      {c.replies.map((r) => (
                        <li key={r.id} className="rv-reply" data-testid="review-reply">
                          <div className="rv-comment-head"><strong>{r.author}</strong> <span className="chip info">Reply from the studio</span> <time className="muted" dateTime={r.createdAt}>{when(r.createdAt)}</time></div>
                          <p className="rv-comment-body">{r.body}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          )}
      </div>
    </aside>
  );
}

export default ReviewPage;

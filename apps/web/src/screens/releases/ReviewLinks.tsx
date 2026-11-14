import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { create } from 'zustand';
import { ApiFailure, reviewLinksApi, type ReviewLinkDto, type ReviewLinkOptionsDto, type ReviewOutputId } from '../../api/client';
import { useStudio } from '../../state/store';
import { Dialog } from '../../ui/common';
import { fmtAbs } from '../../ui/time';
import './ReviewLinks.css';

/**
 * Review links in the studio (wave 4, docs/api/REVIEW_LINKS.md): "Share for review" on Releases and on Before & after,
 * the dialog that makes a link and shows it once, the "Review links" panel on Releases and the line on Overview.
 * A link holder can view and comment only; nothing they do changes the document.
 */

/** Bumped whenever a link is made or revoked, so every list on screen reloads. */
export const useReviewLinksRev = create<{ rev: number; bump: () => void }>((set) => ({ rev: 0, bump: () => set((s) => ({ rev: s.rev + 1 })) }));

const OUTPUT_ORDER: ReviewOutputId[] = ['pdf', 'html', 'email', 'sms'];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const linkUrl = (path: string) => `${window.location.origin}${path}`;
export const targetWords = (t: ReviewLinkDto['target']) => (t.kind === 'release' ? `Release ${t.releaseNumber ?? '?'} (version ${t.version})` : `Saved version ${t.version}`);

/** Whether the person may make a link: anyone with `comment` (with sign-in off, the local admin). */
function useMayShare(): { allowed: boolean; why: string | null } {
  const session = useStudio((s) => s.session);
  if (!session?.authEnabled) return { allowed: true, why: null };
  return session.permissions.includes('comment') ? { allowed: true, why: null } : { allowed: false, why: 'Your role cannot share a document for review.' };
}

/* ------------------------------------------------------------------ the button and the dialog */

export function ShareForReview({ projectId, target, testId = 'share-review', className = 'btn sm', note }: { projectId: string; target: { releaseId?: string; version?: number }; testId?: string; className?: string; note?: string }) {
  const [open, setOpen] = useState(false);
  const may = useMayShare();
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} disabled={!may.allowed} title={may.why ?? 'Make a link that lets someone without an account look at this version and comment'} data-testid={testId}>Share for review</button>
      {open && <ShareDialog projectId={projectId} target={target} note={note} onClose={() => setOpen(false)} />}
    </>
  );
}

function ShareDialog({ projectId, target, note, onClose }: { projectId: string; target: { releaseId?: string; version?: number }; note?: string; onClose: () => void }) {
  const studioRecord = useStudio((s) => s.ctx.recordId);
  const [opts, setOpts] = useState<ReviewLinkOptionsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [customers, setCustomers] = useState<string[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<ReviewOutputId[]>(OUTPUT_ORDER);
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ link: ReviewLinkDto; url: string } | null>(null);

  useEffect(() => {
    let live = true;
    reviewLinksApi.options(projectId, target).then((o) => {
      if (!live) return;
      setOpts(o);
      setLabel(o.target.kind === 'release' ? `Review of release ${o.target.releaseNumber}` : `Review of version ${o.target.version}`);
      const allowed = o.customers.filter((c) => c.allowed);
      setCustomers([(allowed.find((c) => c.recordId === studioRecord) ?? allowed[0])?.recordId].filter((x): x is string => !!x));
      setLanguages(o.languages.map((l) => l.code));
      setDays(o.limits.expiryDefaultDays);
    }, (e) => live && setLoadError(e instanceof ApiFailure ? e.message : 'The choices could not be loaded.'));
    return () => { live = false; };
  }, [projectId, target.releaseId, target.version, studioRecord]);

  const toggle = <T,>(list: T[], v: T, on: boolean): T[] => (on ? [...list, v] : list.filter((x) => x !== v));
  const max = opts?.limits.customersMax ?? 12;
  const blocked = opts?.customers.filter((c) => !c.allowed) ?? [];
  const problem = !opts ? null
    : customers.length < 1 ? 'Choose at least one customer.'
    : customers.length > max ? `Choose at most ${max} customers.`
    : languages.length < 1 ? 'Choose at least one language.'
    : outputs.length < 1 ? 'Choose at least one output.'
    : opts.active >= opts.limits.activePerDocument ? `This document already has ${opts.limits.activePerDocument} active review links. Revoke one first.`
    : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (problem || !opts) return;
    setBusy(true); setError(null);
    try {
      const res = await reviewLinksApi.create(projectId, { ...(target.releaseId ? { releaseId: target.releaseId } : { version: target.version }), label: label.trim(), customers, languages, outputs: OUTPUT_ORDER.filter((o) => outputs.includes(o)), expiresInDays: days });
      setMade({ link: res.link, url: linkUrl(res.path) });
      useReviewLinksRev.getState().bump();
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'The link could not be made.');
    } finally { setBusy(false); }
  };

  if (made) return <LinkMade link={made.link} url={made.url} onClose={onClose} />;
  const footer = (
    <>
      <span className="muted rl-foot-why" role="status">{problem ?? ''}</span>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="submit" form="rl-share-form" className="btn primary" disabled={!opts || !!problem || busy} data-testid="share-review-make">{busy ? 'Making…' : 'Make the link'}</button>
    </>
  );
  return (
    <Dialog title={<strong>Share for review</strong>} onClose={onClose} footer={footer} labelledBy="rl-share-title">
      <div className="rl-dialog" data-testid="share-review-dialog">
        {loadError ? <div className="callout error" role="alert">{loadError}</div> : !opts ? <p className="muted" role="status"><span className="spinner" /> Loading the choices…</p> : (
          <form id="rl-share-form" onSubmit={submit} className="rl-form">
            <p className="rl-lead">
              Anyone with the link can look at <strong>{opts.target.kind === 'release' ? `release ${opts.target.releaseNumber}` : `saved version ${opts.target.version}`}</strong> of “{opts.target.title}” for the customers you choose, and leave comments. They need no account. They cannot change anything or approve it.
            </p>
            {note && <div className="callout warning" role="note" data-testid="share-review-note">{note}</div>}
            <label className="field">
              <span className="label">Label</span>
              <input className="input" value={label} maxLength={opts.limits.labelMax} onChange={(e) => setLabel(e.target.value)} data-testid="share-review-label" />
              <span className="muted rl-hint">The reviewer sees it, and it is shown with each comment. Do not put customer details in it.</span>
            </label>

            <fieldset className="rl-fieldset" data-testid="share-review-customers">
              <legend>Customers <span className="muted">({customers.length} of at most {max})</span></legend>
              <p className="muted rl-hint">Only built-in sample customers and generated test customers can be shared. Imported customers, and customers whose data a person supplied or edited, never can: they might hold real data.</p>
              <ul className="rl-checks">
                {opts.customers.filter((c) => c.allowed).map((c) => (
                  <li key={c.recordId}>
                    <label><input type="checkbox" checked={customers.includes(c.recordId)} onChange={(e) => setCustomers((l) => toggle(l, c.recordId, e.target.checked))} disabled={!customers.includes(c.recordId) && customers.length >= max} data-testid={`share-review-customer-${c.recordId}`} /> {c.name} <span className="muted">{c.kind === 'generated' ? 'generated' : 'sample'}</span></label>
                  </li>
                ))}
              </ul>
              {blocked.length > 0 && (
                <details className="rl-blocked" data-testid="share-review-blocked">
                  <summary>{plural(blocked.length, 'customer')} cannot be shared</summary>
                  <ul className="rl-checks">
                    {blocked.map((c) => <li key={c.recordId}><label className="muted"><input type="checkbox" disabled checked={false} readOnly aria-describedby={`rl-why-${c.recordId}`} /> {c.name}</label> <span className="muted rl-why" id={`rl-why-${c.recordId}`}>{c.reason}</span></li>)}
                  </ul>
                </details>
              )}
            </fieldset>

            <div className="rl-row">
              <fieldset className="rl-fieldset" data-testid="share-review-languages">
                <legend>Languages</legend>
                <ul className="rl-checks">
                  {opts.languages.map((l) => <li key={l.code}><label><input type="checkbox" checked={languages.includes(l.code)} onChange={(e) => setLanguages((x) => toggle(x, l.code, e.target.checked))} /> {l.name}</label></li>)}
                </ul>
                <p className="muted rl-hint">Approved wording only. Draft translations are never shown.</p>
              </fieldset>
              <fieldset className="rl-fieldset" data-testid="share-review-outputs">
                <legend>Outputs</legend>
                <ul className="rl-checks">
                  {opts.outputs.map((o) => <li key={o.id}><label><input type="checkbox" checked={outputs.includes(o.id)} onChange={(e) => setOutputs((x) => toggle(x, o.id, e.target.checked))} data-testid={`share-review-output-${o.id}`} /> {o.label}</label></li>)}
                </ul>
              </fieldset>
            </div>

            <label className="field rl-days">
              <span className="label">Expires after</span>
              <span className="rl-days-row">
                <select className="select" value={days} onChange={(e) => setDays(Number(e.target.value))} data-testid="share-review-days">
                  {Array.from({ length: opts.limits.expiryMaxDays - opts.limits.expiryMinDays + 1 }, (_, i) => i + opts.limits.expiryMinDays).map((d) => <option key={d} value={d}>{plural(d, 'day')}</option>)}
                </select>
                <span className="muted">Every link expires. You can revoke it sooner.</span>
              </span>
            </label>
            {error && <div className="callout error" role="alert" data-testid="share-review-error">{error}</div>}
          </form>
        )}
      </div>
    </Dialog>
  );
}

/** The link, shown once. */
function LinkMade({ link, url, onClose }: { link: ReviewLinkDto; url: string; onClose: () => void }) {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied('yes'); }
    catch {
      input.current?.select();
      try { setCopied(document.execCommand('copy') ? 'yes' : 'no'); } catch { setCopied('no'); }
    }
  };
  return (
    <Dialog title={<strong>Review link made</strong>} onClose={onClose} labelledBy="rl-made-title" footer={<button type="button" className="btn primary" onClick={onClose} data-testid="share-review-done">Done</button>}>
      <div className="rl-dialog" data-testid="share-review-made">
        <div className="callout warning" role="note" data-testid="share-review-once"><strong>Copy the link now. It is shown only this once and cannot be shown again.</strong> If it is lost, make a new one.</div>
        <label className="field rl-url">
          <span className="label">The link</span>
          <span className="rl-url-row">
            <input ref={input} className="input mono" readOnly value={url} onFocus={(e) => e.currentTarget.select()} data-testid="share-review-url" aria-describedby="rl-copied" />
            <button type="button" className="btn primary" onClick={copy} data-testid="share-review-copy">Copy</button>
          </span>
          <span id="rl-copied" className="muted" role="status">{copied === 'yes' ? 'Copied.' : copied === 'no' ? 'Select the link and copy it yourself.' : ''}</span>
        </label>
        <ul className="rl-facts">
          <li>{targetWords(link.target)}, {plural(link.customers.length, 'customer')}, {link.outputs.length === 4 ? 'all four outputs' : plural(link.outputs.length, 'output')}.</li>
          <li>It expires on {fmtAbs(link.expiresAt)}. Revoke it on Releases, under Review links, when the review is done.</li>
          <li>Links stay in browser history and in chats. Anyone who has it can open it until it expires or is revoked. Send it only to the people who should review.</li>
        </ul>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ the list on Releases */

const STATUS: Record<ReviewLinkDto['status'], { label: string; cls: string }> = { active: { label: 'Active', cls: 'accent' }, expired: { label: 'Expired', cls: '' }, revoked: { label: 'Revoked', cls: 'warning' } };

export function ReviewLinksPanel({ projectId }: { projectId: string }) {
  const rev = useReviewLinksRev((s) => s.rev);
  const records = useStudio((s) => s.records);
  const [data, setData] = useState<{ links: ReviewLinkDto[]; active: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let live = true;
    reviewLinksApi.list(projectId).then((d) => { if (live) { setData(d); setError(null); } }, (e) => live && setError(e instanceof ApiFailure ? e.message : 'The review links could not be loaded.'));
    return () => { live = false; };
  }, [projectId, rev]);
  const names = useMemo(() => new Map(records.map((r) => [r.recordId, `${r.customer.givenName} ${r.customer.familyName}`.trim()])), [records]);
  // Overview links here as …/releases#review-links.
  const loaded = !!data;
  useEffect(() => { if (loaded && window.location.hash === '#review-links') document.getElementById('review-links')?.scrollIntoView({ block: 'start' }); }, [loaded]);

  const revoke = async (l: ReviewLinkDto) => {
    if (!window.confirm(`Revoke “${l.label}”? Anyone who has the link will no longer be able to open it.`)) return;
    setBusy(l.id);
    try {
      await reviewLinksApi.revoke(projectId, l.id);
      useStudio.getState().toast({ kind: 'success', title: 'Review link revoked', message: `“${l.label}” no longer opens.` });
      useReviewLinksRev.getState().bump();
    } catch (e) {
      useStudio.getState().toast({ kind: 'error', title: 'The link was not revoked', message: e instanceof ApiFailure ? e.message : 'That did not work.' });
    } finally { setBusy(null); }
  };

  const shown = (data?.links ?? []).filter((l) => showAll || l.status === 'active');
  const inactive = (data?.links.length ?? 0) - (data?.active ?? 0);
  return (
    <section className="panel rl-panel" id="review-links" aria-labelledby="rl-panel-h" data-testid="review-links-panel">
      <div className="panel-head">
        <h2 className="section-title" id="rl-panel-h">Review links {data && <span className="chip count" data-testid="review-links-active">{data.active} active</span>}</h2>
        {inactive > 0 && <div className="right"><label className="rl-showall"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} data-testid="review-links-show-all" /> Show expired and revoked ({inactive})</label></div>}
      </div>
      <p className="muted rl-panel-lead">A review link lets someone without an account look at one version for chosen test customers and comment. Their comments appear in the review panel under “From review links”. Make one with “Share for review” on a release, or on Before &amp; after.</p>
      <div className="panel-body flush">
        {error ? <div className="callout error" role="alert" style={{ margin: 12 }}>{error}</div>
          : !data ? <p className="muted" style={{ padding: 12 }}><span className="spinner" /> Loading…</p>
          : shown.length === 0 ? <p className="muted rl-empty" data-testid="review-links-empty">{data.links.length ? 'No active review links.' : 'No review links yet.'}</p>
          : (
            <div className="rl-table-wrap">
              <table className="table rl-table">
                <thead><tr><th scope="col">Label</th><th scope="col">Version</th><th scope="col">Customers</th><th scope="col">Expires</th><th scope="col" className="num">Opens</th><th scope="col" className="num">Comments</th><th scope="col">Made by</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {shown.map((l) => (
                    <tr key={l.id} data-testid="review-link-row" data-link={l.id} data-status={l.status}>
                      <td className="rl-label"><span title={l.label}>{l.label}</span> {l.status !== 'active' && <span className={`chip ${STATUS[l.status].cls}`}>{STATUS[l.status].label}</span>}</td>
                      <td>{targetWords(l.target)}</td>
                      <td title={l.customers.map((id) => names.get(id) ?? id).join(', ')}>{plural(l.customers.length, 'customer')}</td>
                      <td>{l.status === 'revoked' ? <span className="muted">Revoked{l.revokedBy ? ` by ${l.revokedBy}` : ''}</span> : <time dateTime={l.expiresAt} title={fmtAbs(l.expiresAt)}>{l.status === 'expired' ? 'Expired ' : ''}{new Date(l.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</time>}</td>
                      <td className="num" title={l.lastOpenedAt ? `Last opened ${fmtAbs(l.lastOpenedAt)}` : 'Not opened yet'}>{l.opens}</td>
                      <td className="num">{l.comments}</td>
                      <td>{l.createdBy?.name ?? '—'}</td>
                      <td className="rl-act">{l.status === 'active' && (l.mayRevoke
                        ? <button type="button" className="btn sm danger" onClick={() => revoke(l)} disabled={busy === l.id} data-testid="review-link-revoke">{busy === l.id ? 'Revoking…' : 'Revoke'}</button>
                        : <span className="muted" title="Only the person who made it, an approver or an admin can revoke it.">—</span>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ the line on Overview */

export function ReviewLinksGlance({ projectId }: { projectId: string }) {
  const rev = useReviewLinksRev((s) => s.rev);
  const [active, setActive] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    reviewLinksApi.list(projectId).then((d) => { if (live) { setActive(d.active); setFailed(false); } }, () => live && setFailed(true));
    return () => { live = false; };
  }, [projectId, rev]);
  return (
    <div><dt>Review links</dt><dd data-testid="glance-review-links">
      {failed ? <span className="muted">Could not be loaded</span> : active === null ? <span className="muted">Loading…</span>
        : <>{active === 0 ? 'No review links active' : `${plural(active, 'review link')} active`} · <Link to={`/studio/${projectId}/releases#review-links`} data-testid="glance-review-links-open">{active === 0 ? 'Share for review' : 'See the list'}</Link></>}
    </dd></div>
  );
}

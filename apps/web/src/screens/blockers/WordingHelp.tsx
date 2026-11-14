import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { SOURCE_LANGUAGE, languageShortName, libraryOwnership, translationStatus, type Project } from '@iss/model';
import { DEBT_LANGUAGE_PATTERN } from '@iss/resolver';
import { checkWording, replaceOccurrences, setTextCommands, wordingTexts, type BlockerLink, type BlockerWithStatus, type WordingText, type WordingTextScope } from '@iss/scenarios';
import { api } from '../../api/client';
import { applyAssistCommands, SourceChip, useAiLive, useBusy } from '../../assist/common';
import { editBlockedReason, useStudio } from '../../state/store';
import { Icon } from '../../ui/icons';
import { wordDiff } from '../compare/wordDiff';

/**
 * Blockers phase 5: help from the assistant for a wording blocker, beside the fixes.
 *  - A missing required translation: "Draft the translation" uses the same helper as Content & Translations (AI with a
 *    key, otherwise the labelled sample drafts written for the built-in examples). The text is stored as a DRAFT, marked
 *    as such, and never approved here: the blocker stays open until a person approves it in Content & Translations.
 *  - Wording a "must" rule forbids (and the studio's own "reads as a demand for money" check): "Suggest wording that
 *    follows the rules" (the wave 2 helper) shows the text before and after with the changed words marked; a person uses
 *    it as ONE undoable step. Without a key the rule's own replacement is offered the same way. Required disclosure text
 *    is never rewritten by the assistant.
 * Only the document's own wording is sent to a model, never a customer's data (assistant policy, D65).
 */

const REWRITE = new Set(['WORDING_BANNED', 'WORDING_PREFERRED', 'WORDING_READING_LEVEL', 'WORDING_SENTENCE_LENGTH', 'WORDING_TONE', 'UNCONFIRMED_DEBT_LANGUAGE']);
const DEMAND = new RegExp(DEBT_LANGUAGE_PATTERN, 'i');

/** Which help applies to a blocker, or null. */
export function wordingHelpKind(b: Pick<BlockerWithStatus, 'code' | 'finding'>): 'translation' | 'rewrite' | null {
  if (b.code === 'REQUIRED_TRANSLATION_MISSING' && b.finding.nodeId && b.finding.locale) return 'translation';
  if (REWRITE.has(b.code)) return 'rewrite';
  return null;
}

export function WordingHelp({ blocker, onOpen, compact }: { blocker: BlockerWithStatus; onOpen: (link?: BlockerLink | null) => void; /** In the guided pass: smaller headings. */ compact?: boolean }) {
  const kind = wordingHelpKind(blocker);
  if (!kind) return null;
  const H = compact ? 'h4' : 'h3';
  return (
    <section className="bl-assist" data-testid="bl-assist" data-kind={kind} aria-label="Help from the assistant">
      <H className="section-title">{kind === 'translation' ? 'Draft the translation' : 'Suggest wording that follows the rules'}</H>
      {kind === 'translation' ? <DraftTranslation blocker={blocker} /> : <SuggestWording blocker={blocker} onOpen={onOpen} />}
    </section>
  );
}

/* ------------------------------------------------------------------ a missing required translation */

function DraftTranslation({ blocker }: { blocker: BlockerWithStatus }) {
  const project = useStudio((s) => s.project)!;
  const session = useStudio((s) => s.session);
  const live = useAiLive();
  const ro = editBlockedReason(session);
  const [busy, run] = useBusy();
  const [reply, setReply] = useState<{ mode: 'ai' | 'sample' | 'unavailable'; message: string; saved: boolean } | null>(null);
  const partId = blocker.finding.nodeId!;
  const locale = blocker.finding.locale!;
  const lang = languageShortName(locale);
  const row = useMemo(() => translationStatus(project, locale).rows.find((r) => r.partId === partId) ?? null, [project, locale, partId]);
  const linked = useMemo(() => (project.libraryLinks?.length ? libraryOwnership(project).textOf(partId) : null), [project, partId]);
  const draft = row?.status.draftText?.trim() ? row.status.draftText : null;
  const contentPath = `/studio/${project.projectId}/content?lang=${encodeURIComponent(locale)}&text=${encodeURIComponent(partId)}`;

  const go = async () => {
    const r = await run(() => api.translate(project.projectId, { locale, ids: [partId], project }));
    if (!r) return;
    const mine = r.drafts.find((d) => d.id === partId);
    if (r.mode === 'unavailable' || !mine) { setReply({ mode: 'unavailable', message: r.skipped.find((s) => s.id === partId)?.reason ?? r.message, saved: false }); return; }
    // Stored as a draft, marked with where it came from, as ONE undoable step. Never approved here.
    const ok = applyAssistCommands([{ type: 'SET_TRANSLATION_DRAFTS', locale, items: [{ id: partId, text: mine.text }], origin: r.mode }], `Draft the ${lang} text of “${row?.title ?? partId}”`, 'translate', r.mode === 'ai' ? 'ai' : 'builtin');
    setReply({ mode: r.mode, message: r.message, saved: ok });
  };

  return (
    <>
      {live === false && <p className="hint bl-assist-nokey" data-testid="bl-assist-nokey">No AI key is set, so an AI draft is not available. For the built-in examples the studio offers the labelled sample draft written for them instead.</p>}
      {linked ? (
        <p className="hint" data-testid="bl-draft-library">This text comes from the library (“{linked.title}”, version {linked.version}): its translation is drafted and approved there.</p>
      ) : (
        <>
          {draft && (
            <div className="bl-draft-now" data-testid="bl-draft-current">
              <p className="bl-draft-label"><span className="chip warning">Draft, not approved</span>{row?.origin && <SourceChip source={row.origin === 'ai' ? 'ai' : 'sample'} />} <span className="muted">The {lang} text waiting for a person:</span></p>
              <p className="bl-draft-text" lang={locale}>{draft}</p>
            </div>
          )}
          <div className="row wrap">
            <button type="button" className={`btn ${draft ? '' : 'primary'} sm`} onClick={() => void go()} disabled={busy || !!ro} title={ro ?? `Write a first ${lang} draft of “${row?.title ?? partId}”`} aria-busy={busy} data-testid="bl-draft-translation">
              <Icon.ai width={13} height={13} /> {busy ? 'Drafting…' : draft ? 'Draft it again' : 'Draft the translation'}
            </button>
            <Link className="btn sm" to={contentPath} data-testid="bl-draft-open-content"><Icon.external width={13} height={13} /> Review and approve in Content &amp; Translations</Link>
          </div>
          {ro && <p className="hint">{ro}.</p>}
        </>
      )}
      {reply && (reply.mode === 'unavailable' || !reply.saved ? (
        <p className="callout warning bl-draft-result" role="status" data-testid="bl-draft-result" data-mode="unavailable">{reply.message}</p>
      ) : (
        <div className="callout accent bl-draft-result" role="status" data-testid="bl-draft-result" data-mode={reply.mode}>
          <p><strong>Saved as a draft, not approved.</strong> <SourceChip source={reply.mode === 'ai' ? 'ai' : 'sample'} /> {reply.mode === 'ai' ? 'An AI model wrote it from the English text alone.' : 'It was written for this example and has not been reviewed by a translator.'}</p>
          <p data-testid="bl-draft-stays-open">This blocker stays open until a person reviews and approves the {lang} text in Content &amp; Translations. Undo is in the top bar.</p>
        </div>
      ))}
      <p className="hint bl-assist-policy">Only the document’s own English text is sent, never a customer’s data.</p>
    </>
  );
}

/* ------------------------------------------------------------------ wording a "must" rule forbids */

/** The text a wording blocker is about, as the checker sees it, or why the assistant cannot rewrite it. */
function textOf(project: Project, b: BlockerWithStatus): { text: WordingText; tone: boolean } | { reason: 'disclosure' | 'library' | 'missing'; title?: string } {
  const f = b.finding;
  let t: WordingText | undefined;
  let tone = false;
  if (b.code === 'UNCONFIRMED_DEBT_LANGUAGE') {
    tone = true;
    t = wordingTexts(project, [SOURCE_LANGUAGE]).find((x) => x.nodeId === f.nodeId && DEMAND.test(x.text));
  } else {
    const id = typeof f.details?.textId === 'string' ? f.details.textId : null;
    const locale = f.locale ?? SOURCE_LANGUAGE;
    if (id) t = wordingTexts(project, [locale]).find((x) => x.id === id && x.locale === locale);
  }
  if (!t) return { reason: 'missing' };
  const part = t.partId ? project.contentParts.find((c) => c.id === t!.partId) : undefined;
  if (t.scope === 'disclosures' || part?.type === 'disclosure' || project.nodes.some((n) => n.type === 'disclosure' && n.id === t!.nodeId)) return { reason: 'disclosure', title: t.title };
  if (t.linked) return { reason: 'library', title: t.linked.title };
  return { text: t, tone };
}

function SuggestWording({ blocker, onOpen }: { blocker: BlockerWithStatus; onOpen: (link?: BlockerLink | null) => void }) {
  const project = useStudio((s) => s.project)!;
  const session = useStudio((s) => s.session);
  const live = useAiLive();
  const ro = editBlockedReason(session);
  const [busy, run] = useBusy();
  const [ai, setAi] = useState<{ before: string; options: Array<{ text: string; warnings: string[] }>; message: string; mode: 'ai' | 'unavailable' } | null>(null);
  const [used, setUsed] = useState(false);
  const found = useMemo(() => textOf(project, blocker), [project, blocker]);

  if ('reason' in found) {
    if (found.reason === 'disclosure') {
      return (
        <div className="callout bl-assist-disclosure" data-testid="bl-wording-disclosure">
          <p><strong>“{found.title}” is required disclosure text.</strong> The assistant never rewrites a required disclosure: a person changes it with “New approved version” and a reason.</p>
          <button type="button" className="btn sm" onClick={() => onOpen(blocker.link)} data-testid="bl-wording-open-disclosure"><Icon.external width={13} height={13} /> {blocker.link?.label ?? 'Open the disclosure'}</button>
        </div>
      );
    }
    if (found.reason === 'library') return <p className="hint" data-testid="bl-wording-library">This text comes from the library (“{found.title}”): reword it there.</p>;
    return <p className="hint">The text this is about is no longer in the document as it was checked. Open where it is fixed.</p>;
  }
  const t = found.text;
  // The rule's own replacement, built in: the same change as the fix above, shown as a before and after.
  const builtin = (() => {
    const id = typeof blocker.finding.details?.findingId === 'string' ? blocker.finding.details.findingId : null;
    if (!id || !blocker.finding.details?.replacement) return null;
    const f = checkWording(project).findings.find((x) => x.id === id);
    if (!f?.replacement || !f.occurrences.length) return null;
    const after = replaceOccurrences(t.text, f.occurrences, f.replacement);
    return after !== t.text ? after : null;
  })();
  const translation = t.locale !== SOURCE_LANGUAGE;

  const suggest = async () => {
    setUsed(false);
    const r = await run(() => api.assistCompliant(project.projectId, { text: t.text, scope: t.scope as WordingTextScope, locale: t.locale, project, ...(found.tone ? { tone: true } : {}) }));
    if (r) setAi({ before: t.text, options: r.options.filter((o) => o.tokenCheck.ok).map((o) => ({ text: o.text, warnings: o.warnings })), message: r.message, mode: r.mode });
  };
  const use = (after: string, source: 'ai' | 'builtin') => {
    const r = setTextCommands(project, [{ textId: t.id, locale: t.locale, text: after }]);
    if ('reason' in r) { useStudio.getState().toast({ kind: 'error', title: 'Not changed', message: r.reason }); return; }
    if (applyAssistCommands(r.commands, `Reword “${t.title}” to follow the wording rules`, 'wording', source)) { setUsed(true); setAi(null); }
  };

  return (
    <>
      <p className="hint">“{t.title}”{translation ? ` (${languageShortName(t.locale)})` : ''} is shown below as it is now and as suggested, with the words that change marked. Using a suggestion is one step you can undo{translation ? '; a translation becomes a draft for a person to approve' : ''}.</p>
      {live === false && <p className="hint bl-assist-nokey" data-testid="bl-assist-nokey">No AI key is set, so AI wording suggestions are not available.{builtin ? ' The rule’s own replacement is offered instead.' : ' Reword it by hand where it is fixed.'}</p>}
      {live && !ai && (
        <div className="row wrap">
          <button type="button" className="btn primary sm" onClick={() => void suggest()} disabled={busy || !!ro} aria-busy={busy} title={ro ?? undefined} data-testid="bl-suggest-wording"><Icon.ai width={13} height={13} /> {busy ? 'Asking…' : 'Suggest wording that follows the rules'}</button>
        </div>
      )}
      {ai && ai.mode === 'unavailable' && <p className="callout warning" role="status" data-testid="bl-wording-refused">{ai.message}</p>}
      {ai && ai.mode === 'ai' && ai.options.slice(0, 3).map((o, i) => (
        <BeforeAfter key={i} before={ai.before} after={o.text} source="ai" note={`Checked against the wording rules: it breaks no “must” rule.${o.warnings.length ? ` Still a warning: ${o.warnings.join('; ')}.` : ''}`} blockedReason={ro} onUse={() => use(o.text, 'ai')} testId={`bl-wording-ai-${i}`} />
      ))}
      {builtin && !used && (live === false || (ai && (ai.mode === 'unavailable' || !ai.options.length))) && (
        <BeforeAfter before={t.text} after={builtin} source="builtin" note="The replacement the wording rule itself gives. Read the sentence before using it." blockedReason={ro} onUse={() => use(builtin, 'builtin')} testId="bl-wording-builtin" />
      )}
      {used && <p className="callout accent" role="status" data-testid="bl-wording-used">The wording was changed as one step. Undo is in the top bar.{translation ? ' The translation is now a draft: a person approves it in Content & Translations.' : ''}</p>}
      <p className="hint bl-assist-policy">Only this text and the wording rules are sent, never a customer’s data.</p>
    </>
  );
}

/** The text now and as suggested, side by side, with the words that change marked (not by colour alone: struck and underlined). */
function BeforeAfter({ before, after, source, note, blockedReason, onUse, testId }: { before: string; after: string; source: 'ai' | 'builtin'; note: string; blockedReason: string | null; onUse: () => void; testId: string }) {
  const d = useMemo(() => wordDiff(before, after), [before, after]);
  return (
    <div className="bl-ba" data-testid={testId} data-changed={d.changedWords}>
      <div className="bl-ba-col">
        <span className="bl-ba-lbl">Now</span>
        <p data-testid="bl-ba-before">{d.before.map((p, i) => (p.changed ? <del key={i} className="bl-del">{p.text}</del> : <span key={i}>{p.text}</span>))}</p>
      </div>
      <div className="bl-ba-col new">
        <span className="bl-ba-lbl">Suggested <SourceChip source={source} /></span>
        <p data-testid="bl-ba-after">{d.after.map((p, i) => (p.changed ? <ins key={i} className="bl-ins">{p.text}</ins> : <span key={i}>{p.text}</span>))}</p>
      </div>
      <p className="muted bl-ba-note">{d.changedWords} {d.changedWords === 1 ? 'word changes' : 'words change'}. {note}</p>
      <div className="row wrap">
        <button type="button" className="btn primary sm" onClick={onUse} disabled={!!blockedReason} title={blockedReason ?? undefined} data-testid="bl-wording-use">Use this wording</button>
      </div>
    </div>
  );
}

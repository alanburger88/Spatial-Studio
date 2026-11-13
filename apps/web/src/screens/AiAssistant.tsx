import type { Project } from '@iss/model';
import { ScreenHeader } from '../ui/common';
import { Icon } from '../ui/icons';
import { useStudio } from '../state/store';
import { Conversation, pickPrompt, useConv, useConversation } from '../assist/Conversation';
import './AiAssistant.css';

const PROMPT_GROUPS: Record<string, Array<{ title: string; prompts: string[] }>> = {
  'credit-statement': [
    { title: 'Scenario', prompts: ['Choose assistance case CARD-0002', 'Show me a Spanish-speaking cardholder who has missed two payments and requests assistance', 'Show Spanish edge case', 'Compare CARD-0001 and CARD-0002'] },
    { title: 'Explain', prompts: ['Why is this message showing?', 'What rules apply?', 'Explain the selected variant'] },
    { title: 'Edit (needs approval)', prompts: ['Change R04 priority to 420', 'Disable R04'] },
    { title: 'Navigate', prompts: ['Run validation', 'Open cube', 'Export PDF', 'Switch to EOB'] },
  ],
  eob: [
    { title: 'Scenario', prompts: ['Choose case EOB-0002', 'Show me a claim that was denied pending review', 'Show claim appeal edge case', 'Compare EOB-0001 and EOB-0002'] },
    { title: 'Explain', prompts: ['Why is this message showing?', 'What rules apply?', 'Explain the selected variant'] },
    { title: 'Navigate', prompts: ['Run validation', 'Open cube', 'Export PDF', 'Switch to Aster Card'] },
  ],
};

/** What a document with its own data can be asked: only questions about its own messages, rules and views, never a card or claim sample. */
function ownPrompts(project: Project): Array<{ title: string; prompts: string[] }> {
  const rule = project.rules.find((r) => r.mode !== 'obligation' && r.enabled !== false);
  const hasMessage = project.nodes.some((n) => n.type === 'variant-set' || n.type === 'conditional-region');
  return [
    { title: 'Explain', prompts: [...(hasMessage ? ['Why is this message showing?'] : []), 'What rules apply?'] },
    ...(rule ? [{ title: 'Edit (needs approval)', prompts: [`Change ${rule.id} priority to ${Math.min(10000, rule.priority + 20)}`] }] : []),
    { title: 'Navigate', prompts: ['Run validation', 'Open cube', 'Open landscape', 'Translate this document', 'Edit the email wording'] },
  ];
}

/* ------------------------------------------------------------------ screen */

export function AiAssistant() {
  const ctx = useStudio((s) => s.ctx);
  const { project, mode, modeLabel, status, statusError, forceOffline, turns } = useConversation();
  const lastReply = [...turns].reverse().find((t) => t.kind === 'assistant');
  const providerStatus = lastReply && lastReply.kind === 'assistant' ? lastReply.reply.providerStatus : undefined;

  return (
    <section className="screen" data-testid="assistant-view">
      <ScreenHeader id="S12" title="AI Assistant" subtitle="Describe a scenario or ask why. The assistant proposes typed, validated actions; the deterministic engine does the work and nothing changes without your approval."
        badge={<span className={`chip ${mode === 'external' ? 'accent' : 'warning'} ai-badge`} data-testid="ai-mode" title={providerStatus ?? status?.label}>{mode === 'external' ? <Icon.ai width={14} height={14} /> : <Icon.rules width={14} height={14} />} {modeLabel}</span>} />
      <div className="screen-body ai-body">
        <div className="panel ai-thread-panel">
          <div className="panel-head"><Icon.ai /> Conversation</div>
          <Conversation />
        </div>
        <aside className="ai-side" data-side="right" data-side-title="Prompts &amp; provider">
          <div className="panel">
            <div className="panel-head">Provider</div>
            <div className="panel-body">
              <dl className="kv">
                <dt>Mode</dt><dd>{modeLabel}</dd>
                {status?.model && mode === 'external' && <><dt>Model</dt><dd>{status.model}</dd></>}
                <dt>Scenario</dt><dd className="mono">{ctx.recordId}</dd>
              </dl>
              {statusError && <div className="callout error" role="alert" style={{ marginTop: 8 }}>Status unavailable: {statusError}</div>}
              <div className="ai-live-how">
                <strong>{mode === 'external' ? 'Live mode is on' : 'Enable live mode'}</strong>
                {mode === 'external'
                  ? <p className="muted">Questions go to the server-side adapter; every action it returns is re-validated against the typed allowlist.</p>
                  : <p className="muted">Offline is the default and always works. For free-form questions, put <span className="mono">AI_PROVIDER=anthropic</span> and <span className="mono">AI_API_KEY=…</span> (optionally <span className="mono">AI_MODEL</span>) in a local, uncommitted <span className="mono">.env</span> or the API environment, then restart the API. The key stays on the server and never reaches the browser.</p>}
              </div>
              <label className="ai-toggle"><input type="checkbox" checked={forceOffline} onChange={(e) => useConv.setState({ forceOffline: e.target.checked })} data-testid="force-offline" /> <span><strong>Force offline fallback</strong><br /><span className="muted">Demonstrates that the deterministic guided assistant always works, with no outbound calls.</span></span></label>
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">Suggested prompts</div>
            <div className="panel-body ai-chips">
              {(project.documentType === 'custom' ? ownPrompts(project) : PROMPT_GROUPS[project.documentType] ?? PROMPT_GROUPS.eob).map((g) => (
                <div className="ai-chip-group" key={g.title}>
                  <div className="ai-ba-h">{g.title}</div>
                  <div className="ai-chip-wrap">{g.prompts.map((p) => <button key={p} type="button" className="ai-chip" title={p} onClick={() => pickPrompt(p)} data-testid="prompt-chip">{p}</button>)}</div>
                </div>
              ))}
              <p className="hint muted">Choosing a prompt fills the box; press Send to ask.</p>
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">Safety</div>
            <div className="panel-body ai-safety">
              <ul>
                <li>Only allowlisted, typed actions are accepted; anything else is rejected with a reason.</li>
                <li>Explanations come from the deterministic resolver trace, not from the language model.</li>
                <li>Rule and content changes are proposals; approving is one undoable command.</li>
                <li>No real communications are sent.</li>
              </ul>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

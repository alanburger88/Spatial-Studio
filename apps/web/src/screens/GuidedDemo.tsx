import { useNavigate } from 'react-router-dom';
import { DEMO_STEPS, useDemo } from '../demo/demo';
import { ScreenHeader } from '../ui/common';
import { Icon } from '../ui/icons';
import './GuidedDemo.css';

export function GuidedDemo() {
  const navigate = useNavigate();
  const demo = useDemo();
  const nav = (to: string) => navigate(to);
  const done = DEMO_STEPS.filter((s) => demo.results[s.id]).length;
  const passed = DEMO_STEPS.filter((s) => demo.results[s.id]?.ok).length;
  const finished = demo.index >= DEMO_STEPS.length - 1 && done === DEMO_STEPS.length;
  const deterministic = demo.previousRun && finished
    ? DEMO_STEPS.every((s) => (demo.previousRun![s.id]?.digest ?? null) === (demo.results[s.id]?.digest ?? null))
    : null;
  return (
    <section className="screen" data-testid="demo-view">
      <ScreenHeader id="S11" title="Guided Demo" subtitle="An eight-minute stakeholder narrative. Every step performs real commands, scenario changes and exports, then verifies a checkpoint against live state."
        badge={<span className="chip info">Offline-safe · AI optional</span>}
        actions={<>
          <button className="btn primary" onClick={() => demo.start(nav)} disabled={demo.running} data-testid="start-demo"><Icon.demo /> {demo.runs ? 'Restart demo' : 'Start guided demo'}</button>
          <button className="btn" onClick={() => demo.next(nav)} disabled={demo.running || demo.index >= DEMO_STEPS.length - 1 || demo.index < 0} data-testid="next-demo-step">Next step <Icon.chevron /></button>
          <button className="btn ghost" onClick={() => demo.reset(nav)} disabled={demo.running} data-testid="reset-demo"><Icon.reset /> Reset demo</button>
        </>}
      />
      <div className="screen-body demo-grid">
        <div className="panel">
          <div className="panel-head">Chapters <span className="sub">{done}/{DEMO_STEPS.length} run · {passed} checkpoints passed</span>{demo.running && <span className="right"><span className="spinner" /></span>}</div>
          <div className="panel-body">
            <ol className="demo-steps" data-testid="demo-steps">
              {DEMO_STEPS.map((s, i) => {
                const r = demo.results[s.id];
                const cur = i === demo.index;
                return (
                  <li key={s.id} className={`demo-step${cur ? ' current' : ''}${r ? (r.ok ? ' ok' : ' fail') : ''}`} data-testid={`demo-step-${s.id}`} aria-current={cur ? 'step' : undefined}>
                    <div className="demo-time">{s.time}</div>
                    <div className="grow">
                      <div className="demo-chapter">{s.chapter}</div>
                      <div className="demo-title">{s.title}</div>
                      <p className="demo-narr">{s.narration}</p>
                      <div className="demo-proof"><strong>Proof:</strong> {s.proof}</div>
                      {r && <div className={`demo-check ${r.ok ? 'ok' : 'fail'}`} data-testid={`checkpoint-${s.id}`}>{r.ok ? '✓ Checkpoint passed' : '✗ Checkpoint failed'} — {r.detail}{r.digest && <span className="mono"> · {r.digest.slice(0, 12)}</span>}</div>}
                    </div>
                    <button className="btn sm" disabled={demo.running || demo.index < 0} onClick={() => demo.runStep(i, nav)} aria-label={`Run step ${i + 1}: ${s.title}`}>Run</button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
        <aside className="panel">
          <div className="panel-head">Presenter notes</div>
          <div className="panel-body">
            <div className="kv">
              <dt>Status</dt><dd data-testid="demo-status">{demo.running ? 'Running step…' : demo.index < 0 ? 'Ready' : finished ? 'Complete' : `Step ${demo.index + 1} of ${DEMO_STEPS.length}`}</dd>
              <dt>Runs this session</dt><dd>{demo.runs}</dd>
              <dt>Checkpoints</dt><dd>{passed}/{done}</dd>
              <dt>Deterministic replay</dt><dd data-testid="demo-deterministic">{deterministic === null ? 'Run twice to compare' : deterministic ? 'Identical digests ✓' : 'Digests differ ✗'}</dd>
            </div>
            <div className="section-title">Guardrails</div>
            <ul className="gal-list">
              <li>Start resets both projects to the approved samples — no stale state.</li>
              <li>The banner follows you across screens; “Explore freely” hides it without losing your place.</li>
              <li>Live AI is optional; the labelled offline assistant answers from the engine trace.</li>
              <li>If an export fails, stop and report — never substitute a saved file.</li>
              <li>AFP is always presented as a simulation.</li>
            </ul>
            <div className="section-title">Keyboard</div>
            <p className="muted" style={{ fontSize: 12.5 }}>Alt+1…9 jumps between views. In the banner: Next, Pause and Explore are buttons; Esc does nothing destructive.</p>
          </div>
        </aside>
      </div>
    </section>
  );
}

export function DemoBanner() {
  const navigate = useNavigate();
  const demo = useDemo();
  if (!demo.active || demo.bannerHidden || demo.index < 0) {
    if (demo.active && demo.bannerHidden) return <button className="demo-resume btn primary" onClick={() => demo.setBannerHidden(false)}><Icon.demo /> Resume guided demo</button>;
    return null;
  }
  const step = DEMO_STEPS[Math.min(demo.index, DEMO_STEPS.length - 1)];
  const r = demo.results[step.id];
  const last = demo.index >= DEMO_STEPS.length - 1;
  return (
    <div className="demo-banner" role="region" aria-label="Guided demo narration" data-testid="demo-banner">
      <div className="demo-banner-step">{demo.index + 1}/{DEMO_STEPS.length}</div>
      <div className="grow">
        <div className="demo-banner-title">{step.chapter} · {step.title}</div>
        <div className="demo-banner-text">{step.narration}</div>
        {r && <div className={`demo-check ${r.ok ? 'ok' : 'fail'}`}>{r.ok ? '✓' : '✗'} {r.detail}</div>}
      </div>
      <div className="demo-banner-actions">
        <button className="btn sm" onClick={() => demo.setPaused(!demo.paused)} aria-pressed={demo.paused}>{demo.paused ? 'Resume' : 'Pause'}</button>
        <button className="btn sm ghost" onClick={() => demo.setBannerHidden(true)}>Explore freely</button>
        <button className="btn sm primary" disabled={demo.running || demo.paused} onClick={() => (last ? navigate(`/studio/aster-card-demo/demo`) : demo.next((to) => navigate(to)))} data-testid="banner-next">{demo.running ? 'Running…' : last ? 'Finish' : 'Next'}</button>
      </div>
    </div>
  );
}

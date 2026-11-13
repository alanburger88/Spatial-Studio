import { useCallback, useEffect, useState } from 'react';
import { RELEASE_PACKAGE_STATE_LABEL, runtimePackageName, type ReleaseInfo, type RuntimePackageStatus } from '@iss/model';
import { ApiFailure, api } from '../../api/client';
import { Tech } from '../../ui/common';
import { Icon } from '../../ui/icons';
import { fmtAbs } from '../../shell/History';
import { PACKAGE_CHIP, fmtBytes, plural } from './format';

const COMMANDS = ['node verify', 'node run --data customers.jsonl --outputs pdf,html,email,sms --out out', 'node serve --port 8787'];

/**
 * The runnable package (phase 7): the release with the studio's own engine, for a system that produces the documents
 * itself. Prepared on request like the release package (it includes it), kept once built, checked by building again.
 */
export function RuntimeSection({ release, onChanged }: { release: ReleaseInfo; onChanged?: () => void }) {
  const empty: RuntimePackageStatus = { status: 'not-built', fileName: runtimePackageName(release.documentId, release.number), sha256: null, bytes: null, files: null, builtAt: null, progress: null, error: null, verified: null, engine: null, proofCases: null };
  const [rt, setRt] = useState<RuntimePackageStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setRt((await api.runtimeStatus(release.id)).runtime); } catch (e) { setError(e instanceof ApiFailure ? e.message : 'The state of the runnable package could not be read.'); }
  }, [release.id]);
  useEffect(() => { setRt(null); setError(null); void load(); }, [load]);
  const cur = rt ?? empty;
  const working = cur.status === 'building' || !!cur.progress;

  // The build runs in the background on the server: ask how far it is until it ends.
  useEffect(() => {
    if (!working) return;
    let stop = false;
    const t = window.setInterval(async () => {
      try {
        const r = await api.runtimeStatus(release.id);
        if (stop) return;
        setRt(r.runtime);
        // It may have prepared the release package too: let the detail show that.
        if (r.runtime.status !== 'building' && !r.runtime.progress) onChanged?.();
      } catch { /* try again on the next tick */ }
    }, 1000);
    return () => { stop = true; window.clearInterval(t); };
  }, [working, release.id, onChanged]);

  const start = async (verify: boolean) => {
    setStarting(true); setError(null);
    try { setRt((await api.prepareRuntime(release.id, verify ? { verify: true } : {})).runtime); } catch (e) { setError(e instanceof ApiFailure ? e.message : 'The runnable package could not be prepared.'); } finally { setStarting(false); }
  };
  const chip = PACKAGE_CHIP[cur.status];
  const pct = cur.progress && cur.progress.total > 0 ? Math.round((cur.progress.done / cur.progress.total) * 100) : null;
  return (
    <section className="rel-section" aria-labelledby="rel-runtime-h" data-testid="rel-runtime" data-status={rt ? cur.status : 'loading'} aria-busy={working || !rt}>
      <h3 className="section-title" id="rel-runtime-h">Runnable package</h3>
      <p className="muted rel-hint">This release together with the studio’s own engine, so another system can produce the PDF, web page, email and SMS itself from customer data, exactly as approved. It runs on the operator’s own machine with no outbound connection, and its proof pack checks that machine before go-live.</p>
      <div className="rel-pkg-status">
        <span className={`chip ${chip.cls}`} data-testid="rel-runtime-status">{rt ? RELEASE_PACKAGE_STATE_LABEL[cur.status] : 'Checking…'}</span>
        {cur.status === 'ready' && <span data-testid="rel-runtime-size">{fmtBytes(cur.bytes)} · {plural(cur.files ?? 0, 'file')}{cur.proofCases ? ` · ${plural(cur.proofCases, 'synthetic proof case')}` : ''}</span>}
        {cur.status === 'ready' && cur.sha256 && <span className="muted" data-testid="rel-runtime-fingerprint" title={`SHA-256 ${cur.sha256}`}>fingerprint <span className="mono">{cur.sha256.slice(0, 12)}…</span></span>}
        {cur.status === 'ready' && cur.builtAt && <span className="muted">prepared {fmtAbs(cur.builtAt)}</span>}
      </div>

      {working && (
        <div className="rel-progress" role="status" aria-live="polite" data-testid="rel-runtime-busy">
          <span className="spinner" aria-hidden="true" />
          <div className="rel-progress-text">
            <strong>{cur.status === 'ready' ? 'Checking the runnable package…' : 'Building the runnable package…'}</strong>
            <span className="muted" data-testid="rel-runtime-step">{cur.progress ? `${cur.progress.step}${cur.progress.total > 1 ? ` (${Math.min(cur.progress.done + 1, cur.progress.total)} of ${cur.progress.total})` : ''}` : 'Starting…'}</span>
            <progress max={100} value={pct ?? undefined} aria-label="Runnable package progress" />
          </div>
        </div>
      )}
      {cur.status === 'failed' && <div className="callout error" role="alert" data-testid="rel-runtime-error"><strong>The runnable package could not be built.</strong> {cur.error ?? 'No reason was given.'}</div>}
      {error && <div className="callout error" role="alert">{error}</div>}

      <div className="rel-action-row">
        {rt && cur.status !== 'ready' && (
          <button type="button" className="btn" data-testid="rel-runtime-prepare" disabled={starting || working} onClick={() => start(false)}>
            {starting || working ? <><span className="spinner" aria-hidden="true" /> Preparing…</> : cur.status === 'failed' ? 'Try preparing it again' : 'Prepare the runnable package'}
          </button>
        )}
        {cur.status === 'ready' && (
          <>
            <a className="btn" href={api.runtimeDownloadUrl(release.id)} download={cur.fileName} data-testid="rel-runtime-download"><Icon.download /> Download runnable package</a>
            <button type="button" className="btn" data-testid="rel-runtime-verify" disabled={starting || working} onClick={() => start(true)} title="Builds it again and compares it with the kept one. The kept package is never replaced.">Check it again</button>
          </>
        )}
      </div>
      {cur.status === 'ready' && (
        <>
          <div data-testid="rel-runtime-commands">
            <p className="rel-hint">Unpack it, then in its folder (README.html explains each step):</p>
            <pre className="code"><code>{COMMANDS.join('\n')}</code></pre>
          </div>
          <Tech>
            <dl className="kv rel-kv rel-tech" data-testid="rel-runtime-tech">
              <dt>File name</dt><dd className="mono">{cur.fileName}</dd>
              <dt>Size</dt><dd className="mono">{cur.bytes} bytes</dd>
              <dt>SHA-256</dt><dd className="mono" title={cur.sha256 ?? undefined}>{cur.sha256}</dd>
              {cur.engine && <><dt>Engine</dt><dd className="mono">{cur.engine.version} · {cur.engine.sha256}</dd></>}
            </dl>
          </Tech>
          {cur.verified && (
            <p className={`rel-verified${cur.verified.same ? '' : ' bad'}`} data-testid="rel-runtime-verified" role="status">
              {cur.verified.error ? `Checked ${fmtAbs(cur.verified.at)}: it could not be built again (${cur.verified.error}).` : cur.verified.same ? `Checked ${fmtAbs(cur.verified.at)}: building it again gives exactly the same package.` : `Checked ${fmtAbs(cur.verified.at)}: building it again gives a different package. The kept package is unchanged.`}
            </p>
          )}
        </>
      )}
    </section>
  );
}

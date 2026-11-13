import { useEffect, useState } from 'react';
import { RELEASE_PACKAGE_STATE_LABEL, type ReleaseInfo, type ReleasePackageStatus } from '@iss/model';
import { ApiFailure, api } from '../../api/client';
import { useStudio } from '../../state/store';
import { Tech } from '../../ui/common';
import { Icon } from '../../ui/icons';
import { fmtAbs } from '../../shell/History';
import { PACKAGE_CHIP, fmtBytes, plural } from './format';
import { PackageContents } from './PackageContents';

/** The package for the receiving team: not built, being built (composing PDFs takes a while), ready, or failed. */
export function PackageSection({ release, onChanged }: { release: ReleaseInfo; onChanged: () => void }) {
  const [pkg, setPkg] = useState<ReleasePackageStatus>(release.package);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setPkg(release.package); }, [release.id, release.package]);
  const working = pkg.status === 'building' || !!pkg.progress;

  // The build runs in the background on the server: ask how far it is until it ends.
  useEffect(() => {
    if (!working) return;
    let stop = false;
    const t = window.setInterval(async () => {
      try {
        const r = await api.packageStatus(release.id);
        if (stop) return;
        setPkg(r.package);
        if (r.package.status !== 'building' && !r.package.progress) onChanged();
      } catch { /* try again on the next tick */ }
    }, 1000);
    return () => { stop = true; window.clearInterval(t); };
  }, [working, release.id, onChanged]);

  const start = async (verify: boolean) => {
    setStarting(true); setError(null);
    try {
      const r = await api.preparePackage(release.id, verify ? { verify: true } : {});
      setPkg(r.package);
      if (r.package.status !== 'building' && !r.package.progress) onChanged();
    } catch (e) { setError(e instanceof ApiFailure ? e.message : 'The package could not be prepared.'); } finally { setStarting(false); }
  };
  const chip = PACKAGE_CHIP[pkg.status];
  const pct = pkg.progress && pkg.progress.total > 0 ? Math.round((pkg.progress.done / pkg.progress.total) * 100) : null;
  return (
    <section className="rel-section" aria-labelledby="rel-package-h" data-testid="rel-package" data-status={pkg.status} aria-busy={working}>
      <h3 className="section-title" id="rel-package-h">Package for the receiving team</h3>
      <p className="muted rel-hint">One file with the template, the wording in every language, the data dictionary, test scenarios and reference outputs. It holds no customer data.</p>
      <div className="rel-pkg-status">
        <span className={`chip ${chip.cls}`} data-testid="rel-package-status">{RELEASE_PACKAGE_STATE_LABEL[pkg.status]}</span>
        {pkg.status === 'ready' && <span data-testid="rel-package-size">{fmtBytes(pkg.bytes)} · {plural(pkg.files ?? 0, 'file')}</span>}
        {pkg.status === 'ready' && pkg.builtAt && <span className="muted">prepared {fmtAbs(pkg.builtAt)}</span>}
      </div>

      {working && (
        <div className="rel-progress" role="status" aria-live="polite" data-testid="rel-package-busy">
          <span className="spinner" aria-hidden="true" />
          <div className="rel-progress-text">
            <strong>{pkg.status === 'ready' ? 'Checking the package…' : 'Building the package…'}</strong>
            <span className="muted" data-testid="rel-package-step">{pkg.progress ? `${pkg.progress.step}${pkg.progress.total > 1 ? ` (${Math.min(pkg.progress.done + 1, pkg.progress.total)} of ${pkg.progress.total})` : ''}` : 'Starting…'}</span>
            <span className="muted">This composes PDFs and can take a little while. You can keep working: it carries on in the background.</span>
            <progress max={100} value={pct ?? undefined} aria-label="Package progress" />
          </div>
        </div>
      )}
      {pkg.status === 'failed' && <div className="callout error" role="alert" data-testid="rel-package-error"><strong>The package could not be built.</strong> {pkg.error ?? 'No reason was given.'}</div>}
      {error && <div className="callout error" role="alert">{error}</div>}

      <div className="rel-action-row">
        {(pkg.status === 'not-built' || pkg.status === 'failed' || (pkg.status === 'building')) && (
          <button type="button" className="btn primary" data-testid="rel-prepare" disabled={starting || working} onClick={() => start(false)}>
            {starting || working ? <><span className="spinner" aria-hidden="true" /> Preparing…</> : pkg.status === 'failed' ? 'Try preparing again' : 'Prepare the package'}
          </button>
        )}
        {pkg.status === 'ready' && (
          <>
            <a className="btn primary" href={api.packageDownloadUrl(release.id)} download={pkg.fileName} data-testid="rel-download"><Icon.download /> Download package</a>
            <button type="button" className="btn" data-testid="rel-verify" disabled={starting || working} onClick={() => start(true)} title="Builds it again and compares it with the kept package. The kept package is never replaced.">Check it again</button>
          </>
        )}
      </div>
      {pkg.status === 'ready' && (
        <>
          <Tech>
            <dl className="kv rel-kv rel-tech" data-testid="rel-package-tech">
              <dt>File name</dt><dd className="mono">{pkg.fileName}</dd>
              <dt>Size</dt><dd className="mono">{pkg.bytes} bytes</dd>
              <dt>SHA-256</dt><dd className="mono" title={pkg.sha256 ?? undefined}>{pkg.sha256}</dd>
            </dl>
          </Tech>
          {pkg.verified && (
            <p className={`rel-verified${pkg.verified.same ? '' : ' bad'}`} data-testid="rel-package-verified" role="status">
              {pkg.verified.error ? `Checked ${fmtAbs(pkg.verified.at)}: it could not be built again (${pkg.verified.error}).` : pkg.verified.same ? `Checked ${fmtAbs(pkg.verified.at)}: building it again gives exactly the same package.` : `Checked ${fmtAbs(pkg.verified.at)}: building it again gives a different package. The kept package is unchanged.`}
            </p>
          )}
          <PackageContents release={release} pkg={pkg} />
        </>
      )}
    </section>
  );
}

import { useEffect, useMemo, useState } from 'react';
import type { ReleaseInfo, ReleasePackageStatus } from '@iss/model';
import { ApiFailure, api, type ReleaseManifestDto, type ReleasePackageFileDto, type ReleaseScenarioDto } from '../../api/client';
import { Dialog, Loading, Tech } from '../../ui/common';
import { localeLabel } from '../../ui/plain';
import { fileLabel, fmtBytes, plural } from './format';

interface Loaded { files: ReleasePackageFileDto[]; manifest: ReleaseManifestDto | null; scenarios: ReleaseScenarioDto[] }

/** What is inside a ready package, in plain words, with a way to open the README and the reference outputs. */
export function PackageContents({ release, pkg }: { release: ReleaseInfo; pkg: ReleasePackageStatus }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ path: string; title: string } | null>(null);
  useEffect(() => {
    let live = true;
    setData(null); setError(null);
    (async () => {
      try {
        const list = await api.packageFiles(release.id);
        // The manifest and the scenario list are read from the package itself: names and counts come from what was built.
        const [manifest, scen] = await Promise.all([
          api.packageFileText(release.id, 'manifest.json').then((t) => JSON.parse(t) as ReleaseManifestDto).catch(() => null),
          api.packageFileText(release.id, 'tests/scenarios.json').then((t) => (JSON.parse(t).scenarios ?? []) as ReleaseScenarioDto[]).catch(() => [] as ReleaseScenarioDto[]),
        ]);
        if (live) setData({ files: list.files, manifest, scenarios: scen });
      } catch (e) { if (live) setError(e instanceof ApiFailure ? e.message : 'The contents could not be read.'); }
    })();
    return () => { live = false; };
  }, [release.id, pkg.sha256]);

  const byDir = useMemo(() => {
    const m = new Map<string, Map<string, ReleasePackageFileDto>>();
    for (const f of data?.files ?? []) {
      const mm = /^reference\/([^/]+)\/(.+)$/.exec(f.path);
      if (!mm) continue;
      if (!m.has(mm[1])) m.set(mm[1], new Map());
      m.get(mm[1])!.set(mm[2], f);
    }
    return m;
  }, [data]);

  if (error) return <div className="callout error" role="alert">{error}</div>;
  if (!data) return <Loading label="Reading the package…" />;
  const { files, scenarios } = data;
  const sum = pkg.summary;
  const scenarioName = (id: string) => scenarios.find((s) => s.id === id)?.name ?? id;
  const roles = (r: string) => files.filter((f) => f.role === r);
  const template = roles('template')[0];
  const dict = roles('data-dictionary')[0];
  const wordingSource = roles('wording-source')[0];
  const assets = roles('asset');
  const readme = roles('readme')[0];
  const ref = (path: string, title: string) => setOpen({ path, title });

  return (
    <div className="rel-contents" data-testid="rel-contents">
      <h4 className="rel-sub">What is inside</h4>
      <ul className="rel-groups">
        <li data-testid="rel-group-template"><strong>Template</strong><span>The approved document design, rules and messages, as one project file{template && <Tech> <span className="chip code">{template.path}</span></Tech>}.</span></li>
        <li data-testid="rel-group-wording">
          <strong>Wording by language</strong>
          <span>Every text a customer can read.</span>
          <ul className="rel-langs">
            {wordingSource && <li>{localeLabel(data.manifest?.languages.source ?? release.languages[0])} (source) <span className="muted">all texts</span></li>}
            {(sum?.languages ?? []).map((l) => (
              <li key={l.locale} data-testid="rel-lang" data-locale={l.locale}>
                {localeLabel(l.locale)} <span className="muted">{l.approved} of {l.texts} approved</span>
                {l.missing > 0 && <span className="chip warning rel-missing" data-testid="rel-lang-missing">{plural(l.missing, 'text')} not translated yet</span>}
                <Tech> <span className="chip code">{l.locale}</span></Tech>
              </li>
            ))}
          </ul>
        </li>
        <li data-testid="rel-group-dictionary"><strong>Data dictionary</strong><span>Every data field: its type, format, whether it is required, an example and where the template uses it.{dict && <Tech> <span className="chip code">{dict.path}</span></Tech>}</span></li>
        <li data-testid="rel-group-scenarios">
          <strong>Test scenarios</strong>
          <span data-testid="rel-scenario-count">{sum ? plural(sum.scenarios, 'synthetic scenario') : `${scenarios.length} synthetic scenarios`}, each with the outcome the engine works out.</span>
          {!!sum?.pinnedExcluded && <span className="chip warning rel-missing">{plural(sum.pinnedExcluded, 'pinned test')} left out (their customer is not synthetic)</span>}
        </li>
        <li data-testid="rel-group-references">
          <strong>Reference outputs</strong>
          <span>{sum ? plural(sum.references, 'scenario') : `${byDir.size} scenarios`} with the studio’s own PDF, web page, email and text message. Open one to see it.</span>
          <ul className="rel-refs" data-testid="rel-refs">
            {[...byDir.entries()].map(([dir, fs]) => (
              <li key={dir} data-testid="rel-ref" data-scenario={dir}>
                <span className="rel-ref-name" title={dir}>{scenarioName(dir)}</span>
                <span className="rel-ref-btns">
                  {([['document.pdf', 'PDF'], ['document.html', 'Web page'], ['email.html', 'Email'], ['sms.txt', 'Text message']] as const).filter(([f]) => fs.has(f)).map(([f, label]) => (
                    <button key={f} type="button" className="btn sm" data-testid={`rel-ref-open-${f}`} onClick={() => ref(`reference/${dir}/${f}`, `${scenarioName(dir)} · ${label}`)}>{label}</button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </li>
        <li data-testid="rel-group-more"><strong>Also inside</strong><span>{assets.length ? `${plural(assets.length, 'image')}, ` : ''}the list of fonts needed, and a guide for the receiving team.</span></li>
      </ul>
      {readme && <button type="button" className="btn sm" data-testid="rel-open-readme" onClick={() => ref(readme.path, fileLabel(readme.path))}>Open the README</button>}
      <Tech>
        <details className="rel-files">
          <summary>All {files.length + 1} files</summary>
          <ul className="mono rel-filelist">{[{ path: 'manifest.json', bytes: 0 } as ReleasePackageFileDto, ...files].map((f) => <li key={f.path}>{f.path}{f.bytes ? <span className="muted"> · {fmtBytes(f.bytes)}</span> : null}</li>)}</ul>
        </details>
      </Tech>
      {open && <PreviewDialog releaseId={release.id} path={open.path} title={open.title} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** One file of the package, shown without downloading the ZIP. Pages run in a sandbox that cannot reach the studio. */
function PreviewDialog({ releaseId, path, title, onClose }: { releaseId: string; path: string; title: string; onClose: () => void }) {
  const url = api.packageFileUrl(releaseId, path);
  const isText = path.endsWith('.txt');
  const isEmail = path.endsWith('email.html');
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!isText) return;
    let live = true;
    api.packageFileText(releaseId, path).then((t) => live && setText(t)).catch((e) => live && setError(e instanceof ApiFailure ? e.message : 'It could not be read.'));
    return () => { live = false; };
  }, [releaseId, path, isText]);
  return (
    <Dialog title={title} onClose={onClose} labelledBy="rel-preview-title"
      footer={<><a className="btn" href={api.packageFileUrl(releaseId, path, true)} download data-testid="rel-preview-download">Download this file</a><button type="button" className="btn primary" onClick={onClose}>Close</button></>}>
      <div className="rel-preview" data-testid="rel-preview" data-path={path}>
        {isText
          ? error ? <p className="callout error" role="alert">{error}</p> : text === null ? <Loading /> : <pre className="rel-preview-text" data-testid="rel-preview-text">{text}</pre>
          : <iframe title={title} src={url} sandbox={isEmail ? '' : 'allow-scripts'} className="rel-preview-frame" data-testid="rel-preview-frame" />}
      </div>
      <Tech><p className="muted mono rel-preview-path">{path}</p></Tech>
    </Dialog>
  );
}

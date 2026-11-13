import { useEffect, useState } from 'react';
import {
  LIBRARY_KIND_LABEL, WORDING_RULE_KIND_LABEL, applyCommand, keyCellWords, languageName,
  type BrandKit, type LibraryBlockContent, type LibraryContent, type LibraryGlossaryContent, type LibraryKind, type LibraryWordingContent,
  type LibraryWordingRulesContent, type LookupTable, type Project, type SyntheticRecord,
} from '@iss/model';
import { resolve, type Resolution } from '@iss/resolver';
import { api } from '../../api/client';
import { PagePreview } from '../../doc/PagePreview';
import { Loading } from '../../ui/common';
import { errorText } from './libraryData';

/** A preview of one version's content, in the form that suits its kind. */
export function ContentPreview({ kind, content, hostProjectId }: { kind: LibraryKind; content: LibraryContent; hostProjectId: string | null }) {
  switch (kind) {
    case 'block': return <BlockPreview content={content as LibraryBlockContent} hostProjectId={hostProjectId} />;
    case 'wording': return <WordingPreview content={content as LibraryWordingContent} />;
    case 'brand': return <BrandPreview brand={content as BrandKit} />;
    case 'glossary': return <GlossaryPreview content={content as LibraryGlossaryContent} />;
    case 'lookup-table': return <TablePreview table={content as LookupTable} />;
    case 'wording-rules': return <RulesPreview content={content as LibraryWordingRulesContent} />;
  }
}

/**
 * The block as it will look: placed alone on a page of a document of the right kind (the one it was taken from, or the
 * first such document) and worked out for one of that document's synthetic customers, with the same renderer as the PDF.
 */
function BlockPreview({ content, hostProjectId }: { content: LibraryBlockContent; hostProjectId: string | null }) {
  const [state, setState] = useState<{ project: Project; res: Resolution } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    setState(null);
    (async () => {
      const list = (await api.projects()).projects;
      const hostId = hostProjectId && list.some((p) => p.projectId === hostProjectId) ? hostProjectId : list[0]?.projectId;
      if (!hostId) throw new Error('There is no document to preview the block in.');
      const host = (await api.project(hostId)).project;
      const recs = (await api.records(host.documentType, host.projectId)).records.filter((r: SyntheticRecord) => r.documentType === host.documentType);
      if (!recs.length) throw new Error('The document has no customers to preview with.');
      // An empty page of that document, then the block linked into it: what any document gets when it inserts it.
      const page: Project = { ...host, libraryLinks: undefined, nodes: host.nodes.map((n) => (n.id === host.rootNodeId ? { ...n, children: [] } : n)) };
      const r = applyCommand(page, { type: 'LINK_LIBRARY_ITEM', item: { id: 'preview-block', kind: 'block', title: 'Preview' }, version: 1, content, placement: { parentId: host.rootNodeId }, linkId: 'lkpreview' });
      if (!r.ok) throw new Error(r.message);
      return { project: r.project, res: resolve({ project: r.project, record: recs[0] }) };
    })().then((s) => { if (live) setState(s); }).catch((e) => { if (live) setState({ error: errorText(e) }); });
    return () => { live = false; };
  }, [content, hostProjectId]);
  if (!state) return <Loading label="Drawing the block…" />;
  if ('error' in state) return <div className="callout warning" role="status" data-testid="lib-preview-error">The block cannot be drawn here: {state.error}</div>;
  return (
    <div className="lib-block-preview" data-testid="lib-preview-block" aria-label="How the block looks on a page">
      <div className="lib-block-paper"><PagePreview res={state.res} project={state.project} scale={0.62} showGuides={false} ia={{ selectedId: null }} /></div>
      <p className="muted lib-small">{content.nodes.length} component{content.nodes.length === 1 ? '' : 's'}, {content.contentParts.length} message{content.contentParts.length === 1 ? '' : 's'}; shown alone on a page for a synthetic customer.</p>
    </div>
  );
}

function WordingPreview({ content }: { content: LibraryWordingContent }) {
  const langs = Object.entries(content.part.approvedLocales);
  return (
    <div data-testid="lib-preview-wording">
      <h4 className="lib-subh">{content.part.title} <span className="chip">{content.part.type === 'disclosure' ? 'Disclosure' : 'Message'}</span></h4>
      <dl className="kv lib-langs">
        {langs.map(([loc, text]) => <div key={loc} className="lib-lang"><dt>{languageName(loc)}{content.titleTranslations?.[loc] ? <span className="muted"> · “{content.titleTranslations[loc]}”</span> : ''}</dt><dd lang={loc}>{text}</dd></div>)}
      </dl>
    </div>
  );
}

function BrandPreview({ brand }: { brand: BrandKit }) {
  const sw = (label: string, c?: string) => c ? <div className="lib-swatch"><span className="lib-swatch-chip" style={{ background: c }} aria-hidden="true" /><span>{label}</span><code>{c}</code></div> : null;
  return (
    <div className="lib-brand" data-testid="lib-preview-brand">
      <div className="lib-swatches">{sw('Primary colour', brand.primary)}{sw('Accent colour', brand.accent)}{sw('Text colour', brand.text)}</div>
      <p>Document font: <strong>{brand.fontFamily ?? 'Arial'}</strong></p>
      {brand.logoDataUri ? <div className="lib-logo-wrap"><img src={brand.logoDataUri} alt={brand.logoAlt ?? 'Brand logo'} className="lib-logo" /></div> : <p className="muted">No logo: documents keep the issuer mark.</p>}
    </div>
  );
}

function GlossaryPreview({ content }: { content: LibraryGlossaryContent }) {
  return (
    <div data-testid="lib-preview-glossary">
      {Object.entries(content.entries).map(([loc, list]) => (
        <section key={loc}>
          <h4 className="lib-subh">{languageName(loc)} <span className="chip count">{list.length}</span></h4>
          <table className="table"><thead><tr><th scope="col">English</th><th scope="col">{languageName(loc)}</th><th scope="col">Note</th></tr></thead>
            <tbody>{list.map((e) => <tr key={e.source}><td>{e.source}</td><td lang={loc}>{e.target}</td><td className="muted">{e.note ?? ''}</td></tr>)}</tbody></table>
        </section>
      ))}
    </div>
  );
}

function TablePreview({ table }: { table: LookupTable }) {
  const rows = table.rows.slice(0, 50);
  return (
    <div data-testid="lib-preview-table">
      <h4 className="lib-subh">{table.title} <span className="chip count">{table.rows.length} rows</span></h4>
      {table.description && <p className="muted">{table.description}</p>}
      <div className="lib-table-wrap">
        <table className="table">
          <thead><tr>{table.keys.map((k) => <th key={k.key} scope="col">{k.label}</th>)}{table.columns.map((c) => <th key={c.key} scope="col">{c.label}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}>{table.keys.map((k) => <td key={k.key}>{keyCellWords(k, r.keys[k.key])}</td>)}{table.columns.map((c) => <td key={c.key}>{r.values[c.key] === null || r.values[c.key] === undefined ? '—' : String(r.values[c.key])}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {table.rows.length > rows.length && <p className="muted lib-small">…and {table.rows.length - rows.length} more rows.</p>}
    </div>
  );
}

function RulesPreview({ content }: { content: LibraryWordingRulesContent }) {
  return (
    <ul className="list-rows" data-testid="lib-preview-rules">
      {content.rules.map((r) => (
        <li key={r.id}>
          <span className={`chip ${r.severity === 'must' ? 'error' : 'warning'}`}>{r.severity === 'must' ? 'Must' : 'Should'}</span>{' '}
          <strong>{WORDING_RULE_KIND_LABEL[r.kind]}</strong>
          {r.phrase && <> · “{r.phrase}”</>}{r.replacement && <> → “{r.replacement}”</>}
          {r.limit !== undefined && <> · {r.kind === 'reading-level' ? `grade ${r.limit}` : `${r.limit} words`}</>}
          {r.appliesTo && r.appliesTo !== 'anywhere' && <span className="muted"> · in {r.appliesTo}</span>}
          {r.note && <div className="muted">{r.note}</div>}
        </li>
      ))}
    </ul>
  );
}

export const kindLabel = (k: LibraryKind) => LIBRARY_KIND_LABEL[k];

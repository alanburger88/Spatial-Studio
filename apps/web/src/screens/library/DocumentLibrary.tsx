import { useState, type ReactNode } from 'react';
import { linkOfKind, type Project } from '@iss/model';
import { useCan, useStudio } from '../../state/store';
import { Icon } from '../../ui/icons';
import { LibraryChip, LinkedNotice, NotLinkedActions, PickFromLibraryDialog } from './LinkUI';

/**
 * The library entry points for things a document has one of: its brand (Styles & brand) and its glossary
 * (Content & Translations). Linked: the chip, the read-only notice, Unlink, Update available. Not linked: "Add to library"
 * and "From the library" (which replaces the document's own with the library's, read-only).
 */
export function WholeDocumentLibrary({ project, kind }: { project: Project; kind: 'brand' | 'glossary' }) {
  const link = linkOfKind(project, kind);
  const [picking, setPicking] = useState(false);
  const canEdit = useCan('edit');
  const what = kind === 'brand' ? 'The brand kit' : 'The glossary';
  if (link) return <div className="lib-doc" data-testid={`lib-${kind}-section`}><LinkedNotice link={link} what={what} /></div>;
  const has = kind === 'brand' ? !!project.brand : Object.values(project.glossary ?? {}).some((l) => l?.length);
  const onPick = (item: { id: string; title: string }, version: number, content: unknown) =>
    useStudio.getState().dispatch({ type: 'LINK_LIBRARY_ITEM', item: { id: item.id, kind, title: item.title }, version, content }).ok;
  return (
    <div className="lib-doc row wrap" data-testid={`lib-${kind}-section`}>
      <span className="muted lib-doc-label">Shared library:</span>
      <button type="button" className="btn sm" onClick={() => setPicking(true)} disabled={!canEdit} data-testid={`lib-${kind}-from-library`}><Icon.list width={13} height={13} /> Use a library {kind}</button>
      {has && <NotLinkedActions kind={kind} refId={kind} defaultTitle={kind === 'brand' ? `${project.issuer.name} brand` : `${project.title} glossary`} label={`this ${kind}`} />}
      {picking && (
        <PickFromLibraryDialog kind={kind} title={kind === 'brand' ? 'Brands from the library' : 'Glossaries from the library'} onClose={() => setPicking(false)} onPick={onPick}
          hint={`The chosen ${kind} replaces this document’s own. It is read-only here and receives the library’s updates after you review them.`} />
      )}
    </div>
  );
}

/** Wraps an editor so it is visibly read-only while the brand or glossary comes from the library. */
export function ReadOnlyKind({ project, kind, children }: { project: Project; kind: 'brand' | 'glossary'; children: ReactNode }) {
  const link = linkOfKind(project, kind);
  if (!link) return <>{children}</>;
  return (
    <fieldset disabled className="lib-readonly" data-testid="lib-readonly">
      <p className="lib-readonly-why"><LibraryChip link={link} /> Read-only: it comes from the library.</p>
      {children}
    </fieldset>
  );
}

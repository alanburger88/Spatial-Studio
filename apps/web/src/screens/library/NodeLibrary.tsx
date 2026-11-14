import { useMemo, useState, type ReactNode } from 'react';
import { libraryOwnership, partRefsOf, type DocNode, type LibraryLink, type Project } from '@iss/model';
import { useCan, useStudio } from '../../state/store';
import { Icon } from '../../ui/icons';
import { LibraryChip, LinkedNotice, NotLinkedActions, PickFromLibraryDialog } from './LinkUI';

/**
 * The library section of the Design Studio inspector: for a linked component, the chip, the read-only notice, Unlink and
 * Update available; otherwise "Add to library" (as a building block). For a section with messages (alternatives, a
 * conditional section, a notice or disclosure), each message can be added to the library as wording, and a library
 * wording can be used as a new alternative or as the notice's text.
 */
export function NodeLibrary({ project, node }: { project: Project; node: DocNode }) {
  const own = useMemo(() => libraryOwnership(project), [project]);
  const link = own.nodes.get(node.id);
  const parts = partRefsOf(node).filter((id) => project.contentParts.some((c) => c.id === id));
  if (link) {
    const isRoot = link.target.kind === 'block' && link.target.rootNodeId === node.id;
    return (
      <section className="insp-sec lib-insp" aria-label="Shared library" data-testid="lib-node-section">
        <LinkedNotice link={link} what={isRoot ? `“${link.title}”` : `This component (part of “${link.title}”)`} />
      </section>
    );
  }
  const root = node.id === project.rootNodeId;
  return (
    <section className="insp-sec lib-insp" aria-label="Shared library" data-testid="lib-node-section">
      <h3 className="insp-h">Shared library</h3>
      {!root && <NotLinkedActions kind="block" refId={node.id} defaultTitle={node.name ?? node.id} label="this component" />}
      {parts.length > 0 && <MessagesLibrary project={project} node={node} parts={parts} owners={own.parts} />}
    </section>
  );
}

function MessagesLibrary({ project, node, parts, owners }: { project: Project; node: DocNode; parts: string[]; owners: Map<string, LibraryLink> }) {
  const [picking, setPicking] = useState(false);
  const canEdit = useCan('edit');
  const alternatives = node.type === 'variant-set' || node.type === 'conditional-region';
  const onPick = (item: { id: string; kind: 'wording' | string; title: string }, version: number, content: any): boolean => {
    const dispatch = useStudio.getState().dispatch;
    const linkCmd = (partId: string) => ({ type: 'LINK_LIBRARY_ITEM' as const, item: { id: item.id, kind: 'wording' as const, title: item.title }, version, content, placement: { partId } });
    if (alternatives) {
      const taken = new Set([...project.nodes.map((n) => n.id), ...project.contentParts.map((c) => c.id)]);
      let id = `${node.id}-${item.id}`.slice(0, 60).replace(/-+$/, '');
      for (let i = 2; taken.has(id); i++) id = `${node.id}-${item.id}`.slice(0, 56).replace(/-+$/, '') + `-${i}`;
      const r = dispatch({ type: 'BATCH', label: `Add “${item.title}” from the library as an alternative`, commands: [
        { type: 'ADD_VARIANT', nodeId: node.id, variantId: id, title: content.part.title, text: content.part.approvedLocales['en-US'] },
        linkCmd(id),
      ] });
      return r.ok;
    }
    return dispatch(linkCmd(parts[0])).ok;
  };
  const row = (id: string): ReactNode => {
    const part = project.contentParts.find((c) => c.id === id)!;
    const l = owners.get(id);
    return (
      <li key={id} data-testid={`lib-part-${id}`}>
        <div className="lib-part-head"><strong title={part.title}>{part.title}</strong></div>
        {l ? <LinkedNotice link={l} what={`The wording “${part.title}”`} /> : <NotLinkedActions kind="wording" refId={id} defaultTitle={part.title} label="this wording" />}
      </li>
    );
  };
  return (
    <div className="lib-messages">
      <h4 className="lib-subh">Wording</h4>
      <ul className="list-rows lib-part-list">{parts.map(row)}</ul>
      {(alternatives || node.type === 'disclosure') && (
        <button type="button" className="btn sm" onClick={() => setPicking(true)} disabled={!canEdit} data-testid="lib-wording-from-library">
          <Icon.list width={13} height={13} /> {alternatives ? 'Add an alternative from the library' : 'Use wording from the library'}
        </button>
      )}
      {picking && (
        <PickFromLibraryDialog kind="wording" title="Wording from the library" onClose={() => setPicking(false)} onPick={onPick}
          hint={alternatives ? 'The chosen wording is added as a new alternative of this section, with its approved translations. It is read-only here and receives the library’s updates. A rule or condition still decides who gets it.' : 'The chosen wording replaces this text, with its approved translations. It is read-only here and receives the library’s updates.'} />
      )}
    </div>
  );
}

/** Whether a component's own settings are read-only because it comes from the library (its layout is the document's at the block's top). */
export function useLinkedNode(project: Project, nodeId: string | undefined): { link: LibraryLink | undefined; isRoot: boolean } {
  return useMemo(() => {
    if (!nodeId || !project.libraryLinks?.length) return { link: undefined, isRoot: false };
    const link = libraryOwnership(project).nodes.get(nodeId);
    return { link, isRoot: !!link && link.target.kind === 'block' && link.target.rootNodeId === nodeId };
  }, [project, nodeId]);
}

/** Wraps a part of the inspector so every field in it is visibly read-only while the component is linked. */
export function ReadOnlyWhenLinked({ link, children }: { link: LibraryLink | undefined; children: ReactNode }) {
  if (!link) return <>{children}</>;
  return (
    <fieldset disabled className="lib-readonly" data-testid="lib-readonly" aria-describedby="lib-readonly-why">
      <p id="lib-readonly-why" className="lib-readonly-why"><LibraryChip link={link} /> Read-only: it comes from the library.</p>
      {children}
    </fieldset>
  );
}

import { useState } from 'react';
import { libraryOwnership, nodeMap, parentOf, type Project } from '@iss/model';
import { useCan, useStudio } from '../../state/store';
import { Icon } from '../../ui/icons';
import { PickFromLibraryDialog } from './LinkUI';

/**
 * "From the library" in the Design Studio component list: inserts an approved building block after the selected
 * component (or into a selected section, or at the end of the page). The block is read-only and keeps its library link.
 */
export function LibraryBlockButton({ project, selectedId }: { project: Project; selectedId: string | null }) {
  const [open, setOpen] = useState(false);
  const canEdit = useCan('edit');
  const where = (): { parentId: string; index?: number } => {
    const map = nodeMap(project);
    const owned = libraryOwnership(project).nodes;
    const sel = selectedId ? map.get(selectedId) : undefined;
    // Never inside linked content: after the linked block instead.
    const anchor = sel && owned.has(sel.id) ? map.get(owned.get(sel.id)!.target.kind === 'block' ? (owned.get(sel.id)!.target as { rootNodeId: string }).rootNodeId : sel.id) : sel;
    if (anchor?.type === 'container' && !owned.has(anchor.id)) return { parentId: anchor.id };
    if (anchor && anchor.id !== project.rootNodeId) {
      const p = parentOf(project, anchor.id);
      if (p) return { parentId: p.id, index: p.children!.indexOf(anchor.id) + 1 };
    }
    return { parentId: project.rootNodeId };
  };
  const onPick = (item: { id: string; title: string }, version: number, content: unknown) => {
    const before = new Set(project.libraryLinks?.map((l) => l.linkId) ?? []);
    const r = useStudio.getState().dispatch({ type: 'LINK_LIBRARY_ITEM', item: { id: item.id, kind: 'block', title: item.title }, version, content, placement: where() });
    if (!r.ok) return false;
    const added = useStudio.getState().project?.libraryLinks?.find((l) => !before.has(l.linkId));
    if (added?.target.kind === 'block') useStudio.getState().select(added.target.rootNodeId);
    useStudio.getState().toast({ kind: 'success', title: `“${item.title}” inserted from the library`, message: `Version ${version}, read-only here. One undo step.` });
    return true;
  };
  return (
    <>
      <button type="button" className="btn sm lib-from-btn" onClick={() => setOpen(true)} disabled={!canEdit} data-testid="lib-insert-block" title="Insert an approved building block from the shared library">
        <Icon.list width={13} height={13} /> From the library…
      </button>
      {open && <PickFromLibraryDialog kind="block" title="Building blocks from the library" onClose={() => setOpen(false)} onPick={onPick}
        hint="The block goes after the selected component. It keeps a link to the library: it is read-only here, and when a newer version is approved you can review the change and update it." />}
    </>
  );
}

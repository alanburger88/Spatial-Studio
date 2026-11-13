import { Link } from 'react-router-dom';
import { linkStatus, type Project } from '@iss/model';
import { useLibraryItems } from './libraryData';

/** Overview: one line when library items this document uses have a newer approved version. Nothing for a document without links. */
export function LibraryUpdatesLine({ project }: { project: Project }) {
  const links = project.libraryLinks ?? [];
  const { items, ready } = useLibraryItems();
  if (!links.length || !ready) return null;
  const behind = links.filter((l) => linkStatus(l, items) === 'behind').length;
  if (!behind) return null;
  return (
    <div className="callout info lib-ov-line" role="status" data-testid="overview-library-updates" data-count={behind}>
      <Link to={`/library?document=${encodeURIComponent(project.projectId)}`} data-testid="overview-library-link">
        {behind} library update{behind === 1 ? '' : 's'} available
      </Link>
      <span className="muted"> · review the change and its impact before applying it</span>
    </div>
  );
}

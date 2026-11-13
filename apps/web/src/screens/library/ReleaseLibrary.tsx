import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LIBRARY_KIND_LABEL, type LibraryKind } from '@iss/model';
import { api } from '../../api/client';

type Row = { itemId: string; title: string; kind: LibraryKind; version: number; inLibrary: boolean };

/** Release detail: what the release took from the shared library (frozen with it). Nothing is shown when it took nothing. */
export function ReleaseLibrarySection({ releaseId }: { releaseId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    let live = true;
    setRows(null);
    api.releaseLibrary(releaseId).then((r) => { if (live) setRows(r.library); }).catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [releaseId]);
  if (!rows?.length) return null;
  return (
    <section className="rel-section" aria-labelledby="rel-library-h" data-testid="rel-library">
      <h3 className="section-title" id="rel-library-h">From the library</h3>
      <p className="muted" style={{ margin: '0 0 6px' }}>These parts were linked to the shared library when the release was approved. Their content is frozen in the release; the release package lists them in its manifest and README.</p>
      <ul className="list-rows">
        {rows.map((l) => (
          <li key={`${l.itemId}-${l.version}`} data-testid="rel-library-item">
            {l.inLibrary ? <Link to={`/library?item=${encodeURIComponent(l.itemId)}`}>{l.title}</Link> : <span>{l.title} <span className="muted">(not in this library)</span></span>}
            <span className="muted"> · {LIBRARY_KIND_LABEL[l.kind]} · version {l.version}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

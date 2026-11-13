import { useState } from 'react';
import { api } from '../api/client';
import { Empty } from '../ui/common';
import { Icon } from '../ui/icons';
import { editBlockedReason, useStudio } from '../state/store';

/**
 * A document with its own data has no shared sample customers. It is given its first customer when it is created, so
 * this is only seen if they were all removed some other way: say so, and offer the way back (generate test customers).
 */
export function NoCustomers() {
  const project = useStudio((s) => s.project)!;
  const blocked = useStudio((s) => editBlockedReason(s.session));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const generate = async () => {
    setBusy(true); setErr(null);
    try {
      await api.generateTestData(project.projectId, { outcomes: true, edges: true });
      await useStudio.getState().refreshRecords();
    } catch (e) { setErr(e instanceof Error ? e.message : 'The customers could not be generated.'); }
    setBusy(false);
  };
  return (
    <section className="screen" data-testid="no-customers">
      <div className="screen-body">
        <Empty title="This document has no customers to preview with" message="A document with your own data is previewed with customers made for it. Generate some from its data fields and rules; you can add your own later.">
          <button className="btn primary" onClick={generate} disabled={busy || !!blocked} title={blocked ?? undefined} data-testid="no-customers-generate"><Icon.plus /> {busy ? 'Generating…' : 'Generate test customers'}</button>
          {err && <p className="callout error" role="alert">{err}</p>}
        </Empty>
      </div>
    </section>
  );
}

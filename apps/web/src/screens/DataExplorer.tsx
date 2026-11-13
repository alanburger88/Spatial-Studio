import { ScreenHeader } from '../ui/common';

/** Data Explorer (S16): placeholder until the screen is built. */
export function DataExplorer() {
  return (
    <section className="screen" data-testid="data-explorer">
      <ScreenHeader id="S16" title="Data Explorer" subtitle="See, edit, add and remove the customers this document is tested with." />
      <div className="screen-body"><p className="muted">This screen is being built.</p></div>
    </section>
  );
}

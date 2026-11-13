import { ScreenHeader } from '../ui/common';

/** Releases (S18): placeholder until the screen is built. */
export function Releases() {
  return (
    <section className="screen" data-testid="releases-screen">
      <ScreenHeader id="S18" title="Releases" subtitle="Approved, frozen versions of this document, their stage and the package to hand over." />
      <div className="screen-body"><p className="muted">This screen is being built.</p></div>
    </section>
  );
}

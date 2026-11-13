import { ScreenHeader, Empty } from '../ui/common';

/** Placeholder until the Before & after builder replaces this file (wave 1). Not a finished screen. */
export function BeforeAfter() {
  return (
    <section className="screen" data-testid="before-after">
      <ScreenHeader id="S20" title="Before & after" subtitle="Compare two releases of this document, or the working version with a release." />
      <div className="screen-body"><Empty title="Not built yet" message="This screen is being built." /></div>
    </section>
  );
}
export default BeforeAfter;

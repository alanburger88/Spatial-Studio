import { ScreenHeader, Empty } from '../ui/common';

/** Placeholder until its builder replaces this file (roadmap wave 2). Not a finished screen. */
export function LookupTables() {
  return (
    <section className="screen" data-testid="lookup-tables-screen">
      <ScreenHeader id="S23" title="Lookup tables" subtitle="Small tables, such as a fee by tier, that a calculation reads." />
      <div className="screen-body"><Empty title="Not built yet" message="This screen is being built." /></div>
    </section>
  );
}
export default LookupTables;

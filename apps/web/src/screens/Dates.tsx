import { ScreenHeader, Empty } from '../ui/common';

/** Placeholder until its builder replaces this file (roadmap wave 2). Not a finished screen. */
export function Dates() {
  return (
    <section className="screen" data-testid="dates-screen">
      <ScreenHeader id="S24" title="Dates" subtitle="The document’s date, what starts and ends when, and a timeline." />
      <div className="screen-body"><Empty title="Not built yet" message="This screen is being built." /></div>
    </section>
  );
}
export default Dates;

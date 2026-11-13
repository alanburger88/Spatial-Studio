import { ScreenHeader, Empty } from '../ui/common';

/** Placeholder until its builder replaces this file (roadmap wave 2). Not a finished screen. */
export function Calculations() {
  return (
    <section className="screen" data-testid="calculations-screen">
      <ScreenHeader id="S22" title="Calculations" subtitle="Values worked out from the customer’s data, for rules and wording." />
      <div className="screen-body"><Empty title="Not built yet" message="This screen is being built." /></div>
    </section>
  );
}
export default Calculations;

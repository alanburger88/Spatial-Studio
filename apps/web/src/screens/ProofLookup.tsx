import { ScreenHeader, Empty } from '../ui/common';

/** Placeholder until the Proof builder replaces this file (wave 1). Not a finished screen. */
export function ProofLookup() {
  return (
    <section className="screen" data-testid="proof-lookup">
      <ScreenHeader id="S21" title="Proof" subtitle="What a customer was given, from which release, and why." />
      <div className="screen-body"><Empty title="Not built yet" message="This screen is being built." /></div>
    </section>
  );
}
export default ProofLookup;

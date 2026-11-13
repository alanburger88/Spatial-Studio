import { ScreenHeader } from '../ui/common';

/** S15 Email & SMS — placeholder; the editor is built on the model's SET_CHANNELS command. */
export function EmailSms() {
  return (
    <section className="screen" data-testid="channels-view">
      <ScreenHeader id="S15" title="Email & SMS" subtitle="Edit the email and text-message wording and choose which sections the email shows." />
    </section>
  );
}

import type { TemplateVersionDto } from '../../api/client';

export const SAVE_TEMPLATE_DENIED = 'Only approvers and admins can save templates';
export const NOT_BROUGHT_IN = 'Customers, Version history, Review state, Comments';

/** "Taken from" counts, shared by the template detail and the import report. */
export function CountsList({ counts }: { counts: TemplateVersionDto['counts'] }) {
  return (
    <dl className="kv tpl-counts">
      <dt>Components</dt><dd>{counts.components}</dd>
      <dt>Rules</dt><dd>{counts.rules}</dd>
      <dt>Messages</dt><dd>{counts.messages}</dd>
      <dt>Languages</dt><dd>{counts.languages}</dd>
      <dt>Pinned tests</dt><dd>{counts.tests}</dd>
    </dl>
  );
}

/**
 * Fixed, customer-visible text that the outputs add around the document's own content. The table itself lives in the
 * model package (`SYSTEM_STRINGS`) so it can be translated like any other project text; this module keeps the names the
 * renderers use. Everything can be replaced through `renderInteractiveHtml(res, project, { strings })`; by default the
 * renderers use the translated set carried on the resolution (`res.systemStrings`).
 */
import { SYSTEM_STRINGS, fmtString, resolveSystemStrings, type SystemStringKey, type SystemStrings } from '@iss/model';

export const HTML_STRINGS = SYSTEM_STRINGS;
export type HtmlStringKey = SystemStringKey;
export type HtmlStrings = SystemStrings;
export const resolveHtmlStrings = resolveSystemStrings;
export { fmtString };

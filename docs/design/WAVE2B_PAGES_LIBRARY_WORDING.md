# Page design depth, accessible PDF, shared library, wording rules

Status: **design for roadmap wave 2, second half (`docs/ROADMAP.md`). Not built yet.**
Decisions by the product owner on 2026-11-13 (D92): accessible PDF is proven by **the studio's own checks, plus veraPDF when it is installed**; wording rules are **house rules in the shared library, each set to block or warn**. The shared library itself follows decision 3 and the library rules of `docs/design/TEMPLATES_AND_CCM.md`.

## 1. Page design depth

**Where we start.** One paper size (US Letter), one set of margins, a flow area whose top differs on the first page, fixed items that appear on the first, following or all pages, and "keep with next". The letterhead zone cannot be resized and there are no columns or backgrounds.

**What is added.**

| Feature | What a person can do |
|---|---|
| Paper | Choose US Letter, A4 or US Legal, portrait or landscape; set the margins. Existing documents stay US Letter portrait. |
| Page templates | Three named page templates per document: **First page**, **Following pages**, and optionally **Last page**. Each has its own flow area and its own fixed furniture (header, footer, letterhead zone, address window). This is what other tools call master pages. |
| Resizable zones | Drag the edges of the flow area and of the letterhead zone on the page in Design Studio, or type the measurements. Fixed items snap to margins and to each other. |
| Backgrounds | A background image or tint per page template (pre-printed stationery, a "COPY" or "DRAFT" watermark), always marked as decoration so it is ignored by screen readers and left out of the web page, email and SMS. |
| Columns | The flow area of a page template can have one, two or three columns with a gap; content fills a column, then the next, then the next page. Any component can be set to span all columns. |
| Keeping things together | Per component: keep together (never split across columns or pages), keep with next (exists), start on a new page or column, and for paragraphs a minimum number of lines left behind and carried over. |

**Rules.**

- The page design belongs to the paged outputs (PDF and the AFP simulation). The web page, email and SMS do not change.
- Pagination stays a property of the real composed pages: nothing is estimated. A component that cannot fit a whole empty flow area while "keep together" is on is a blocker that names it.
- Existing documents compose exactly as before until someone changes their page design (the oracle and the reference PDFs prove it).
- Every change is an ordinary undoable command; Page Composition Stack, Before & after and the release package's reference outputs show the result.

**Out of scope here:** duplex and tray control, inserts, barcodes and OMR marks (print production, wave 5); different page designs chosen by rule.

### As built (page design depth)

**Model** (`packages/model/src/types.ts`, `pageDesign.ts`). The paged profiles (`paged-pdf` and `paged-afp-sim`, always changed together) gain `paper` (`US-Letter` | `A4` | `US-Legal`), `orientation` and `pageTemplates: { first?, following?, last? }`; each template may set its own `flowArea` (x, y, width, height in pt), `columns` (1–3), `columnGapPt` and `background` (image from the image library or a hex tint, with an opacity). Components gain `keepTogether`, `breakBefore` (`page` | `column`), `spanColumns`, `splitText` with `minLinesLeft` / `minLinesCarried` (default 2). Fixed items gain `pages: 'last'`. The mapping of older documents is unchanged: no `paper` = US Letter portrait; `pageMarginsMm` gives the left and right of every flow area; `flowRegion.firstPageTopPt / otherPagesTopPt / bottomPt` give the top and bottom of the First page and Following pages flow areas; a template's own `flowArea`, once set, takes precedence. A `last` entry (even empty) turns the Last page template on; its flow area defaults to the Following pages one. `effectivePageDesign(profile)` is the one place every consumer reads the geometry from.

**Commands.** `SET_PAGE_DESIGN { patch: { paper?, orientation?, pageMarginsMm?, pageTemplates? } }` is one undoable step for both paged profiles, validated by `pageDesignProblems` (also run on project files and by `UPDATE_PROFILE`). Changing the paper or orientation refits the flow areas (same distance from the top and bottom edges, margin to margin) and moves unlocked fixed items with the page edges they sit against, in the same step. Templates emptied again are removed, so the document is back on its original page design. `SET_LAYOUT` validates the new component settings and keeps fixed items on the page of the chosen paper.

**Composer.** A document that uses none of this composes with the original page source and paginator (`PAGINATOR_JS`), byte for byte, so its pages, PDF, reference PDFs and proof fingerprints do not move. A document that uses page design gets `PAGINATOR_JS_V2` (`paginator-design-source.ts`, renderer `iss-paged-renderer/1.1.0`). Forced onto the 101 sample compositions (70 card, 30 claim customers, the 250-row stress case), V2 gives the same page count, page tree, diagnostics, extracted facts and text as the original. The runnable package and the release package pick the design up through `renderPagedDocument` unchanged.

**Differences from the table above, and why.**
- *Letterhead zone*: it is not a separate object. It is the part of the first page above the First page flow area, between the margins; its bottom edge is that flow area's top, so dragging one moves the other. Fixed items placed in it are the letterhead. This needs no new model and cannot disagree with the flow area.
- *Fixed furniture per template*: fixed items keep `pages` (`first`, `following`, `all`, `last`) rather than belonging to a template object. `following` keeps meaning "every page after the first", so it includes the last page. A one-page document with a Last page template uses the First page flow area kept clear of the Last page area, and carries both templates' fixed items.
- *Last page*: the document is composed, then composed again with its final page on the Last page template until the page count holds. When the content fits the Following pages area but not the Last page area, the last page carries only its fixed items (for example a payment slip).
- *Columns are not balanced*: content fills a column, then the next, then the next page. A spanning component starts below the longest column above it, and the next columns start below it.
- *Text that splits*: off unless set per component ("Let the text continue in the next column or page"), because every existing text component moves whole today. When on, it splits between lines, keeping at least the lines asked for before and after the break.
- *Keep together that cannot fit*: `KEEP_TOGETHER_CANNOT_FIT` (blocking, layout) names the component; the component is then placed as usual so nothing is lost from the draft. Its fix turns keep together off (risk: review).
- *Background as an artifact*: the background is a decorative layer with no node id and `aria-hidden`; it is not in the semantic manifest, parity, web page, email or SMS. In the tagged PDF this version of Chromium draws it outside every marked-content sequence (so it is outside the structure tree and not read out) but does not write an `/Artifact` marker for any markup tried; a strict PDF/UA checker may report unmarked content. Marking it as `/Artifact` belongs to section 2.
- *Static checks*: `pageDesignFindings(project)` in `packages/renderers/src/pageChecks.ts` (not `packages/validation`) reports an unusable page design and fixed items off the page; the composer reports `FIXED_OFF_PAGE` per page. The Page panel shows them.

## 2. Accessible PDF, proven

**Where we start.** The PDF is tagged by the browser that composes it. It has never been checked.

**Two levels of proof, always labelled.**

1. **Checked by the studio** (always available). The studio opens the PDF it produced and checks: it is tagged and has a structure tree; it has a title and a language; headings exist and their levels do not skip; every table has header cells; every picture has a description or is marked as decoration; links have readable text; lists are tagged as lists; the reading order of the tags follows the order of the document's parts; text contrast against its background meets the WCAG AA ratio. Each failure names the part of the document and how to fix it there.
2. **Validated by veraPDF** (when the free, open-source veraPDF validator is installed on the machine and the studio is told where it is). The studio runs it against the PDF/UA-1 profile and shows its verdict and the failed rules. The studio never downloads or installs it.

The screen, the release and the release package say which level was reached and when: "Checked by the studio" is not presented as "validated against PDF/UA".

**Making failures matter.** Each document has a setting, "Accessible PDF is required". When it is on, a failed check is a blocker (kind: layout and pages) found by the full check; when it is off, it is a warning.

**Fixing what the checks find.** Where the composed page lacks something (a document title, the language, header cells, a description, decoration marked as such), the page composer is corrected so the tags are right at the source. Nothing is patched into the PDF afterwards.

**Known limit, stated on the screen.** A PDF declares conformance to PDF/UA with an identifier in its metadata, which the composing browser does not write. Until the studio has its own PDF writer, a veraPDF run is expected to report that one rule, and the studio will say so plainly rather than claim conformance.

### As built (accessible PDF)

Details, every check and what it can and cannot see: `docs/design/PDF_ACCESSIBILITY.md`.

- **Checked by the studio**: `checkPdfAccessibility` (`apps/api/src/pdfAccessibility.ts`) reads the composed PDF with pdf.js (structure tree, mark info, document information, viewer preferences, annotations, drawing operations) plus what the studio knows from the composed pages (each component's text per page, the expected reading order, where decoration is drawn, picture descriptions, lists, brand colours). Eleven checks: the nine of this section, with "has a title and a language" as two, plus "all text is in the tags". Findings carry stable codes `PDF_A11Y_*`, the component and page, a fix in plain words, and are blocking when the document requires an accessible PDF, warnings otherwise. A check that cannot be done says "not checked".
- **Validated by veraPDF**: `apps/api/src/verapdf.ts` finds it at `VERAPDF_PATH` or on the `PATH`, runs `--flavour ua1 --format mrr` with a time limit and returns the verdict, version and failed rules. Tested with stand-in programs only; **no real veraPDF run has been made** (it is not installed here and is never downloaded).
- **Fixed at the source** (paged renderer `1.0.1`, page-design renderer `1.1.1`): heading levels start at 1 and never skip (`aria-level` only), table titles are headings, the chart's and QR code's figure carries the description, decorative images are left out of the tags, and fixed items below the flow area (the page footer) are read after the page content. The web page, email and SMS are unchanged; 30 of 30 composed pages of the samples and of page-design documents are pixel-identical before and after (150 dpi). Before: the card failed headings, pictures, tables and reading order, the EOB headings, pictures and reading order; after: the EOB passes all eleven, the card all but its continued table, whose header row repeats only with the suggested fix (it changes how the page looks, so it is the author's choice).
- **Backgrounds as artifacts (section 1's open point)**: no markup makes this Chromium write `/Artifact` (CSS backgrounds, `img alt=""`, `role="presentation"`, `aria-hidden`, pseudo-elements, `@page` margin boxes, Chromium's own header and footer templates were all tried). Hidden decoration is drawn outside the tags, so screen readers skip it, but a strict validator will report it. It is stated as a second known limit, with the PDF/UA identifier and, when there are links, link descriptions (`/Contents`).
- **The setting** `accessiblePdfRequired` (`SET_ACCESSIBLE_PDF_REQUIRED`, Design, Page setup). The full check runs the PDF part of the accessibility suite for every customer, so failures become blockers of kind layout and pages when the setting is on.
- **Release record**: made on demand from the release detail ("Check the PDF"), not at creation (composing and checking takes seconds, and release creation belongs to `releases.ts`); records are added to their own table and the latest is shown with the level reached and when.

## 3. Shared library

**What it is.** One place for the things many documents share, so a change is made once, approved once, and reaches each document by a reviewed update.

**Kinds of item.**

| Kind | Examples |
|---|---|
| Brand | colours, font, logo |
| Building block | a header, a footer, a contact panel, any section of a page |
| Wording | a required notice, a common message, with its translations |
| Glossary | preferred translations of recurring terms |
| Wording rules | the house rules of section 4 |
| Lookup table | a rate table used by several documents (once wave 2's first half is in) |

**Versions.** A library item has numbered versions. A version is frozen when an approver approves it; nothing edits an approved version; a change is a new version.

**Linking.** A document links to an item at a version. The item's content is placed in the document, marked with where it came from, and is read-only there; "Unlink" keeps the content and makes it the document's own. A release freezes the content and records each item and version it used, so a document never depends on the library at run time, and the engine, releases and the runnable package need no change in how they work.

**Updating, never silently.** When an item has a newer approved version, each document that links to it shows "Update available". Opening it shows the change and the **impact**: which test customers would see something different (the Before & after comparison). Applying the update is one undoable step and goes through the document's own review and approval like any other change. From the library an approver sees **where an item is used** and which documents are behind.

**Who.** Authors propose items and versions; approvers and admins approve them; anyone can see them.

**Where.** A **Library** tab beside the project list (the Projects section), so the menu keeps its eight entries. In a document: "From the library" in the component list, the wording picker and the brand panel; a "Library" line on Overview when updates are waiting.

**Finding duplicates** across documents to fill the library is wave 3.

## 4. Wording rules and checker

**House rules** are a library item of kind "Wording rules": a list of rules, each set by an admin to **must** (breaking it is a blocker) or **should** (a warning). A document that links to the house rules follows them and can add its own.

| Rule | Example |
|---|---|
| Banned word or phrase, with an optional replacement | "delinquent" → "past due" |
| Required phrase, in a named kind of text or anywhere in the document | every statement includes the dispute-rights sentence |
| Preferred spelling or term | "email", not "e-mail" |
| Reading level no harder than a grade (English) | grade 8 |
| Sentence no longer than a number of words | 25 |
| Tone | no wording that reads as a demand for money where the document is not a bill (the existing check) |

**The checker** is one pure function over every text a customer can read (messages and their alternatives, labels, notices, email and SMS wording), per language where a rule names one. It runs as a person types, with the finding shown under the text and a one-click replacement where the rule gives one, and across the whole document from Check. "Must" failures appear on the Blockers screen under wording.

**AI help, under the usual policy (D65).** With an AI key, "Suggest compliant wording" proposes a rewrite that satisfies the rules; the person edits and approves it. The checker itself never needs AI, and an AI suggestion is checked by the same function before it is shown.

**Limits.** Reading level and tone are English only. A required phrase is matched as written (ignoring case and spacing), not by meaning.

## Phases

1. Page design depth (model, composer, Design Studio, tests against real composed pages).
2. Accessible PDF checks, the veraPDF bridge, composer corrections, the setting, where results show.
3. Shared library (store, versions, linking, update with impact, Library tab, release record).
4. Wording rules and checker on top of the library; AI suggestion.
5. Full verification, evidence, report.

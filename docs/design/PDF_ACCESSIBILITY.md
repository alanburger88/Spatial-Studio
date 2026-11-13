# Accessible PDF, proven: the checks, what they see, and what the browser can write

Status: **built (wave 2, section 2 of `WAVE2B_PAGES_LIBRARY_WORDING.md`).** Code: `apps/api/src/pdfAccessibility.ts`
(the studio's checks), `apps/api/src/verapdf.ts` (the veraPDF bridge), `apps/api/src/routes/pdfAccessibility.ts`
(veraPDF status and the release record), the accessibility block of `/api/v1/validate` in `apps/api/src/app.ts`.
Tests: `apps/api/test/pdf-accessibility.test.ts` (real composed PDFs), `e2e/pdf-accessibility.spec.ts`.

## Two levels of proof, always labelled

| Level | When | What it means |
|---|---|---|
| **Checked by the studio** | Always (Validate & Compare's accessibility suite, the full check, a release on demand) | The studio opened the PDF it composed and ran the eleven checks below. It is **not** validation against PDF/UA, and no screen says it is. |
| **Validated by veraPDF** | Only when veraPDF is installed on the studio's machine and ran | veraPDF's verdict against the PDF/UA-1 profile, its version and the rules it reported as failed. Otherwise the screen says "veraPDF is not installed on this machine". |

The studio never downloads or installs veraPDF.

## How the PDF is read

`checkPdfAccessibility(pdfBytes, context)` reads the PDF with pdf.js 4.9 (`pdfjs-dist` 4.9.155, a dependency of `@iss/api`) in
Node: the mark info, the document information (title, language), the viewer preferences, the structure tree of every
page (`getStructTree`: role, alternate description, language, marked-content ids), the annotations, and the drawing
operations of every page (`getOperatorList`: marked-content sequences, text with its font, size, colour and opacity,
filled shapes, gradients, pictures and their pixels). Nothing is written back to the PDF.

What the studio knows about the document comes in the context, from the composed pages (`Composer.composePaged(…,
{ parts: true })` runs `PDF_PARTS_JS` in the page before printing):

- **the parts of each page**: every component's text as laid out on that page, its name, kind, whether it is
  decoration, the descriptions the studio gave its pictures (image description, chart summary, "QR code for …"), the
  items of its lists, and whether a table continues from an earlier page;
- **the expected reading order** of each page (`pdfPartsOf`): fixed items above the bottom of the flow area from top
  to bottom (left to right when side by side), the flowing content in the order it was placed, then fixed items at
  or below the bottom of the flow area from top to bottom. This comes from where things are on the page, not from the
  order of the page source, so it can disagree with the tags;
- **where decoration is drawn** (pictures with an empty description, things hidden from assistive technology), and
  which pages have a page background;
- the document's language, the brand and text-style colours, and whether an accessible PDF is required.

**Naming the part of the document.** pdf.js does not expose the element ids the browser writes (`/ID` is an internal
accessibility id, not the studio's component id), so structure elements are mapped to components by **text**: each
part's text (spaces removed, lower case) is found in the page's tags in tag order; an element belongs to the part whose
text range contains it. A figure is matched by its description first. When nothing matches, the finding names the page
only. Findings carry the component id (`nodeId`), so every screen can link to it.

## The checks

Each finding has a stable code, the check it belongs to, a title and a fix in plain words, the page, and the
component where it can be named. Its severity is **blocking** when the document requires an accessible PDF and
**warning** otherwise. A check that cannot be done says **not checked**; it never passes.

| Check | Codes | What it reads | What it cannot see |
|---|---|---|---|
| Tagged, with a structure tree | `PDF_A11Y_NOT_TAGGED` | `MarkInfo /Marked true` and a non-empty structure tree. Without tags every structural check below is *not checked*. | Whether the tags are *good*; that is what the other checks are for. |
| Has a title | `PDF_A11Y_NO_TITLE`, `PDF_A11Y_TITLE_NOT_SHOWN` | `/Title` in the document information (not empty, not a file name) and `DisplayDocTitle true` in the viewer preferences. | The XMP `dc:title` (the browser writes no XMP; see limits). |
| Says its language | `PDF_A11Y_NO_LANGUAGE`, `PDF_A11Y_WRONG_LANGUAGE` | The catalog `/Lang`: a language code whose primary language is the document's. | Language changes inside the text (the browser writes none). |
| Headings exist and their levels do not skip | `PDF_A11Y_NO_HEADINGS`, `PDF_A11Y_HEADING_SKIPPED` | `H1`…`H6` elements in tag order across pages; the first must be level 1 and none may be more than one level below the one before. | Whether a piece of bold text *should* have been a heading (the studio's own table titles are headings now). |
| Every table has header cells | `PDF_A11Y_TABLE_NO_HEADERS` | Each `Table` (its `TR` rows, also inside `THead`/`TBody`/`TFoot`): a header row of `TH` cells, or a `TH` at the start of every data row. A table part that continues from the page before without its header row is reported as such. | The `/Scope` and `/Headers` attributes (pdf.js does not expose them; the browser writes them from `scope=` on `th`). |
| Every picture has a description or is decoration | `PDF_A11Y_FIGURE_NO_ALT`, `PDF_A11Y_IMAGE_NO_DESCRIPTION` | Every `Figure` has a non-empty `/Alt`; and, from the document, every image that is not decoration has a description. | A picture drawn outside the tags looks like decoration in the PDF; only the document can tell that it was meant to be content. |
| Links have readable text | `PDF_A11Y_LINK_TEXT`, `PDF_A11Y_LINK_NOT_TAGGED` | Every `Link` element's text is not empty and not "click here", "here", "more", …; every link annotation has a `Link` element. | Whether the words describe the right destination. |
| Lists are tagged as lists | `PDF_A11Y_LIST_STRUCTURE`, `PDF_A11Y_LIST_NOT_TAGGED` | Every `L` has `LI` items; every list the document has is inside an `LI`; two or more paragraphs in a row starting with typed bullets or numbers are reported. | `LBody` (the browser writes `LI` with `Lbl` and the text, without `LBody`). |
| Reading order follows the document | `PDF_A11Y_READING_ORDER` | The position of each part's text in the page's tags, compared with the expected order above; the parts that are not on the longest run in order are reported, with the part they are read before or after. *Not checked* without the composed pages. | Parts with no text (pictures, shapes) and parts whose text cannot be found in the tags (they are named in the detail). |
| Text contrast meets WCAG AA | `PDF_A11Y_LOW_CONTRAST` | Every character drawn: its colour and opacity, its size (large text: 18 pt, or 14 pt bold), and what was drawn behind it before it (fills with their opacity, gradients by their colour stops, pictures by their pixels around the character), over white paper. 4.5:1, or 3:1 for large text. One finding per part and pair of colours, naming the brand or text-style colour when it is one. | Text that is part of a picture or logo (inside a `Figure`), and text drawn as part of a page background or a decorative picture (decoration). When a picture's pixels cannot be read, the text over it is *not checked* and the check says so instead of passing. |
| All text is in the tags | `PDF_A11Y_UNTAGGED_TEXT` | Text drawn outside every marked-content sequence (a screen reader does not read it), except text inside a page background or a decorative picture. | — |

**Known limits, stated on the screen with every result** (`knownLimits`): the PDF does not declare PDF/UA conformance
(no PDF/UA identifier and no XMP metadata); decoration is drawn outside the tags but is not marked as an artifact (with
the number of such drawings in this PDF); links have no separate description (`/Contents`) when the PDF has links.
A veraPDF run is expected to report these, and the studio says so plainly rather than claim conformance.

## What was corrected at the source (renderer 1.0.1 and 1.1.1)

The composed HTML was changed so the browser's tags come out right. Nothing is patched into the PDF.

| Problem found on the samples | Correction in the page source | Files |
|---|---|---|
| The first heading was level 2 (rich text `##`), no level 1 | Heading levels are set in reading order with `aria-level` only: the first heading becomes level 1, none skips a level. The elements stay `h2`/`h3`, so the CSS is unchanged. | `paged.ts` (`levelHeadings`) |
| Table titles were bold text, not headings | The table title is `role="heading"` (level from the same pass) | `html-common.ts` (paged only) |
| The chart's and the QR code's `<figure>` became a `Figure` without a description around the described picture | `<figure role="group">` in the paged output: the drawing is the one tagged figure, with its description (the chart summary, "QR code for …") | `html-common.ts` (paged only) |
| The page footer was read before the page's content | Fixed items at or below the bottom of the flow area are placed after the flowing content in each composed page; they are positioned absolutely, so nothing moves | `paginator-source.ts`, `paginator-design-source.ts` |
| An image marked as decoration kept its description | A decorative image has an empty description in the paged output, so it is left out of the tags | `html-common.ts` (paged only) |

Title, language and `DisplayDocTitle` were already right (the browser writes them from `<title>` and `lang`).

The web page, email and SMS are not changed (every change is for `mode.target === 'paged'` or in the paged page
source only). The paged renderer versions are now `iss-paged-renderer/1.0.1` (existing documents) and `1.1.1` (page
design); both change only accessibility attributes and the order of absolutely positioned fixed items.

**Proof that nothing visible moved.** The two samples (CARD-0001, CARD-0007, the 250-row statement, EOB-0002,
EOB-0011) and three page-design documents (two and three columns with a background tint and a background picture; A4
with a Last page template and a payment slip; A4 landscape with columns and a Last page) were composed before and
after the change and rasterised with `pdftoppm` at 150 dpi: **30 of 30 pages are pixel-identical**, and the page
trees, diagnostics and extracted facts are identical. The page-design test that composes the 101 sample compositions
with both composers still passes.

### Results on the samples

| Check | CARD-0001 before | CARD-0001 after | EOB-0002 before | EOB-0002 after |
|---|---|---|---|---|
| Tagged | passed | passed | passed | passed |
| Title | passed | passed | passed | passed |
| Language | passed | passed | passed | passed |
| Headings | **failed** (first heading level 2) | passed | **failed** (first heading level 2) | passed |
| Tables | **failed** (continued table without header row, page 2) | **failed** (same; see below) | passed | passed |
| Pictures | **failed** (QR and chart figures without description) | passed | **failed** (chart figure) | passed |
| Links | passed (none) | passed (none) | passed (none) | passed (none) |
| Lists | passed (none) | passed (none) | passed | passed |
| Reading order | **failed** (page footer read first, pages 1 and 2) | passed | **failed** (page footer read first) | passed |
| Contrast | passed | passed | passed | passed |
| Untagged text | passed | passed | passed | passed |

The card's transaction table continues on page 2 without its header row because the sample's table is set to repeat
the header only "when hinted". Repeating it changes how the page looks, so it is not done by the composer: the check
offers the fix "Repeat the header row of “Transactions” on each page" (one undoable command, risk: review, because page
breaks can move); with it applied every check passes. The sample fixtures are not changed.

## The artifact investigation

PDF/UA wants every piece of content either tagged or marked as an artifact (`/Artifact`). Headless Chromium (Skia/PDF
m153, Playwright 1.63, `page.pdf({ tagged: true })`) was tried with:

| Markup | Result in the PDF |
|---|---|
| CSS background on an `aria-hidden` element (the page background) | drawn outside every marked-content sequence; not tagged; **no `/Artifact`** |
| CSS background on a plain element | drawn inside the element's marked content (tagged with it) |
| `<img alt="">`, `<img role="presentation">`, `<img role="none">`, `<img aria-hidden="true">` | drawn outside the tags; no `/Artifact` |
| `<svg aria-hidden="true">` | outside the tags; no `/Artifact` |
| `::before` content text | text drawn outside the tags; no `/Artifact` |
| `aria-hidden="true"` text, `inert` | text drawn outside the tags; no `/Artifact` |
| `@page` margin boxes (`@top-center`), Chromium's own `headerTemplate` / `footerTemplate` | drawn outside the tags; no `/Artifact` |
| `role="doc-pagefooter"`, `<header>`, `<footer>` | tagged as ordinary content (`NonStruct`) |
| `role="img"` with a label on an element with a CSS background | tagged as `Figure` with the label as `/Alt` |

No markup makes this Chromium write `/Artifact` (the decompressed content streams contain only `BDC` sequences for
structure types). Decoration that is hidden from assistive technology is drawn **outside** the structure tree, so
screen readers skip it, which is what matters to a person; but a strict PDF/UA validator is expected to report it as
content that is neither tagged nor an artifact. That is stated as a known limit; only the studio's own PDF writer
could fix it. Running headers and footers stay tagged content (they carry required wording such as "Synthetic
demonstration"), now read after the page's content.

Other findings: Chromium writes `/Title`, `/Lang` (its own default when the page has none), `DisplayDocTitle true`,
`/Tabs /S`, table `/Scope` and `/Headers`, heading levels from `aria-level`, and `Link` elements with an object
reference to the annotation, but no `/Contents` on link annotations (`aria-label` and `title` do not add one), no XMP
metadata, no PDF/UA identifier, no per-element `/Lang`, and no `LBody`. A visually hidden element (clipped) is not in
the tags at all.

## veraPDF

`findVeraPdf` looks at `VERAPDF_PATH` (the program or the folder it is in), then the `PATH`. `runVeraPdf` writes the PDF
to a private temporary folder, runs `verapdf --flavour ua1 --format mrr <file>` with a time limit (2 minutes by
default), reads the machine-readable report (XML: `validationReport isCompliant`, `profileName`, each failed `rule` with
`specification`, `clause`, `testNumber`, `description` and `failedChecks`), and removes the folder. Failed rules come back
as `ISO 14289-1:2014 7.1-3` with veraPDF's own description and a count; rules that fail because of what the browser
cannot write (the PDF/UA identifier and metadata, artifacts, link descriptions) are marked as expected. A run that
times out or returns something that is not a report is reported as such, never as a pass.

**No real veraPDF run has been made**: veraPDF is not installed on the build machine and is never downloaded. The bridge
is tested with stand-in programs: one that prints a report in veraPDF's MRR format (written for the test from the
documented report structure, not recorded from a real run), one that hangs (time limit), and one that prints something
else. The rule numbers matched as known limits follow the PDF/UA-1 profile as documented and should be confirmed on
the first real run.

## The setting, blockers and fixes

`accessiblePdfRequired` on the project (`SET_ACCESSIBLE_PDF_REQUIRED { required }`, one undoable step; absent = off, so
existing documents and their digests are unchanged). Set in Design, Page setup, "Accessible PDF".

- **On**: PDF findings are blocking. The full check (Blockers) runs the PDF part of the accessibility suite for every
  customer (`accessibilityScope: 'pdf'`), so they appear on the Blockers screen as blockers of kind layout and pages.
- **Off**: they are warnings, shown in Validate & Compare and counted in the full check's PDF line, never blockers.

Suggested fixes (`packages/scenarios/src/assist/fixes.ts`): a picture without a description: describe it, or mark it
as decoration (commands); a continued table without its header row: repeat the header row (command); a fixed item read
out of order: list it where it sits on the page (a `MOVE_NODE`, risk review, because the web page and email follow the
list); low contrast: Styles & brand when a brand or text-style colour is the cause, otherwise the component; link text,
typed lists, headings: the place to change them.

## Where it shows

- **Validate & Compare**, accessibility suite: the PDF accessibility part with both levels of proof and when, the
  eleven checks with passed / failed / not checked and what was found, each failure linking to its issue and to the
  component in Design, veraPDF's failed rules when it ran, and the known limits.
- **Blockers**: the full check includes the PDF checks; its summary has a "PDF accessibility, checked by the studio" line.
- **Overview**: the full-check step says how many customers' PDFs failed a check.
- **Releases**: a "PDF accessibility" section in the release detail. The record is made **on demand** ("Check the PDF"),
  not when the release is created: composing and checking a PDF takes a second or more (veraPDF far longer), and
  release creation belongs to `releases.ts`. Each check of a release is added to `release_pdf_checks` (never changed);
  the detail shows the latest, with the level reached, when, the studio's passed and failed counts and veraPDF's verdict
  or "not run". It is composed for the first built-in sample customer of the document's kind (or the document's own
  first customer) and stores the customer id only.

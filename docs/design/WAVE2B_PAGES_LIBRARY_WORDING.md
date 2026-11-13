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

## 2. Accessible PDF, proven

**Where we start.** The PDF is tagged by the browser that composes it. It has never been checked.

**Two levels of proof, always labelled.**

1. **Checked by the studio** (always available). The studio opens the PDF it produced and checks: it is tagged and has a structure tree; it has a title and a language; headings exist and their levels do not skip; every table has header cells; every picture has a description or is marked as decoration; links have readable text; lists are tagged as lists; the reading order of the tags follows the order of the document's parts; text contrast against its background meets the WCAG AA ratio. Each failure names the part of the document and how to fix it there.
2. **Validated by veraPDF** (when the free, open-source veraPDF validator is installed on the machine and the studio is told where it is). The studio runs it against the PDF/UA-1 profile and shows its verdict and the failed rules. The studio never downloads or installs it.

The screen, the release and the release package say which level was reached and when: "Checked by the studio" is not presented as "validated against PDF/UA".

**Making failures matter.** Each document has a setting, "Accessible PDF is required". When it is on, a failed check is a blocker (kind: layout and pages) found by the full check; when it is off, it is a warning.

**Fixing what the checks find.** Where the composed page lacks something (a document title, the language, header cells, a description, decoration marked as such), the page composer is corrected so the tags are right at the source. Nothing is patched into the PDF afterwards.

**Known limit, stated on the screen.** A PDF declares conformance to PDF/UA with an identifier in its metadata, which the composing browser does not write. Until the studio has its own PDF writer, a veraPDF run is expected to report that one rule, and the studio will say so plainly rather than claim conformance.

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

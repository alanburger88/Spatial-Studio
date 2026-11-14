# Bringing documents in, and handing them over

Status: **design for roadmap wave 3 (`docs/ROADMAP.md`). Not built yet.**
Decisions by the product owner on 2026-11-14 (D100): **no target system is named yet, so the neutral parts are built and the first adapter waits**; for rebuilding from a file, **only text and layout go to the AI model, after the person has seen what will be sent and confirmed the file holds no real customer data**.

## 1. Rebuild from an existing PDF or Word file

**What it does.** A person supplies a PDF or a Word (.docx) file of a document they already send. The studio proposes a new studio document: its data fields, layout, messages with their alternatives, and rules. The person reviews and edits the proposal, then creates the document. It builds on "Describe your document": the proposal is the same reviewed setup (`SetupSpec`), built into a project by ordinary commands.

**Steps.**

1. **Read, on the studio's machine.** Text with its position, size and weight on each page (PDF), or paragraphs, headings, tables and lists (Word). Images are noted by position and size; their pixels are not read. Nothing is sent anywhere in this step. Size limits: 20 pages, 10 MB.
2. **What was found.** The studio shows the text blocks, tables and headings it read, and marks likely personal details (names in an address block, account and reference numbers, amounts, dates, emails, phone numbers) so they are easy to see.
3. **Confirm before anything is sent.** The exact text and layout that would go to the model is shown. The person must tick "This file contains no real customer data" to continue with AI. They can instead replace marked values with placeholders first, or continue without AI.
4. **Proposal.** With an AI key: the model proposes fields (values that look like customer data become data fields), which text is fixed wording and which varies, alternatives where the file suggests them, and a page layout. The server validates the model's answer like any setup (D65, D79). Without a key, or if the person chooses: a built-in reading gives headings, text blocks and tables as components, and the person adds fields and rules by hand.
5. **Review and create**, as for "Describe your document", with one addition: a **report of what was not brought across** (images, fonts, exact positions, anything the file implies but the studio cannot know, such as rules that never show in one sample).

**Rules.**

- The file is untrusted input: it is parsed, never executed; macros, scripts, embedded files and external links are ignored and reported. It is not kept after the proposal is made; only the proposal is.
- Nothing from the file is logged. The Activity entry records that a file was read, its kind and page count, and whether AI was used, not its name or content.
- One file shows one customer's version of a document. The proposal says plainly that alternatives and rules cannot be read from a single sample; supplying two or three samples of the same document lets the studio compare them and propose where wording varies.
- A scanned PDF (pictures of pages, no text) is refused with a plain explanation; the studio does not do character recognition.

## 2. Find duplicate wording across documents

**What it does.** Across every saved document and the library's wording, find texts that are the same or nearly the same, so they can be kept once in the shared library.

- **Groups.** Exact duplicates (ignoring case, spacing and punctuation differences) and near-duplicates (a few words differ), each group showing the texts side by side with the differing words marked, where each is used, and which language. Data placeholders are compared by position, not by name.
- **Deterministic and local.** The comparison is a pure function; no AI is needed. The threshold for "nearly the same" is shown and can be changed.
- **Consolidate.** Choose the wording to keep (or edit it), make it a library item (a draft, approved in the usual way), then link it in each document. Linking a document whose text differs changes what its customers read, so each document shows the difference and the customers affected before it is linked, and the change goes through that document's own review. A document in review or approved is not changed in bulk; it is listed with a link to do it there.
- **Where.** A "Duplicates" view in the Library.

**Limit.** It compares wording, not meaning: two sentences that say the same thing in different words are not found.

### As built (duplicate wording)

Routes and shapes: [`docs/api/LIBRARY.md`](../api/LIBRARY.md) ("duplicates", "link-preview", "link-drafts"). Engine: `packages/scenarios/src/assist/duplicates.ts`. Screen: the Library's **Duplicate wording** view (`/library?view=duplicates`, `screens/library/Duplicates.tsx`); no new menu entry or route.

- **Texts.** The wording checker's texts (`wordingTexts`): messages and their alternatives and notices/disclosures by default; labels and headings, email and SMS wording when asked. Texts under 4 words are skipped and counted. English with English; each approved translation with its own language. Library wording items take part with their latest approved version (or their draft).
- **Comparison.** Words in order after removing case, spacing, punctuation, quote style and rich-text formatting; a placeholder is a slot, and a group whose texts differ only in placeholder names says so. Similarity is `2 × (words in common, in order) / (words in both)`, default 0.85, changeable (0.5–1). Identical texts collapse first; near pairs come from a length filter and an index of each text's rarest words (prefix filtering, exact: a unit test compares it with comparing every pair). 5,000 texts take about 0.3 seconds in the unit test (15 pairs compared of 12.5 million).
- **Groups.** A group is the set of wordings joined by near pairs; "exact" when it has one wording, "near" otherwise, so an exact sub-group and its near copies are shown together as wordings side by side. A group needs two different places (documents or library items). The suggested text: the wording used in most places, then most texts, then one already in the library, then the alphabetically first; within it a library item's text, then the placeholder names most texts use, then by id.
- **Keeping.** A draft wording item with the members' own heading and only the translations every member shares exactly (none when the text was edited). Approved in the usual way (an approver can do it from the view).
- **Link here** opens the document and applies `LINK_LIBRARY_ITEM` with `{ partId }` as one undoable, unsaved change, after a dry run that shows the wording before and after, word by word, and who would read something different (`compareVersions`). If another document is open with unsaved changes, it says so and does nothing. Only texts that are messages or notices themselves can be linked (a label or an email line says to change it in the document).
- **Link in all draft documents** exists: it uses the same pure command and the same checks and store call as a save (as restoring a version does), only for draft documents whose message is exactly the library's and for which no synthetic customer would read anything different; it never approves, is audited per document (`library.link`) and reports what it linked and what it refused, with links. **A disclosure is never linked in bulk:** linking raises the disclosure's version number, which its readers see, so it is refused and linked in the document instead.
- **Limit.** It compares words, not meaning (stated on the screen).

## 3. Mapping to the system that produces the documents

**What it is.** A document's data dictionary (every field it reads, with type, format and an example from a synthetic customer) and, per target system, a **mapping**: for each field, the target system's name for it, its type and format there, and any note. No target system is named yet, so the mapping is neutral: a named profile ("Mapping for <system>") that a person fills in or imports.

- **Import the target's field list** (CSV: name, type, description) and let the studio suggest matches (the existing column-matching engine: exact, likely, guess; a guess is offered, never applied silently).
- **Checks.** Fields the document reads that are not mapped; target fields mapped twice; types that do not agree (an amount mapped to a text field); calculated fields listed with their formula in plain words, since the target system must either supply or compute them.
- **In a release.** The release package gains `data/mapping-<name>.json` (and a CSV for people) for each mapping complete at the time of the release, as the package design foresaw.
- **Where.** A "Mapping" tab under Releases.

## 4. Assisted import of wording tables and data dictionaries

- **Wording table** (CSV, or XLIFF as the studio exports it): bring existing wording and translations into a document's messages. Rows are matched to messages by id, then by the English text, with the same exact / likely / guess matching; unmatched rows can become new messages or alternatives. Imported translations are drafts until a person approves them, as always.
- **Data dictionary** (CSV: name, type, description, example): create or extend a document's own data fields from a list, with types checked and examples used for a first synthetic customer.
- Both show what will change before anything changes, and apply as one undoable step.

## 5. First adapter

Not built in this wave. It needs a named system, a sample template export and its field names. The mapping (section 3) is what the adapter will read.

## Phases

1. Rebuild from a file. 2. Duplicate wording. 3. Mapping, and assisted import. 4. Full verification, evidence, report.

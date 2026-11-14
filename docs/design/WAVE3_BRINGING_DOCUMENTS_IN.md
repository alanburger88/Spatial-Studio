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

**As built.**

- *Where.* New project → "Rebuild from a file" (`screens/gallery/RebuildDialog.tsx`): choose one to three files → What was found → What will be sent → the ordinary setup review (`SetupDialog` opened at its review step, with the report of what was not brought across) → create. Creation goes through `/projects/setup` like "Describe your document", with `origin: 'file'` (version label "Rebuilt from a file …", `project.create` detail `from: 'file'`).
- *Reading* (`apps/api/src/importFile.ts`, `docx.ts`): PDF with `pdfjs-dist` (text items grouped into lines and blocks; headings by size and weight against the body size; tables only when two or more lines have columns that line up, otherwise read as text with a note; a two-column label/value layout is read as "Label: value" lines; pictures from the drawing operations, position and size only). Word with a small strict reader of WordprocessingML (styles and heading levels, bold and italic by run, lists by numbering or list style, tables, the section's page size, pictures by their extent; deleted tracked text left out; headers, footers and text boxes counted, not read). Limits: 10 MB, 20 pages, 20 seconds; a Word part above 16 MB unpacked or a lying ZIP header is refused; an XML DOCTYPE is refused. The file's kind is sniffed from its bytes; its name never leaves the browser.
- *Personal details, comparing samples, the outline, the built-in proposal and the report* are pure functions in `packages/scenarios/src/assist/` (`personalDetails.ts`, `alignSamples.ts`, `setupFromFile.ts`, types in `fileReading.ts`). The page and the server compute "what will be sent" with the same `sendOutline`; with AI the server requires `confirmNoCustomerData: true` (else 400 `CONSENT_REQUIRED`, before any model call) and the exact outline the person saw (else 409 `OUTLINE_CHANGED`). With placeholders, every table row is sent as one placeholder row, not only the marked cells.
- *Setup.* `SetupSpec` gained an optional `paper` (US Letter, A4, US Legal), applied with `SET_PAGE_DESIGN`. Without AI no example value is ever taken from the file; samples' differing wording becomes a message chosen by a stand-in choice field ("Message n version"), and a block only some samples have is kept for every customer with a note, since a setup cannot yet express a condition on a whole section.
- *Activity.* One `file.read` entry per proposal (file kinds, page counts, number of marks, fields and sections, whether AI and placeholders were used); reading alone records nothing.
- *Not built.* The report of what was not brought across is shown at review but not stored with the document: the studio has no place for setup notes on a project. Character recognition, images, headers and footers, text boxes and rotated text are not read.

## 2. Find duplicate wording across documents

**What it does.** Across every saved document and the library's wording, find texts that are the same or nearly the same, so they can be kept once in the shared library.

- **Groups.** Exact duplicates (ignoring case, spacing and punctuation differences) and near-duplicates (a few words differ), each group showing the texts side by side with the differing words marked, where each is used, and which language. Data placeholders are compared by position, not by name.
- **Deterministic and local.** The comparison is a pure function; no AI is needed. The threshold for "nearly the same" is shown and can be changed.
- **Consolidate.** Choose the wording to keep (or edit it), make it a library item (a draft, approved in the usual way), then link it in each document. Linking a document whose text differs changes what its customers read, so each document shows the difference and the customers affected before it is linked, and the change goes through that document's own review. A document in review or approved is not changed in bulk; it is listed with a link to do it there.
- **Where.** A "Duplicates" view in the Library.

**Limit.** It compares wording, not meaning: two sentences that say the same thing in different words are not found.

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

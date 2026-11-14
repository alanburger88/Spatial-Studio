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

## 3. Mapping to the system that produces the documents

**What it is.** A document's data dictionary (every field it reads, with type, format and an example from a synthetic customer) and, per target system, a **mapping**: for each field, the target system's name for it, its type and format there, and any note. No target system is named yet, so the mapping is neutral: a named profile ("Mapping for <system>") that a person fills in or imports.

- **Import the target's field list** (CSV: name, type, description) and let the studio suggest matches (the existing column-matching engine: exact, likely, guess; a guess is offered, never applied silently).
- **Checks.** Fields the document reads that are not mapped; target fields mapped twice; types that do not agree (an amount mapped to a text field); calculated fields listed with their formula in plain words, since the target system must either supply or compute them.
- **In a release.** The release package gains `data/mapping-<name>.json` (and a CSV for people) for each mapping complete at the time of the release, as the package design foresaw.
- **Where.** A "Mapping" tab under Releases.

**As built (section 3).** `project.mappings` (`packages/model/src/mapping.ts`, seven undoable commands: add, rename, remove, import a target field list, set, clear and bulk-set entries; checked in project files and drafts; in the project diff and change summary; carried by templates). Checks are the pure `mappingChecks` (`packages/scenarios/src/assist/mappingChecks.ts`); the data dictionary is the one function the package uses, moved unchanged to `@iss/scenarios` (`dataDictionary`). Screen: **Mapping** (S26, Releases section, `/studio/:project/mapping?mapping=<id>`). Differences from the design:
- *What must be mapped:* the fields the document reads or its data contract requires (the dictionary's `needed`), except the kind of document; the columns the document reads of a list that is mapped; calculated fields are listed with their formula in plain words and may be mapped (the target supplies them) but are never required.
- *Complete* also requires that no target field is mapped from two document fields (the design listed it as a check only); the columns of one list are compared among themselves.
- *Gate:* decision 7 of the template design ("a release cannot be approved while a required field is unmapped") is **not** built: with no target system named (D100) an incomplete mapping is left out of the package and said so, and approval is not blocked.
- *Target types* are free text read by `targetTypeKind` (text, whole number, decimal, number, money, date, date and time, yes or no, list, not recognised); the type rules are stated on the screen and in RELEASE_PACKAGE.md. An unrecognised type is never a clash.
- `template.json` carries no mappings; complete ones are `data/mapping-<slug>.json` and `.csv`. A document with no mappings gives the same package bytes as before (tested against the package made at the start of this work).
- Who and when are stamped by the client on each command (`created`, `changed`), so the commands stay pure.
- Lists are mapped as a whole and column by column (`<list>[].<column>`).

## 4. Assisted import of wording tables and data dictionaries

- **Wording table** (CSV, or XLIFF as the studio exports it): bring existing wording and translations into a document's messages. Rows are matched to messages by id, then by the English text, with the same exact / likely / guess matching; unmatched rows can become new messages or alternatives. Imported translations are drafts until a person approves them, as always.
- **Data dictionary** (CSV: name, type, description, example): create or extend a document's own data fields from a list, with types checked and examples used for a first synthetic customer.
- Both show what will change before anything changes, and apply as one undoable step.

**As built (section 4).** Pure engines in `@iss/scenarios`: `wordingImport.ts` (`readWordingFile`, `planWordingImport`) and `fieldsImport.ts` (`planFieldsImport`); the CSV parser is the model's `parseCsv`. Entry points: "Import wording…" on Content & Translations, "Import fields…" in the data fields editor.
- *Wording:* reads the Content & Translations CSV export and the release package's `wording/*.csv` and `wording/*.xlf` as their exact inverse (export → import changes nothing; an edit comes back as exactly that draft), and a plain CSV whose columns are detected (id, English, title, one per language by code or name) and can be changed. Rows match by id, then by English (exact, likely; a guess must be accepted). An unmatched row can become a new message (a message section with that wording at the end of the document) or an alternative of a chosen message. Imported translations are drafts with origin `imported`; the import approves nothing. Skipped with the reason: linked library wording, protected disclosures, fixed wording, the English of labels (edited where they are placed; only messages' English changes, and that can be turned off), and approved translations (optionally added as a draft beside the approved text). A language column the document does not have adds the language. Placeholders are checked against the English and the document's fields, per row. XML with a DOCTYPE or entities is refused. The studio has no XLIFF export of its own outside release packages, so the XLIFF read is the package's.
- *Fields:* only documents with their own data; the built-in kinds say why not. Columns name/label, type, description, example, required (variants recognised). Types are read with a note when they are not obvious (an unrecognised type is read as text and says so; amounts are stored in cents; a list is not imported: it needs its columns). Clashes with existing fields, standard customer fields or earlier rows are skipped with the reason. The studio's fields have no description, so descriptions are shown only. Examples become the fields' examples and, if chosen, one synthetic customer “Example Customer” added through `POST /projects/:id/records` after the document is saved.

## 5. First adapter

Not built in this wave. It needs a named system, a sample template export and its field names. The mapping (section 3) is what the adapter will read.

## Phases

1. Rebuild from a file. 2. Duplicate wording. 3. Mapping, and assisted import. 4. Full verification, evidence, report.

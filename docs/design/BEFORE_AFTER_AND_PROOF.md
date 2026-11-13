# Before & after, and Proof for any customer

Status: **design for wave 1 of the roadmap (`docs/ROADMAP.md`). Not built yet.** Both live under **Releases** in the menu, as tabs beside the release list.

## Before & after

**What it answers.** "If this version replaces that one, what will customers actually see differently, and who?" A reviewer approves what they can see, not a list of edits.

**Choosing the two sides.** "Before" and "After" are each a release of this document or the working version. It opens on the most useful pair: Before = the release in Production (else the latest release), After = the working version when it differs from the latest release, else the latest release. With no release yet, the screen says so and offers the working version against nothing to compare.

**Three parts.**

1. **Who changes.** Every test customer is worked out under both sides by the engine and sorted into: no visible change; wording changes; a different message is shown; something appears or disappears; now stopped by a blocker; no longer stopped. Each group shows its count ("12 of 70 synthetic customers") and its customers. This is exact, not sampled, and takes well under a second for the sample sizes used today.
2. **Side by side.** For the chosen customer and output (PDF pages, web page, email, SMS): Before on the left, After on the right, the parts that differ outlined on both, and beside them the same differences in words ("Payment guidance: showed *Standard reminder*, now shows *Payment support*"). Choosing a difference scrolls both sides to it. For the PDF, a change in the number of pages is stated.
3. **What changed in the document.** The existing change summary (edits to wording, rules, layout, data fields), so a visible difference can be traced to the edit that caused it.

**Where it is offered.** The Releases tab ("Compare with…" on any release), the approval screen ("See what customers will see differently"), and Overview's release step.

**Rules.**

- The comparison is a pure function of two versions and the customers (`packages/scenarios`), so the browser and the server agree and it can be tested without a browser.
- A release side is always the frozen release. The working-version side says "working version, not released".
- Only approved wording is shown for a release side; the working side follows the same draft setting as the rest of the studio and says when drafts are shown.
- Counts of customers say "synthetic".

**Limits, stated on the screen.** It compares what the engine decides and writes for each customer, and shows real pages side by side. It does not compare pixels, so a change that only moves content (for example, a different font size in the brand settings) appears as "layout or style changed for every customer" with the pages to look at, not as a per-part outline. It covers the test customers the document has; "Generate test customers" widens the net. Comparing whole production runs between releases as a gate before Production is held for later (`docs/ROADMAP.md`).

**As built (Before & after).** `apps/web/src/screens/BeforeAfter.tsx` and `screens/compare/*`; browser spec `e2e/before-after.spec.ts`.

- **Sides** are in the address: `?before=r3&after=working` (`r<number>` is a release of this document). The screen opens on the design's default pair and writes it into the address, so a copied link reopens the same comparison. `customer=` and `output=` are kept there too. "Compare with…" on a release (Releases screen) opens `?before=r<number>`; the other side is the working version when it differs from that release, else another release.
- **A release side is the frozen release.** It is fetched with `GET /api/v1/releases/:releaseId/template` (the same content as `template.json`: the frozen project with approved wording only, still carrying the document's id) and sent as `project` to the compose routes. No new route was needed. A release is never composed from the current project. The working side is the project open in the studio (unsaved edits included) and, like the rest of the studio, shows unapproved translation drafts; the screen says so for the chosen customer.
- **Who changes** runs `compareVersions` in the browser over the studio's customers. Groups are in the engine's order, each with "N of M synthetic customers", every group expandable to its customers, a filter box, and "No visible change" collapsed. Nothing is a chart, so the list is its own table alternative.
- **Side by side** composes the chosen customer on both sides with the existing routes (`compose/pages`, `compose/html`, `compose/email`, `compose/sms`; blocked customers are composed as marked drafts so they can still be looked at). Outlines use `data-node-id`, which the paged and the web renderers put on every part: **PDF pages and web page are outlined** (dashed for every part that differs, heavy solid for the chosen difference; the web page is shown in a frame that runs no scripts so it can be read and scrolled). **Email is shown side by side without outlines** (email parts carry no component ids) and the screen says so; **text message** is plain text with the changed words marked. Both panes scroll together; choosing a difference scrolls both to the part. A change in the PDF page count is stated.
- **Differences in words** come from the engine's `changes`; wording changes mark the changed words (`compare/wordDiff.ts`, display only).
- **Part 3** calls `summarizeChanges` on the two projects when the section is opened.
- Not built: comparing pixels, AFP, and comparing whole runs (all stated on the screen).

## Proof for any customer

**What it answers.** A customer, an auditor or a regulator asks: what was this person given, from which approved version, and why?

**Decision (product owner, 2026-11-13): a proof record keeps fingerprints and decisions, not the data.** The contract is `packages/resolver/src/proof.ts`:

| Kept | Not kept |
|---|---|
| The release (document, number, fingerprint) and engine version | The customer's data |
| When it was produced, and by what (studio or runnable package) | Any value tested by a rule |
| The producing system's reference for the customer | The produced files |
| A fingerprint of the customer's data | |
| Which alternative each part showed and which rules decided it | |
| A fingerprint of the content and of each output | |
| Whether it was produced, or stopped and by which kind of issue | |

**Where records come from.**

- **The runnable package** writes one per document to `proof.jsonl` in the system that runs it. An operator can bring that file into the studio ("Add proof records").
- **The studio**, when it produces documents from a release: "Produce from this release" on a release, for one test customer or all of them.

A record is only ever added. Reading a file treats it as untrusted: every line is checked (`proofRecordProblems`), a record with any field beyond the contract is refused, and a record for a release the studio does not know is kept but marked "release not known here".

**Looking one up.** Search by customer reference, release, date, proof number or run number. The record shows, in plain words, what was produced and when, the release with a link, and why: for each part of the document, the message shown and the rule that chose it, named from the frozen release. No customer values appear, because none are held.

**Re-create and verify.** Supply the data again (pick the test customer with that reference, or a JSON file). The studio then answers one of:

- **Same data, same release, same result.** It shows the re-created document and the full explanation, now with values, since the data is at hand for this check. The supplied data is not stored.
- **Not the same**, and exactly what differs: not the data the document was produced from; a part shows a different message; the content differs; an output's fingerprint differs.

Email, SMS and web page are compared byte for byte. PDF files differ byte for byte between runs, so the PDF is compared by the content it was composed from and its page count.

**Rules.**

- Nothing in this feature stores customer data. Tests scan stored records for the values of the customers they were made from.
- Only people who can see the document can see its proof records; adding records needs the approver or admin role; nobody can edit or delete one. (A reset exists for tests only, as for releases.)
- The customer reference is an identifier chosen by the producing system. The studio says so where it is shown, and the runnable package can be told to use a reference of the operator's choosing.

**Limits, stated on the screen.** A proof record shows what was produced, not that it was delivered. It is not an archive: the document can be re-created only when the data is supplied again and the release still exists. Retention rules and legal holds are not part of it.

**As built (Proof).** Server: `apps/api/src/proofs.ts`, `apps/api/src/routes/proofs.ts`; routes and shapes in `docs/api/PROOFS.md`. Screen: `apps/web/src/screens/ProofLookup.tsx` and `screens/proof/*`; "Produce from this release" in the release detail (`screens/releases/ProduceSection.tsx`). Tests: `apps/api/test/proofs.test.ts`, `e2e/proof.spec.ts`.

- **A release side is the release template** (the frozen approved version with unapproved translation drafts stripped, the package's `template.json`), resolved with the `paged-pdf` profile and fingerprinted exactly as the runnable package does (web page, email HTML and SMS by their bytes; the PDF by its page source and page count). So a `proof.jsonl` from the runnable package verifies as "same" in the studio. A release approved while it had drafts would give a different run id from the stored project; a test pins that the template is used.
- **Storage** is one add-only table (`proof_records`) whose triggers refuse any update and any delete outside the test reset (`PROOFS_RESET=allow`). A proof id already stored adds nothing (reported as already known, or as a conflict when the content differs). "Release not known here" is worked out when a record is read, also for a release id this studio has with different content.
- **Producing** runs inline, not through the batch runner: up to 500 test customers without the PDF, 20 with it, one request at a time. The produced files are not kept anywhere; only the records are.
- **Adding from a file** is a dry run by default (new, already known, refused and why), then the real import. Records with any field beyond the contract, including inside a decision or an output fingerprint, are refused.
- **Checking** takes a test customer or the data as JSON, and optionally another release to compare with. "Same" answers include the explanation with values and the re-created web page, email and SMS, in that answer only; the PDF is compared by content and page count, not shown. The data is not stored or logged; the audit entry says only that a check happened and its verdict.
- **Looking up** searches the open document by default ("Every document" widens it), by customer reference, release, dates, and part of a proof or run number; the newest record is pre-selected. Parts, messages and rules are named from the release; codes appear in Technical view.
- Not built: sign-in-specific views of who may see which document (every document is visible to everyone signed in), a runnable-package reference chosen by the operator (that is the package's side), retention.

# Roadmap: from proof of concept to a product that leads

Status: **proposed order, awaiting the product owner's approval. Nothing in this document is built unless it says so.**
Written 2026-11-13 after a critical review and ten decisions taken one by one with the product owner.
A researched comparison with named competitors is being written alongside (`docs/research/COMPETITORS.md`); claims below about competitors are from general knowledge until that lands, and are marked *(to confirm)*.

## The critical review in brief

**Where the studio is already strong**

- **It can explain itself.** For any customer it says which message was chosen and why, in plain words, and shows every alternative (Exploded, Cube, Landscape). Template tools generally show the result, not the reasoning *(to confirm)*.
- **Testing is built in and confirmed by the engine.** Coverage gaps, generated test customers with edge values, pinned tests, journeys, and a Blockers list with the effect of each fix shown before it is applied.
- **The assistant proposes; people approve.** Every suggestion shows its effect on all customers, is one undoable step, and is labelled built-in or AI.
- **Outputs are deterministic and releases are frozen.** PDF, web page, email and SMS come from one model with parity checks; a release is a self-describing package.

**Where it is weak**

- **It is a local proof of concept.** Nothing is deployed, nothing larger than about 100 customers has been tried, only one browser has been tested, and there is no automated build.
- **Page design and print are thin.** One page model, a fixed letterhead zone, no master pages or columns; AFP is a simulation; the PDF is tagged by the browser but has never been checked against the accessibility standard; no mailing barcodes; left-to-right Latin languages only.
- **Rules and data are simple.** No calculations, no dates that switch wording, no rate tables, one level of list.
- **Wording lives in one document at a time.** No shared library, no brand or regional variants, no house rules enforced.
- **There is no way in for existing documents.** Every template has to be rebuilt by hand.
- **Teamwork is basic.** Nobody is notified, reviewers need an account, two editors collide on save.
- **Eighteen screens and no guided path.**
- **Live AI has been seen on screen for four flows only.**

## What was chosen

| # | Area | Chosen |
|---|---|---|
| 1 | Competitors | Research named products and write a comparison, alongside the work |
| 2 | Signature strengths | Proof for any customer · Before and after, visually · Ask questions of the whole base · Message experiments |
| 3 | Bringing documents in | Rebuild from an existing PDF or Word file (AI) · Find duplicate wording across documents |
| 4 | Page and print | Page design depth · Accessible PDF, proven · Print production features · More languages (right-to-left, East Asian) |
| 5 | Rules and data | Calculated fields · Effective dates · Lookup tables · Richer data shapes |
| 6 | Content | Shared library now · Wording rules and checker · Variants by brand or region |
| 7 | Teamwork | Proof links for reviewers · Notifications and assignments · See who else is editing |
| 8 | Readiness | Runnable package now |
| 9 | Navigation | Document home with next steps · Fewer, grouped screens · New guided tour and help |
| 10 | How | Roadmap first, then build in waves, with a verified report after each wave |

Already agreed and carried into the waves: **blockers phases 2–6** (`docs/design/BLOCKERS.md`) and **template phases 3–7** (`docs/design/TEMPLATES_AND_CCM.md`).

## Not chosen, and what that leaves open

- **Scale and speed test.** Without it, any claim about large documents or large customer bases is unproven. Recommended before the studio is described as production-ready; the runnable package (wave 1) includes a throughput test of its own, which covers producing documents but not the studio's screens.
- **Security and operations plan** (single sign-on, API keys for other systems, encryption, backups, automated build). Needed before any deployment; deployment itself needs explicit approval.
- **Studio accessibility and other browsers.** Only Chromium has been tested and no screen-reader pass has been done.
- **Four-eyes approval.** Today a person with the right role can approve their own change.

## Waves

Sizes: S = about a day of build and verification, M = a few days, L = a week or more of equivalent effort. Each wave ends with the full gate, evidence, and a report of what was and was not verified. Items in a wave are built in parallel where they touch different parts of the studio.

### Wave 1 — Trust, proof and finding your way

The things that make the studio unlike a template tool, plus the navigation they will live in.

| Item | Size | Why first | Depends on |
|---|---|---|---|
| Document home with next steps | M | Every later feature needs a place to surface; a new user gets a path | — |
| Fewer, grouped screens (about eight menu entries, tabs inside) | M | Done before more screens are added, not after | Document home |
| Blockers phase 2: data problems (open in Data Explorer, known data problem) | M | Agreed; completes the blocker story for approvals and releases | Blockers screen (built) |
| Blockers phase 3: resolve one by one, pin a test when fixed | M | Agreed; turns a list into a workflow | Phase 2 |
| Before and after, visually (two versions or releases as pages, differences highlighted, customers visibly affected) | M | Reviewers approve what they can see; no rebuild needed | Releases (built) |
| Proof for any customer (what was sent, when, from which release, why) | M | For complaints, audits and regulators; builds on releases and the engine's explanations | Releases (built) |
| Runnable package (template phase 7): the engine and a release in one self-contained package with a proof pack and a throughput test | L | The precision guarantee: another system produces exactly what was approved | Releases (built) |
| New guided tour and help | S | After the navigation settles | Navigation |

### Wave 2 — Real documents

What a production statement, bill or letter needs that the samples do not.

| Item | Size | Notes | Depends on |
|---|---|---|---|
| Calculated fields (arithmetic, days between dates, joined text, counts and sums of rows) | L | Usable in rules, wording and tables; deterministic, no free-form code | — |
| Effective dates (wording and rules from/until a date; preview "as issued on") | M | Changes what a release means on a given day; the release package must state it | Releases |
| Lookup tables (rate by tier, notice by state) | M | Versioned with the document | Calculated fields |
| Page design depth (master pages, resizable letterhead zone, backgrounds, columns, keep-together) | L | The page composer's biggest change so far | — |
| Accessible PDF, proven (checked against PDF/UA; failures become blockers) | M | Needs a checker; the studio's own checks first, an external validator if one can be bundled | Page design |
| Shared library (template phase 4) | L | Brand, header and footer, notices, common messages; pinned versions; impact list on update | — |
| Wording rules and checker (required and banned phrases, reading level, tone; AI review) | M | Failures can be blockers | Shared library for where the rules live |

### Wave 3 — Bringing documents in, and handing them over

| Item | Size | Notes | Depends on |
|---|---|---|---|
| Rebuild from an existing PDF or Word file (AI) | L | Builds on "Describe your document"; always produces a report of what was not brought across | Setup from a description (built), page design depth |
| Find duplicate wording across documents | M | Consolidates into the shared library | Shared library |
| Data dictionary and mapping per CCM (template phase 3) | M | Needs the first target CCM's name and field names | Releases (built) |
| Assisted import of wording tables and data dictionaries (template phase 5) | M | The non-AI half of import | Phase 3 |
| First CCM adapter (template phase 6) | L | Needs a named CCM and sample files | Phase 3 |

### Wave 4 — Teams

| Item | Size | Notes | Depends on |
|---|---|---|---|
| Proof links for reviewers without an account | M | A new, deliberately narrow kind of access; needs a security design before build | Before and after |
| Blockers phase 4: owner, status and notes | M | Agreed | Blockers phase 3 |
| Notifications and assignments (in-app; email needs a mail service) | M | Email is an external service: needs approval to configure | Blockers phase 4 |
| See who else is editing | M | Presence and a warning before two people edit the same component | — |
| Blockers phase 5: AI drafts for wording blockers | S | Agreed | Wording checker |
| Blockers phase 6: warn before saving | S | Agreed | — |
| Ask questions of the whole base ("who gets the hardship message and why?") | M | Answered by the engine; the AI only turns the question into a query | — |

### Wave 5 — Reach and depth

| Item | Size | Notes | Depends on |
|---|---|---|---|
| Variants by brand or region (inheritance from a base document) | L | Changes the document model; needs its own design workshop | Shared library |
| Richer data shapes (nested records, more than one level of list) | L | Touches rules, tables, Data Explorer, generation and import | Calculated fields |
| Print production features (mailing barcodes, OMR marks, duplex and tray, inserts) | L | Needs a print partner's requirements to test against | Page design depth |
| More languages (right-to-left, East Asian) | L | Fonts, line breaking, mirrored layout; needs native reviewers | Page design depth |
| Message experiments (A/B versions designed in the document) | M | The studio designs and assigns; results come from the producing system | Runnable package |
| Native AFP writer | L | Recorded direction: only once a print partner is named | Print production features |

## What I need from the product owner

1. **Approval of this order**, or the changes you want to it.
2. **For wave 3:** the name of the first target CCM, and a sample of its field names and a template export.
3. **For wave 4:** whether a mail service may be configured for email notifications (an external service), and agreement to a short security design for proof links before they are built.
4. **For wave 5:** a print partner for the print features and AFP, and native reviewers for new languages.
5. **A decision on the four items not chosen**, at least the scale test, before anything is called production-ready.

## How each wave is run

- A check-in at the start of the wave for decisions that are genuinely yours, taken one by one with options.
- Parallel builders on separate parts, each verified by its own tests, then the full gate on the combined result.
- A report after the wave: what works, with screenshots; what was not verified; what needs you.
- Automated tests never use the live AI key; live checks are run on purpose and counted.

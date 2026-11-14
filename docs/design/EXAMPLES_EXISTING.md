# What was added to the two original examples

Decision D106 (2026-11-14): enrich "Aster Card" (`aster-card-demo`, credit-card statement) and "HarborCare"
(`harborcare-demo`, explanation of benefits) **in place, additively**. Every existing component, rule, message and
customer is kept exactly as the fixtures build it; the approved pack's files (`fixtures/**`, `contracts/**`, `tests/**`,
`oracle/**`, `scripts/verify_pack.py`, `scripts/verify_app.py`, `ASSET_MANIFEST.json`) are not touched.

This is the detailed record. What each of the four examples shows, side by side, is in
[`EXAMPLES.md`](EXAMPLES.md) (the feature matrix).

Code: `packages/model/src/samples/showcaseExisting.ts` (`enrichCard`, `enrichEob`, `enrichSamples`: pure, every addition
made through `applyCommand`, deterministic, the sample keeps its version number) and
`packages/model/src/samples/showcaseExistingAudit.ts` (the description of each example for the examples' accuracy check,
and the domain arithmetic). Tests: `packages/model/test/showcase-existing.test.ts`,
`apps/api/test/showcase-existing-pdf.test.ts`.

## Where the enrichment is applied, and why

`packages/model/src/fixtures.ts` keeps `seedProjects()` exactly as before (the fixture-built projects) and adds
`sampleProjects()` = `enrichSamples(seedProjects())`. The server stores and resets to `sampleProjects()`
(`apps/api/src/db.ts`, one import line; `apps/api/src/translate.ts` the same, so the bundled Spanish sample drafts are
offered for the new texts).

The first option (enrich inside `seedProjects()`) was tried: the goldens held, but `seedProjects()` is also the seed of
the built-in starters (`apps/api/src/routes/templates.ts` registers it): every new "Credit card statement" and "Blank
letter" document would have inherited the card's wording rules, mapping and calculations, and a blank letter would then
break the card's "must" rule ("not a legal statement"). About 45 unit tests also use it as "a document without these
features". So the oracle's base stays the fixtures, and the goldens are run against the enriched samples by
`showcase-existing.test.ts` (the same twelve cases, the same eight keys and the result digest), together with a
customer-by-customer comparison: **all 100 fixture customers get exactly the same core result before and after.**

## What each approved check compares

| Check | Compares |
|---|---|
| `packages/resolver/test/golden.test.ts` (12 oracle goldens) | For each case of `fixtures/expected_scenarios.json`, on `seedProjects()` (with the case's overrides and rule patches): `recordId`, `documentType`, `selectedVariants` (Variant Sets only), `matchedRuleIds`, `additiveRuleIds`, `requiredNodes`, `diagnostics` (code, severity, nodeId, locale, ruleIds of every non-info finding from the resolver, domain and binding sources, except `TRANSLATION_MISSING_OPTIONAL`), `documentFacts`, and the SHA-256 `resultDigest` of those. Plus: the source record is not mutated, run ID and content digest are deterministic. |
| `scripts/verify_pack.py` | The pack itself (fixtures, contracts, oracle, schemas, manifest hashes). Never reads the app. |
| `scripts/verify_app.py` against the running app | Health; both sample ids listed; for the 11 cases without rule patches, `POST /api/v1/resolve` → the same eight keys as the goldens (not the digest); `compose/pdf` of CARD-0001: `%PDF-`, > 2,000 bytes, ≥ 1 page, text contains "1,248"; `compose/html`: contains `<html`, `<table`, `<script`; the 250-row case: more than one PDF page and the text holds STRESS-0001 and STRESS-0250; the AFP route says `simulationOnly: true`; the web app answers `/projects`. |
| `tests/e2e/screen_routes.spec.ts` | Each screen of `contracts/SCREEN_CONTRACT.json` on `aster-card-demo`: `main` visible, the first required test id visible, the heading. |
| `tests/e2e/critical_path.spec.ts` | Design canvas, `node-payment-guidance`, "Explore variants", exploded view and back; a real PDF of CARD-0001 (200, `%PDF-`, > 2,000 bytes). |

Therefore nothing added may be a rule (it would join `matchedRuleIds`), a Variant Set (it would join
`selectedVariants` and, for the Spanish customers, `REQUIRED_TRANSLATION_MISSING`), a required component or text
(`requiredNodes`, Spanish obligations), and no calculation may be missing for any fixture customer or scenario (that
would add `CALCULATION_MISSING` / `LOOKUP_NO_MATCH`), and no document date may be missing (`DOCUMENT_DATE_MISSING`).
Everything below is expressed as inline conditions on **new** conditional sections, a `visibleWhen` on a new text,
calculated fields, wording, periods, layout and project settings.

## Aster Card (credit-card statement)

- **The document's date**: the statement issue date (`card.issuedAt`), which all 70 customers have (1 Nov 2026).
- **Lookup table** "Late fee by account tier" (exact text key: standard $29.00, premium $25.00; also a returned-payment fee),
  linked from the house library item "Card late fees by account tier" (read-only in the card).
- **Calculations**: days until the payment is due (`DAYS(ISSUE_DATE(), card.dueDate)` = 24), total of the listed
  transactions (`SUM`), largest transaction (`IF(count > 0, LARGEST(…), $0.00)`), available credit as a percentage of the
  limit (`ROUND(available ÷ limit × 100, 0)`, guarded by `IF` against a zero limit), late fee if the payment is late
  (`IF(arrangement approved, $0.00, LOOKUP("lateFeeByTier", "lateFee", card.tier))`).
- **New wording**, all placed **after the transaction table** so the first page and the table's pages do not move
  (CARD-0001's page 1 is pixel-identical; the 250-row case keeps 8 pages and its continued headings):
  - a one-sentence spending summary under the table (text with `visibleWhen` at least one transaction);
  - "When to pay": a conditional section with two alternatives chosen by inline conditions (payment due and a late fee,
    or payment due under an approved arrangement: no late fee);
  - two dated notices before the disclosures: "Paying by mail over the holidays" (paper-statement customers, in effect
    **until** 5 Jan 2027) and "Your cardholder agreement is changing" (in effect **from** 1 Dec 2026: shown only "as
    issued on" a later day).
- **Table footer**: the transaction table's total is the calculated "Total of the listed transactions" (the same sum).
- **Email**: an opening line "You have {{calc.daysUntilDue}} days to pay…". The SMS is unchanged (sized to one message).
- **Wording rules** (the document's own): one "must" already met (required "not a legal statement"), three "should":
  banned "kindly", sentences of at most 25 words, and banned "relationship specialist" → "relationship team", which the
  existing relationship-team message breaks: **the one deliberate "should" finding** (a banned phrase is "review
  first", so "Fix all safe issues" leaves it).
- **Mapping for the print house**: complete (every field and list column, with target types and "divide by 100" for
  amounts; booleans as BOOLEAN).
- **Pinned tests** (7, all passing): up-to-date by email, premium asking for help, approved arrangement (no late fee),
  Spanish customer stays blocked, paper statement with the holiday notice, and two "as issued on" tests (15 Dec 2026,
  10 Jan 2027).
- **Spanish**: labelled sample drafts for every new text (never approved by code).

## HarborCare (explanation of benefits)

- **Lookup table** "Review time by billed amount" (number range in money: under $500 → 30 days, $500 and over → 45),
  linked from the house library item "Claim review time by billed amount".
- **Calculations**: member's share of the billed amount (%, `IF` guarded against a zero bill), total plan paid across
  claims (`SUM(claims.planPaidCents)`), number of claims (`COUNT(claims)`), days a review usually takes (`LOOKUP`).
- **New wording**: "Claim summary" after the claim details table: processed claims "Your plan paid … Your share is
  12.5% …"; claims under review "How long the review takes: … up to 30 days. No amount is shown for you until it is
  done." Never debt language; the member share appears only where liability is confirmed.
- **Page design**: a light stationery tint behind the first page (decoration: never read out, not in the web page,
  email or SMS), and "keep together" on the four claim amounts. **Accessible PDF is required**: every one of the 30
  customers' PDFs passes all eleven studio checks (tested).
- **Email**: an opening line "Claims in this explanation: {{calc.claimCount}}…".
- **Wording rules**: one "must" already met (required "this is not a bill"), three "should": prefer "member
  responsibility" to "patient responsibility" (broken by the approved "Claim totals" disclosure: **the one deliberate
  "should" finding**, left to a person because it is a disclosure), banned "insurance company", sentences of at most 25 words.
- **Mapping for the print house**: complete.
- **Pinned tests** (5, all passing): covered, under review (amount guarded), out of network, deductible, appeal.

## What was deliberately not added, and why

- **Rules, new messages of an existing Variant Set, required parts**: each would change the oracle's matched rules,
  selected variants, required parts or diagnostics.
- **Approved Spanish**: approving would be done by code, which the studio never does; and the six Spanish card customers
  are blocked on purpose (Blockers, Translations and the guided demo show them). New texts have sample drafts only.
- **Dates on the explanation of benefits** ("days since the service date", dated notices): the EOB data has no issue
  or processing date. Using the service date as the document's date would make "days since the service date" always 0;
  a new date field would be missing for every fixture customer (a blocker) and fixtures may not change. The
  number-range lookup is used instead (review time).
- **Card page design** (Last page template, tint, keep-together) and **"Accessible PDF is required" on the card**: the
  card's continued table fails the header-row check until its suggested fix, which changes pagination; the 250-row case
  (AT-18, AT-19, `verify_app.py`) and the Page panel browser tests (PD01–PD03: they start from the card's original page
  design) rely on the card's pages as they are. The EOB carries the page-design features instead.
- **A table footer on the claims table**: its footer sums the billed column; a calculated total there would put another
  amount under the "Billed" heading.
- **SMS wording**: the sample SMS is sized to one 160-character message and has sample Spanish drafts for its text.
- **The library glossary on the card**: the card keeps a glossary of its own (empty). `e2e/assist-writing.spec.ts`
  shows a document's own glossary being edited on the card sample (the only place with bundled Spanish drafts for
  every text), and a linked glossary is read-only. HarborCare links the library glossary instead.

## Visible changes

- Card: page 1 unchanged; after the table, one sentence and the "When to pay" box; paper-statement customers also get the
  holiday notice. Page counts of the customers checked are unchanged (CARD-0001 2, CARD-0002 3, the 250-row case 8).
- EOB: a light tint on page 1; the claim summary under the claim table. Claims under review (11 customers) now run to
  two pages ("Questions" and "Claim totals" move to page 2), as processed claims already did.

## Links to the house library

Made in the enrichment (`linkHouse` in `showcaseExisting.ts`, `LINK_LIBRARY_ITEM` with exactly the library's content,
as Northwind and Meridian do). Two items are new in `houseLibrary.ts`, taken from the examples' own tables.

| Example | Linked | Not linked, and why |
|---|---|---|
| Aster Card | House wording rules (v1); "Card late fees by account tier" (v1, new) | The Spanish glossary (see above). The brand, footer, header and disclosures: a brand link would replace the card's brand kit, and a block or wording link would change component ids or raise a disclosure's version number, which the oracle and the browser tests read. |
| HarborCare | House wording rules (v1); Spanish glossary (v1); "Claim review time by billed amount" (v1, new) | As for the card: brand, banner, "Terms explained" and the "Claim totals" disclosure. |

Evidence (`packages/model/test/showcase-existing.test.ts`, "links to the house library"):

- **The same document for every customer.** All 100 fixture customers and all twelve oracle scenarios resolve exactly
  as they do with the links removed (findings, selected parts, the tree, calculations, the semantic manifest, email and
  SMS texts, the content digest). Only the run id differs, because it is a hash of the document, which now holds the links.
  The paged and web renderings were compared too (before and after the change): identical apart from the run id.
- **No new finding.** The approved fixture wording meets every house "must" rule (no "click here", no "guaranteed",
  and each names its issuer as "(fictional)"), and no house "should" rule finds anything: the only wording finding of
  each example is still its own deliberate "should". The blocked card customers are still exactly the six.
- **Unchanged pages and results.** The twelve goldens and the before/after comparison of all 100 customers pass; the
  250-row case is 8 pages, as on the fixtures' card, and page 1 of CARD-0001, CARD-0002 and the 250-row case has the
  same components and the same text as on the fixtures' card, apart from the run id
  (`apps/api/test/showcase-existing-pdf.test.ts`; the accuracy check's outputs also compose the 250-row case). Pixels
  were not compared in this pass.
- **An emptied library.** With `LIBRARY_RESET=allow` and the library reset, both examples open on every screen
  without errors; a linked table says "Not in this library" and can only be unlinked (the same as Northwind).

## The accuracy check

Both examples are registered in `scripts/audit-examples.ts` with the fixture customers of their kind, and every check
runs on them (`reports/EXAMPLES_AUDIT.md`). The notes are `CARD_NOTES` and `EOB_NOTES` in `showcaseExistingAudit.ts`;
the domain check is `cardArithmetic` / `eobArithmetic` (also over the oracle scenarios with overrides, where
`DELIBERATE_SCENARIO_FINDINGS` lists what is meant); the calculations are recomputed independently in the script.
Generalised for the built-in kinds: the languages are the document's languages (English and Spanish when it lists
none); a "—" between two words is punctuation, not a missing value; "as issued on" does not apply to a document with no
date; the released-version check does not apply to a document seeded without a release; and the card's PDFs are
checked as if an accessible PDF were required, with the continued table's missing header row stated as a known limitation.

## Arithmetic of the fixture customers (`showcaseExistingAudit.ts`)

- Card (70): new balance = previous + purchases − payments + fees; listed transactions = purchases; minimum ≤ new
  balance; statement start ≤ end ≤ issue ≤ due date; transactions inside the period; payment state consistent. **No
  finding** on any of the 70.
- EOB (30): billed = adjustment + allowed; allowed = plan paid + member responsibility; deductible ≤ member
  responsibility. **11 findings, all intended**: the claims denied pending review or under appeal (EOB-0002, -0004,
  -0005, -0010, -0011, -0016, -0017, -0022, -0023, -0028, -0029) have nothing allowed and the whole bill under review
  (billed = adjustment + allowed + under review).
- Oracle scenarios: card-inconsistent-payment-state (payment state) and eob-unconfirmed-liability (allowed ≠ plan paid +
  member responsibility) are the deliberate inconsistencies; card-250-rows' stress rows sum exactly to purchases;
  card-tie-defect is a rule patch, not data.

## Test expectations changed (each deliberately; no assertion loosened)

| Test | Before | After | Why |
|---|---|---|---|
| `e2e/acceptance.spec.ts` AT-36 | 30 components after reset | 34 | four new components on the card |
| `apps/api/test/issue-date-routes.test.ts` "a document that does not use dates…" | card / CARD-0001 | EOB / EOB-0001 | the card has a date now; the EOB has none |
| `apps/api/test/mapping-release.test.ts` | release mappings [Core, Print House] | [the print house (complete), Core, Print House]; its file is in the package | the card sample carries a complete mapping |
| `apps/api/test/releases.test.ts` frozen template | equals the approved project | equals it without `mappings` | `template.json` never carries mappings (D104), the sample now has one |
| same, release digest after edits | `projectContentDigest(template)` | digest of the frozen project; frozen minus mappings = template | as above |
| same, package layout | no `data/mapping*` file | exactly the print-house `.json` and `.csv` | complete mapping is handed over |
| same, data dictionary | `card.transactions` used by `card.transactions.count` | … and `calc.listedTotal` | new calculation reads the list |
| same, scenarios | every cover is an outcome | date-boundary scenarios excluded from the outcome count (and checked to carry their date) | the card has date boundaries now |
| same (3 places), re-resolving a scenario | without its date | with the scenario's `issueDate` | dated scenarios are produced "as issued on" their day |
| `apps/api/test/runnable-package.test.ts` | reference lines `{customerRef, data}`; frozen copy run ID = package run ID | lines carry the scenario's `issueDate`; frozen copy without mappings = package run ID | dated scenarios; template.json leaves the mapping out |
| `apps/api/test/wording-rules.test.ts` | own rules [plain, claim-word]; prompt with one rule; "no wording rules" on the card sample | the EOB's four own rules first; prompt lists the card's four rules first; a new card from the starter / the fixture card | the samples have own wording rules |
| `e2e/calculations`, `lookup-tables`, `dates` (card), `mapping`, `wording-rules`, `wave2-links`, `rules` (pin test), `channels-editor` (defaults) | the stored sample | a new document from the built-in starter (`plainCopy` in `e2e/helpers.ts`) | their subject is a document without these features; the samples now have them |
| `e2e/channels-editor.spec.ts` unknown token | channels stay `null` | channels stay as they were | the card sample has its own email wording |
| `e2e/blockers-resolve.spec.ts` BR01, BR04 | no pinned tests before; one after | the sample's own tests before; exactly one new "Stays fixed" test after | the samples have pinned tests |
| `e2e/pdf-accessibility.spec.ts` PA03 | box unchecked, check, undo | box checked, uncheck, undo | accessible PDF is required for the EOB |
| `apps/api/test/examples-audit.test.ts` | two examples, 30–40 customers, at least one blocker each; outputs and accessibility pass for all | four examples (the original two with 70 and 30 customers, six and no blockers); the card's accessibility is an intended exception (known limitation) | the original examples are checked too |
| `apps/api/test/library.test.ts` (where used, impact, link shapes, templates and files) | the card's first link is the one the test made; the release lists only the brand | links found by item; the EOB's release also lists its three sample links, "not in the library" in that studio | the samples link house items; that test studio has no house library |
| `apps/api/test/library-duplicates.test.ts` | a copy of the card has no links | it has the card's two sample links, then the new one | as above |
| `apps/api/test/wording-rules.test.ts` (release record, prompt) | no house rules on the EOB; the prompt lists the card's own rules | the release records the house rules (6, v1); the prompt lists the six house rules first | the samples follow the house wording rules |
| `apps/api/test/samples-seed.test.ts` | glossary and house rules used by two documents | house rules by four, glossary by three; each new table by one | the original examples link them |
| `e2e/library.spec.ts` LB02, LB03 | a copy of the card holds only the block and wording links | the card's two sample links come first; the test's own links are checked apart | as above |
| `e2e/library-duplicates.spec.ts` DU02 | the copy's only link is the new wording | the card's two sample links, then the new wording | as above |

## Defect found and fixed

- `apps/api/src/proofs.ts`: a proof's explanation named a section's own inline condition (`claim-summary:summary-confirmed`)
  by its id instead of in words (`inlineConditionWords`). It already affected the card's high-volume note; the EOB's new
  claim summary made the existing proofs test see it. Covered by `apps/api/test/proofs.test.ts` ("explains each part with
  names…", every rule title differs from its id).

## Observation (not changed)

A document with a mapping resolves to a different run ID from its stored copy than from `template.json`, because the
project digest includes the mapping and `template.json` leaves it out. Every release route resolves on the template, so
proofs and packages agree; only a direct run of the stored frozen copy differs.

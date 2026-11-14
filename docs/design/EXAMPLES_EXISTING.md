# What was added to the two original examples

Decision D106 (2026-11-14): enrich "Aster Card" (`aster-card-demo`, credit-card statement) and "HarborCare"
(`harborcare-demo`, explanation of benefits) **in place, additively**. Every existing component, rule, message and
customer is kept exactly as the fixtures build it; the approved pack's files (`fixtures/**`, `contracts/**`, `tests/**`,
`oracle/**`, `scripts/verify_pack.py`, `scripts/verify_app.py`, `ASSET_MANIFEST.json`) are not touched.

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
- **Lookup table** "Late fee by account tier" (exact text key: standard $29.00, premium $25.00; also a returned-payment fee).
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

- **Lookup table** "Review time by billed amount" (number range in money: under $500 → 30 days, $500 and over → 45).
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
- **Library links**: not in this pass (see below).

## Visible changes

- Card: page 1 unchanged; after the table, one sentence and the "When to pay" box; paper-statement customers also get the
  holiday notice. Page counts of the customers checked are unchanged (CARD-0001 2, CARD-0002 3, the 250-row case 8).
- EOB: a light tint on page 1; the claim summary under the claim table. Claims under review (11 customers) now run to
  two pages ("Questions" and "Claim totals" move to page 2), as processed claims already did.

## Should link to the house library later

- Card: the Aster brand (colours, logo `asset:aster-mark`), the page footer and document header, the "Demonstration
  disclosures" disclosure, the "Paying by mail over the holidays" notice, the "Late fee by account tier" table, the
  wording rules ("not a legal statement", "kindly", sentence length), the Spanish glossary.
- EOB: the HarborCare brand, the page footer and the "THIS IS NOT A BILL" banner, the "Terms explained" glossary
  explanation, the "Claim totals" disclosure, the "Review time by billed amount" table, the wording rules ("this is not a
  bill", "insurance company").

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

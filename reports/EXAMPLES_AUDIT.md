# Examples audit

Written by `npx tsx scripts/audit-examples.ts` on 2026-11-14. It checks that the example documents’ data, templates, outputs and settings are accurate. Everything in them is synthetic.

## What was checked

- **Data**: customer ids, required fields, types and choices, dates in order, and the arithmetic of each kind of document to the cent.
- **Template and rules**: every model validation; that every rule, alternative, conditional section and language is reached by a customer; no rule ties or gaps in time; every data field used; every calculation with a value and equal to an independent recomputation; lookup tables without duplicates, overlaps or gaps.
- **Outcomes**: every customer resolves and the only blocking findings are the intended ones; pinned tests; wording rules; translation counts; library links; mappings; the email subject and SMS.
- **Outputs**: real PDFs and web pages for one customer of each outcome: no overflow or clipped content, page counts, the payment slip on the last page, PDF and web page in parity, the studio’s PDF accessibility checks, nothing unformatted.
- **Settings**: a release and its package with no customer data, the runnable package’s own verify, a proof record verified as the same.

Each check is a pass, an intended exception (deliberate, listed in the example’s notes with the reason) or FAILED.

**Overall:** 30 passed, 14 with intended exceptions only, 0 failed, 0 not run.

## Northwind Energy — Utility bill (dual fuel)

34 synthetic customers. Document `northwind-energy-demo`.

| Group | Check | Result | Counts |
|---|---|---|---|
| Data | Customer ids are unique and well formed | pass | 34 customers, 34 distinct ids |
| Data | Required fields present; types and choice values valid | pass | 34 customers against 27 field definitions (14 required) |
| Data | Domain arithmetic to the cent, dates in order | pass | 34 customers checked |
| Template and rules | The document passes every model validation | pass | 46 components, 8 rules, 17 calculations, 3 lookup tables |
| Template and rules | Every rule, alternative, conditional section and language is reached | pass | 35 of 35 outcomes reached by the customers; the studio’s coverage engine lists 0 gaps |
| Template and rules | No rule ties and no gaps in time | pass | Dated rules, alternatives and sections checked for gaps and overlaps on every boundary day |
| Template and rules | Every data field is used, or listed as intentionally unused | intended exception | 53 fields in the data dictionary |
| Template and rules | Every calculation has a value; totals equal an independent recomputation | intended exception | 17 calculations × 34 customers; 507 values recomputed independently |
| Template and rules | Lookup tables: no duplicates, overlaps or gaps; every customer finds a row | pass | 3 tables, 8 rows |
| Outcomes | The only blocking findings are the intended, listed ones | intended exception | 34 customers resolved; 3 blocking findings |
| Outcomes | Pinned tests pass | pass | 8 pinned tests, 8 passing |
| Outcomes | Wording rules: no “must” finding, only the intended “should” | intended exception | 8 rules in force (house and own) over 75 texts |
| Outcomes | Translations: approved, draft and missing as declared | pass | es-US: 121 approved, 4 draft, 0 missing |
| Outcomes | Library links are at the declared versions, with the library’s content | intended exception | 6 links |
| Outcomes | Mapping completeness as declared | intended exception | Mapping for the print house: complete; Mapping for the customer portal: incomplete |
| Outcomes | Email subject and SMS within their limits, nothing unresolved or unformatted | intended exception | 34 customers; longest subject 57 characters; SMS at most 3 parts |
| Settings | The seeded release was approvable: no blocker but the known data problem, its pinned tests pass | intended exception | 34 customers and 7 pinned tests against the released version |
| Outputs | Composed PDF and web page: no overflow, pages as declared, parity, nothing unformatted | pass | 9 representative customers composed (every outcome once); pages: NWE-60009: 3, NWE-60020: 2, NWE-60032: 2, NWE-60004: 2, NWE-60016: 2, NWE-60019: 3, NWE-60033: 2, NWE-60017: 2, NWE-60034: 2 |
| Outputs | PDF accessibility checks pass (“Accessible PDF is required” is on) | pass | 4 of 4 composed PDFs pass every check the studio runs (veraPDF not run) |
| Settings | Release 1 and its package (stub composer): only synthetic customers | pass | 25 files; customers in it: sample |
| Settings | The runnable package’s own verify (without PDF) passes | pass | 7 proof cases |
| Settings | A proof record produced by the studio verifies as “same” | pass | customer NWE-60001 |

**Intended exceptions**

- Every data field is used, or listed as intentionally unused:
  - custom.charges[].rateTenThousandths: Carried for the print house and the accuracy check; the bill shows the rate as text.
- Every calculation has a value; totals equal an independent recomputation:
  - NWE-60033 (Arjun Mehta): totalDue has no value — intended: The deliberate non-reconciling customer (no current charges total).
  - NWE-60033 (Arjun Mehta): creditAmount has no value — intended: Worked out from the missing total due.
  - NWE-60034 (Nadia Sorensen): daysUntilDue has no value — intended: The known data problem: no due date.
- The only blocking findings are the intended, listed ones:
  - NWE-60017 (Mariana Delgado): REQUIRED_TRANSLATION_MISSING — Demonstration: the credit-balance message added in the working version has only a draft Spanish text, and this Spanish-speaking customer is in credit.
  - NWE-60033 (Arjun Mehta): CALCULATION_MISSING — Demonstration: this customer’s data does not reconcile — the current charges total is missing although charge lines exist, so the total due cannot be worked out and the credit-balance rule cannot decide.
  - NWE-60034 (Nadia Sorensen): NULL_BINDING — Accounts moving to budget billing get their due date from the billing system after the cycle closes; billing operations confirmed this customer pays by automatic payment, so the bill can go out without a printed due date.
- Wording rules: no “must” finding, only the intended “should”:
  - nw-say-kwh in About estimated readings (en-US) — Demonstration of a “should” wording rule: the estimated-reading explanation says “kilowatt-hours” once.
- Library links are at the declared versions, with the library’s content:
  - Customer rights notice (utilities): a newer approved version exists, on purpose (“Update available”)
- Mapping completeness as declared:
  - Mapping for the customer portal: 38 fields unmapped, on purpose
- Email subject and SMS within their limits, nothing unresolved or unformatted:
  - NWE-60017 (Mariana Delgado): the SMS takes 3 parts — a demonstration customer whose data is incomplete on purpose
  - NWE-60033 (Arjun Mehta): a value is shown as “—” (missing) — a demonstration customer whose data is incomplete on purpose
  - NWE-60034 (Nadia Sorensen): a value is shown as “—” (missing) — a demonstration customer whose data is incomplete on purpose
- The seeded release was approvable: no blocker but the known data problem, its pinned tests pass:
  - NWE-60034 (Nadia Sorensen): NULL_BINDING — set aside as a known data problem when release 1 was approved

## Meridian Wealth — Quarterly portfolio statement

34 synthetic customers. Document `meridian-wealth-demo`.

| Group | Check | Result | Counts |
|---|---|---|---|
| Data | Customer ids are unique and well formed | pass | 34 customers, 34 distinct ids |
| Data | Required fields present; types and choice values valid | pass | 34 customers against 25 field definitions (15 required) |
| Data | Domain arithmetic to the cent, dates in order | pass | 34 customers checked |
| Template and rules | The document passes every model validation | pass | 39 components, 7 rules, 19 calculations, 2 lookup tables |
| Template and rules | Every rule, alternative, conditional section and language is reached | pass | 27 of 27 outcomes reached by the customers; the studio’s coverage engine lists 0 gaps |
| Template and rules | No rule ties and no gaps in time | pass | Dated rules, alternatives and sections checked for gaps and overlaps on every boundary day |
| Template and rules | Every data field is used, or listed as intentionally unused | intended exception | 53 fields in the data dictionary |
| Template and rules | Every calculation has a value; totals equal an independent recomputation | intended exception | 19 calculations × 34 customers; 642 values recomputed independently |
| Template and rules | Lookup tables: no duplicates, overlaps or gaps; every customer finds a row | pass | 2 tables, 10 rows |
| Outcomes | The only blocking findings are the intended, listed ones | intended exception | 34 customers resolved; 4 blocking findings |
| Outcomes | Pinned tests pass | pass | 7 pinned tests, 7 passing |
| Outcomes | Wording rules: no “must” finding, only the intended “should” | intended exception | 8 rules in force (house and own) over 72 texts |
| Outcomes | Translations: approved, draft and missing as declared | pass | es-US: 118 approved, 4 draft, 0 missing |
| Outcomes | Library links are at the declared versions, with the library’s content | pass | 4 links |
| Outcomes | Mapping completeness as declared | intended exception | Mapping for the print house: complete; Mapping for the client portal: incomplete |
| Outcomes | Email subject and SMS within their limits, nothing unresolved or unformatted | intended exception | 34 customers; longest subject 80 characters; SMS at most 3 parts |
| Settings | The seeded release was approvable: no blocker but the known data problem, its pinned tests pass | pass | Seeded without a release (it starts as a Draft): nothing to check. |
| Outputs | Composed PDF and web page: no overflow, pages as declared, parity, nothing unformatted | pass | 9 representative customers composed (every outcome once); pages: MWS-60006: 2, MWS-60019: 2, MWS-60004: 2, MWS-60028: 2, MWS-60011: 3, MWS-60018: 2, MWS-60012: 2, MWS-60027: 2, MWS-60014: 2 |
| Outputs | PDF accessibility checks pass (“Accessible PDF is required” is on) | pass | 4 of 4 composed PDFs pass every check the studio runs (veraPDF not run) |
| Settings | Release 1 and its package (stub composer): only synthetic customers | pass | 25 files; customers in it: sample |
| Settings | The runnable package’s own verify (without PDF) passes | pass | 7 proof cases |
| Settings | A proof record produced by the studio verifies as “same” | pass | customer MWS-60001 |

**Intended exceptions**

- Every data field is used, or listed as intentionally unused:
  - custom.holdings[].costCents: Carried for the unrealized gain; the accuracy check adds it up.
  - custom.assetAllocation[].weight: Carried for the client portal; the chart shows amounts.
- Every calculation has a value; totals equal an independent recomputation:
  - MWS-60014 (Kwame Asante): adviserLine has no value — intended: The known data problem: no adviser.
  - MWS-60018 (Oscar Delahaye): changeInValue has no value — intended: The deliberate non-reconciling customer (no closing value).
  - MWS-60018 (Oscar Delahaye): changePct has no value — intended: Worked out from the missing closing value.
  - MWS-60018 (Oscar Delahaye): largestWeightPct has no value — intended: Worked out from the missing closing value.
- The only blocking findings are the intended, listed ones:
  - MWS-60012 (Ignacio Paredes): REQUIRED_TRANSLATION_MISSING — Demonstration: the aggressive-growth commentary has only a draft Spanish text, and this Spanish-speaking client has an aggressive profile.
  - MWS-60014 (Kwame Asante): NULL_BINDING — A self-directed account with no adviser assigned; client services confirmed the statement goes out without an adviser line and the client calls the general service number.
  - MWS-60018 (Oscar Delahaye): CALCULATION_MISSING — Demonstration: this customer’s data does not reconcile — the custodian sent no closing value although the holdings are listed, so the change in value and the share of the largest holding (which decides the concentration notice) cannot be worked out.
  - MWS-60027 (Ximena Fuentes): REQUIRED_TRANSLATION_MISSING — Demonstration: the same draft Spanish commentary, for the second Spanish-speaking aggressive client.
- Wording rules: no “must” finding, only the intended “should”:
  - mw-no-risk-free in Your portfolio fell this quarter (en-US) — Demonstration of a “should” wording rule: the fall notice says “No investment is risk-free”, which the house style would rather avoid even in a denial.
- Mapping completeness as declared:
  - Mapping for the client portal: 36 fields unmapped, on purpose
- Email subject and SMS within their limits, nothing unresolved or unformatted:
  - MWS-60018 (Oscar Delahaye): the SMS takes 3 parts — a demonstration customer whose data is incomplete on purpose
  - MWS-60018 (Oscar Delahaye): a value is shown as “—” (missing) — a demonstration customer whose data is incomplete on purpose

## The approved card and benefits fixtures (read only)

The same style of arithmetic and date checks over `fixtures/customers_100.json` (70 card and 30 benefits customers). The files are never changed; their deliberate inconsistencies are listed in `fixtures/expected_scenarios.json`.

No findings: every card record adds up (new balance, purchases and transactions) with its dates in order, and every claim follows the fixtures’ own rule — on a processed claim billed less the adjustment is the allowed amount and the allowed amount is what the plan paid plus the member’s amount; a denied or appealed claim has nothing allowed or paid and its whole billed amount under review. The oracle’s deliberate inconsistencies are made by overrides in `fixtures/expected_scenarios.json`, not in the records; run on those scenarios, the same checks find exactly them (below, all intended).

| Customer | Finding | Intended? | Why |
|---|---|---|---|
| CARD-0001 + “card-inconsistent-payment-state” | payment status current with missed payments | yes | Deliberate: the oracle scenario “card-inconsistent-payment-state” overrides this record to make it inconsistent (fixtures/expected_scenarios.json). |
| EOB-0002 + “eob-unconfirmed-liability” | claim HC-10429: an unadjudicated claim with amounts allowed, adjusted or paid | yes | Deliberate: the oracle scenario “eob-unconfirmed-liability” overrides this record to make it inconsistent (fixtures/expected_scenarios.json). |


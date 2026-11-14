# Examples audit

Written by `npx tsx scripts/audit-examples.ts` on 2026-11-14. It checks that the example documents’ data, templates, outputs and settings are accurate. Everything in them is synthetic.

## What was checked

- **Data**: customer ids, required fields, types and choices, dates in order, and the arithmetic of each kind of document to the cent.
- **Template and rules**: every model validation; that every rule, alternative, conditional section and language is reached by a customer; no rule ties or gaps in time; every data field used; every calculation with a value and equal to an independent recomputation; lookup tables without duplicates, overlaps or gaps.
- **Outcomes**: every customer resolves and the only blocking findings are the intended ones; pinned tests; wording rules; translation counts; library links; mappings; the email subject and SMS.
- **Outputs**: real PDFs and web pages for one customer of each outcome: no overflow or clipped content, page counts, the payment slip on the last page, PDF and web page in parity, the studio’s PDF accessibility checks, nothing unformatted.
- **Settings**: a release and its package with no customer data, the runnable package’s own verify, a proof record verified as the same.

Each check is a pass, an intended exception (deliberate, listed in the example’s notes with the reason) or FAILED. A check, or part of one, that cannot apply to an example says “does not apply” and why (listed under each example); it is never counted as a pass.

**Overall:** 61 passed, 24 with intended exceptions only, 0 failed, 3 do not apply, 0 not run.

| Example | Pass | Intended exceptions | Failed | Does not apply | Not run |
|---|---|---|---|---|---|
| Northwind Energy | 14 | 8 | 0 | 0 | 0 |
| Meridian Wealth | 15 | 6 | 0 | 1 | 0 |
| Aster Card | 15 | 6 | 0 | 1 | 0 |
| HarborCare Health | 17 | 4 | 0 | 1 | 0 |

## Northwind Energy — Utility bill (dual fuel)

34 synthetic customers. Document `northwind-energy-demo`.

| Group | Check | Result | Counts |
|---|---|---|---|
| Data | Customer ids are unique and well formed | pass | 34 customers, 34 distinct ids |
| Data | Required fields present; types and choice values valid | pass | 34 customers against 30 field definitions (17 required) |
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
| Outputs | PDF accessibility checks pass (“Accessible PDF is required” is on) | pass | 5 of 5 composed PDFs pass every check the studio runs (veraPDF not run) |
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
| Data | Required fields present; types and choice values valid | pass | 34 customers against 28 field definitions (18 required) |
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
| Settings | The seeded release was approvable: no blocker but the known data problem, its pinned tests pass | does not apply | Does not apply: the example is seeded without a release (it starts as a Draft), so there is no released version to check. The release made from it is checked under Settings. |
| Outputs | Composed PDF and web page: no overflow, pages as declared, parity, nothing unformatted | pass | 9 representative customers composed (every outcome once); pages: MWS-60006: 2, MWS-60019: 2, MWS-60004: 2, MWS-60028: 2, MWS-60011: 3, MWS-60018: 2, MWS-60012: 2, MWS-60027: 2, MWS-60014: 2 |
| Outputs | PDF accessibility checks pass (“Accessible PDF is required” is on) | pass | 5 of 5 composed PDFs pass every check the studio runs (veraPDF not run) |
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

**Does not apply**

- The seeded release was approvable: no blocker but the known data problem, its pinned tests pass:
  - the example is seeded without a release (it starts as a Draft), so there is no released version to check. The release made from it is checked under Settings.

## Aster Card — Credit-card statement (built-in kind)

70 synthetic customers. Document `aster-card-demo`.

| Group | Check | Result | Counts |
|---|---|---|---|
| Data | Customer ids are unique and well formed | pass | 70 customers, 70 distinct ids |
| Data | Required fields present; types and choice values valid | pass | 70 customers against 27 field definitions (14 required) |
| Data | Domain arithmetic to the cent, dates in order | intended exception | 70 customers checked, and 6 oracle scenarios with overrides (card-missed-first, card-assistance-requested, card-arrangement-approved, card-spanish-missing-mandatory-translation, card-inconsistent-payment-state, card-250-rows) |
| Template and rules | The document passes every model validation | pass | 34 components, 12 rules, 5 calculations, 1 lookup tables |
| Template and rules | Every rule, alternative, conditional section and language is reached | intended exception | 31 of 40 outcomes reached by the customers; the studio’s coverage engine lists 6 gaps |
| Template and rules | No rule ties and no gaps in time | pass | Dated rules, alternatives and sections checked for gaps and overlaps on every boundary day |
| Template and rules | Every data field is used, or listed as intentionally unused | intended exception | 38 fields in the data dictionary |
| Template and rules | Every calculation has a value; totals equal an independent recomputation | pass | 5 calculations × 70 customers; 350 values recomputed independently |
| Template and rules | Lookup tables: no duplicates, overlaps or gaps; every customer finds a row | pass | 1 tables, 2 rows |
| Outcomes | The only blocking findings are the intended, listed ones | intended exception | 70 customers resolved; 6 blocking findings |
| Outcomes | Pinned tests pass | pass | 7 pinned tests, 7 passing |
| Outcomes | Wording rules: no “must” finding, only the intended “should” | intended exception | 10 rules in force (house and own) over 63 texts |
| Outcomes | Translations: approved, draft and missing as declared | pass | es-US: 0 approved, 0 draft, 120 missing |
| Outcomes | Library links are at the declared versions, with the library’s content | pass | 2 links |
| Outcomes | Mapping completeness as declared | pass | Mapping for the print house: complete |
| Outcomes | Email subject and SMS within their limits, nothing unresolved or unformatted | pass | 70 customers; longest subject 68 characters; SMS at most 1 part |
| Settings | The seeded release was approvable: no blocker but the known data problem, its pinned tests pass | does not apply | Does not apply: the example is seeded without a release (it starts as a Draft), so there is no released version to check. The release made from it is checked under Settings. |
| Outputs | Composed PDF and web page: no overflow, pages as declared, parity, nothing unformatted | pass | 12 representative customers composed (every outcome once) and 1 oracle scenario; pages: CARD-0002: 3, CARD-0007: 2, CARD-0011: 2, CARD-0003: 2, CARD-0005: 2, CARD-0006: 2, CARD-0001: 2, CARD-0017: 2, CARD-0029: 2, CARD-0041: 2, CARD-0053: 2, CARD-0065: 2, scenario card-250-rows: 8 |
| Outputs | PDF accessibility checks pass (“Accessible PDF is required” is on) | intended exception | 1 of 5 composed PDFs pass every check the studio runs (veraPDF not run); checked as if “Accessible PDF is required” were on |
| Settings | Release 1 and its package (stub composer): only synthetic customers | pass | 25 files; customers in it: sample |
| Settings | The runnable package’s own verify (without PDF) passes | pass | 7 proof cases |
| Settings | A proof record produced by the studio verifies as “same” | pass | customer CARD-0001 |

**Intended exceptions**

- Domain arithmetic to the cent, dates in order:
  - scenario “card-inconsistent-payment-state”: payment-state: Payment status is “current” with 2 missed payments. — intended: Deliberate: the oracle expects INCONSISTENT_PAYMENT_STATE (status “current” with two missed payments); priority must not hide it.
- Every rule, alternative, conditional section and language is reached:
  - rule R03: Approved rule: two or more missed payments without a request for help. No fixture customer is in that state as issued; the oracle reaches it with overrides. Reached by the oracle scenario “card-inconsistent-payment-state” (fixtures/expected_scenarios.json).
  - rule R05: Approved rule: an approved payment arrangement. Every fixture customer has no arrangement; the oracle and the journey reach it. Reached by the oracle scenario “card-arrangement-approved” (fixtures/expected_scenarios.json).
  - alternative payment-guidance/payment-support-offer: Chosen only by R03 (see above). Reached by the oracle scenario “card-inconsistent-payment-state” (fixtures/expected_scenarios.json).
  - alternative payment-guidance/payment-arrangement-active: Chosen only by R05 (see above). Reached by the oracle scenario “card-arrangement-approved” (fixtures/expected_scenarios.json).
  - hidden spending-summary: The spending sentence is hidden only when no transaction is listed; every fixture customer lists at least one. Reached by CARD-0001 with overrides {"card":{"transactions":[]}}.
  - alternative payment-timing/timing-arrangement: Added “When to pay” wording for an approved arrangement (no late fee). No fixture customer has an arrangement; the pinned test shows it. Reached by the pinned test “Approved arrangement: arrangement message, no late fee” (aster-arrangement-no-fee).
  - hidden payment-timing: “When to pay” is hidden only when no minimum payment is due; every fixture customer owes one. Reached by CARD-0001 with overrides {"card":{"minimumDueCents":0}}.
  - alternative notice-agreement-update/agreement-update: As above: the notice’s one alternative. Reached by the pinned test “As issued on 15 Dec 2026: the agreement notice starts, the holiday notice still shows” (aster-issued-december).
  - shown notice-agreement-update: In effect from 1 Dec 2026; every fixture statement is issued 1 Nov 2026, so it shows only “as issued on” a later day. Reached by the pinned test “As issued on 15 Dec 2026: the agreement notice starts, the holiday notice still shows” (aster-issued-december).
- Every data field is used, or listed as intentionally unused:
  - card.currency: A field of the approved card data (every fixture customer has USD); the approved template formats every amount as US dollars and never prints the currency code. The print-house mapping carries it.
- The only blocking findings are the intended, listed ones:
  - CARD-0005 (Morgan Santos): REQUIRED_TRANSLATION_MISSING — Prefers Spanish (es-US); R07 asks for approved Spanish and four required texts (New balance, Minimum payment, Payment instructions, Sample disclosures) have none, so REQUIRED_TRANSLATION_MISSING blocks this customer. Deliberate: Blockers, Translations and the guided demo show it.
  - CARD-0017 (Dakota Mercer): REQUIRED_TRANSLATION_MISSING — Prefers Spanish (es-US); R07 asks for approved Spanish and four required texts (New balance, Minimum payment, Payment instructions, Sample disclosures) have none, so REQUIRED_TRANSLATION_MISSING blocks this customer. Deliberate: Blockers, Translations and the guided demo show it.
  - CARD-0029 (Jamie Park): REQUIRED_TRANSLATION_MISSING — Prefers Spanish (es-US); R07 asks for approved Spanish and four required texts (New balance, Minimum payment, Payment instructions, Sample disclosures) have none, so REQUIRED_TRANSLATION_MISSING blocks this customer. Deliberate: Blockers, Translations and the guided demo show it.
  - CARD-0041 (Morgan Foster): REQUIRED_TRANSLATION_MISSING — Prefers Spanish (es-US); R07 asks for approved Spanish and four required texts (New balance, Minimum payment, Payment instructions, Sample disclosures) have none, so REQUIRED_TRANSLATION_MISSING blocks this customer. Deliberate: Blockers, Translations and the guided demo show it.
  - CARD-0053 (Dakota Santos): REQUIRED_TRANSLATION_MISSING — Prefers Spanish (es-US); R07 asks for approved Spanish and four required texts (New balance, Minimum payment, Payment instructions, Sample disclosures) have none, so REQUIRED_TRANSLATION_MISSING blocks this customer. Deliberate: Blockers, Translations and the guided demo show it.
  - CARD-0065 (Jamie Mercer): REQUIRED_TRANSLATION_MISSING — Prefers Spanish (es-US); R07 asks for approved Spanish and four required texts (New balance, Minimum payment, Payment instructions, Sample disclosures) have none, so REQUIRED_TRANSLATION_MISSING blocks this customer. Deliberate: Blockers, Translations and the guided demo show it.
- Wording rules: no “must” finding, only the intended “should”:
  - aster-relationship-team in Relationship team (en-US) — The relationship team message says “relationship specialist”. An existing approved message; the finding shows a “should” rule warning without blocking.
- PDF accessibility checks pass (“Accessible PDF is required” is on):
  - “Accessible PDF is required” is off. Known limitation, kept on purpose: “Accessible PDF is required” is off for the card. Its transaction table, where it continues onto another page, does not repeat its header row, so that part fails the studio’s table-header check. The suggested fix (repeat the header row) changes the pagination that the 250-row case (AT-18, AT-19, scripts/verify_app.py) and the Page panel browser tests rely on.
  - CARD-0007 (Sam Brooks): PDF_A11Y_TABLE_NO_HEADERS The part of “Transactions” on page 2 that continues from the page before has no header row, so a screen reader cannot say which column a value is in. Turn on “Repeat the header row on each page” for “Transactions”. — known limitation: The continued part of the transaction table has no header row (the known limitation above).
  - CARD-0011 (Jamie Reed): PDF_A11Y_TABLE_NO_HEADERS The part of “Transactions” on page 2 that continues from the page before has no header row, so a screen reader cannot say which column a value is in. Turn on “Repeat the header row on each page” for “Transactions”. — known limitation: The continued part of the transaction table has no header row (the known limitation above).
  - CARD-0003 (Alex Chen): PDF_A11Y_TABLE_NO_HEADERS The part of “Transactions” on page 2 that continues from the page before has no header row, so a screen reader cannot say which column a value is in. Turn on “Repeat the header row on each page” for “Transactions”. — known limitation: The continued part of the transaction table has no header row (the known limitation above).
  - CARD-0001 (Jordan Mercer): PDF_A11Y_TABLE_NO_HEADERS The part of “Transactions” on page 2 that continues from the page before has no header row, so a screen reader cannot say which column a value is in. Turn on “Repeat the header row on each page” for “Transactions”. — known limitation: The continued part of the transaction table has no header row (the known limitation above).

**Does not apply**

- The seeded release was approvable: no blocker but the known data problem, its pinned tests pass:
  - the example is seeded without a release (it starts as a Draft), so there is no released version to check. The release made from it is checked under Settings.

## HarborCare Health — Explanation of benefits (built-in kind)

30 synthetic customers. Document `harborcare-demo`.

| Group | Check | Result | Counts |
|---|---|---|---|
| Data | Customer ids are unique and well formed | pass | 30 customers, 30 distinct ids |
| Data | Required fields present; types and choice values valid | pass | 30 customers against 22 field definitions (6 required) |
| Data | Domain arithmetic to the cent, dates in order | intended exception | 30 customers checked, and 1 oracle scenarios with overrides (eob-unconfirmed-liability) |
| Template and rules | The document passes every model validation | pass | 26 components, 8 rules, 4 calculations, 1 lookup tables |
| Template and rules | Every rule, alternative, conditional section and language is reached | intended exception | 25 of 30 outcomes reached by the customers; the studio’s coverage engine lists 2 gaps |
| Template and rules | No rule ties and no gaps in time | pass | Dated rules, alternatives and sections checked for gaps and overlaps on every boundary day |
| Template and rules | Every data field is used, or listed as intentionally unused | intended exception | 29 fields in the data dictionary |
| Template and rules | Every calculation has a value; totals equal an independent recomputation | pass | 4 calculations × 30 customers; 120 values recomputed independently |
| Template and rules | Lookup tables: no duplicates, overlaps or gaps; every customer finds a row | pass | 1 tables, 2 rows |
| Outcomes | The only blocking findings are the intended, listed ones | pass | 30 customers resolved; 0 blocking findings |
| Outcomes | Pinned tests pass | pass | 5 pinned tests, 5 passing |
| Outcomes | Wording rules: no “must” finding, only the intended “should” | intended exception | 10 rules in force (house and own) over 64 texts |
| Outcomes | Translations: approved, draft and missing as declared | pass | es-US: 0 approved, 0 draft, 121 missing |
| Outcomes | Library links are at the declared versions, with the library’s content | pass | 3 links |
| Outcomes | Mapping completeness as declared | pass | Mapping for the print house: complete |
| Outcomes | Email subject and SMS within their limits, nothing unresolved or unformatted | pass | 30 customers; longest subject 76 characters; SMS at most 1 part |
| Settings | The seeded release was approvable: no blocker but the known data problem, its pinned tests pass | does not apply | Does not apply: the example is seeded without a release (it starts as a Draft), so there is no released version to check. The release made from it is checked under Settings. |
| Outputs | Composed PDF and web page: no overflow, pages as declared, parity, nothing unformatted | pass | 5 representative customers composed (every outcome once); pages: EOB-0003: 2, EOB-0002: 2, EOB-0008: 2, EOB-0001: 2, EOB-0005: 2 |
| Outputs | PDF accessibility checks pass (“Accessible PDF is required” is on) | pass | 4 of 4 composed PDFs pass every check the studio runs (veraPDF not run) |
| Settings | Release 1 and its package (stub composer): only synthetic customers | pass | 25 files; customers in it: sample, generated |
| Settings | The runnable package’s own verify (without PDF) passes | pass | 7 proof cases |
| Settings | A proof record produced by the studio verifies as “same” | pass | customer EOB-0001 |

**Intended exceptions**

- Domain arithmetic to the cent, dates in order:
  - EOB-0002 (Avery Stone): billed: Claim HC-10429: billed $300.00 ≠ adjustment $0.00 + allowed $0.00 (under review: $300.00). — intended: The claim is denied-pending-review: the whole billed amount is under review and nothing is allowed yet, so billed = adjustment + allowed + under review.
  - EOB-0004 (Charlie Foster): billed: Claim HC-10431: billed $505.00 ≠ adjustment $0.00 + allowed $0.00 (under review: $505.00). — intended: The claim is denied-pending-review: the whole billed amount is under review and nothing is allowed yet, so billed = adjustment + allowed + under review.
  - EOB-0005 (Harper Stone): billed: Claim HC-10432: billed $540.00 ≠ adjustment $0.00 + allowed $0.00 (under review: $540.00). — intended: The claim is appeal-filed: the whole billed amount is under review and nothing is allowed yet, so billed = adjustment + allowed + under review.
  - EOB-0010 (Emery Bennett): billed: Claim HC-10437: billed $540.00 ≠ adjustment $0.00 + allowed $0.00 (under review: $540.00). — intended: The claim is denied-pending-review: the whole billed amount is under review and nothing is allowed yet, so billed = adjustment + allowed + under review.
  - EOB-0011 (Drew Cole): billed: Claim HC-10438: billed $400.00 ≠ adjustment $0.00 + allowed $0.00 (under review: $400.00). — intended: The claim is appeal-filed: the whole billed amount is under review and nothing is allowed yet, so billed = adjustment + allowed + under review.
  - EOB-0016 (Taylor Santos): billed: Claim HC-10443: billed $400.00 ≠ adjustment $0.00 + allowed $0.00 (under review: $400.00). — intended: The claim is denied-pending-review: the whole billed amount is under review and nothing is allowed yet, so billed = adjustment + allowed + under review.
  - EOB-0017 (Alex Lee): billed: Claim HC-10444: billed $435.00 ≠ adjustment $0.00 + allowed $0.00 (under review: $435.00). — intended: The claim is appeal-filed: the whole billed amount is under review and nothing is allowed yet, so billed = adjustment + allowed + under review.
  - EOB-0022 (Charlie Reed): billed: Claim HC-10449: billed $435.00 ≠ adjustment $0.00 + allowed $0.00 (under review: $435.00). — intended: The claim is denied-pending-review: the whole billed amount is under review and nothing is allowed yet, so billed = adjustment + allowed + under review.
  - EOB-0023 (Harper Grant): billed: Claim HC-10450: billed $470.00 ≠ adjustment $0.00 + allowed $0.00 (under review: $470.00). — intended: The claim is appeal-filed: the whole billed amount is under review and nothing is allowed yet, so billed = adjustment + allowed + under review.
  - EOB-0028 (Emery Mercer): billed: Claim HC-10455: billed $470.00 ≠ adjustment $0.00 + allowed $0.00 (under review: $470.00). — intended: The claim is denied-pending-review: the whole billed amount is under review and nothing is allowed yet, so billed = adjustment + allowed + under review.
  - EOB-0029 (Drew Rivers): billed: Claim HC-10456: billed $505.00 ≠ adjustment $0.00 + allowed $0.00 (under review: $505.00). — intended: The claim is appeal-filed: the whole billed amount is under review and nothing is allowed yet, so billed = adjustment + allowed + under review.
  - scenario “eob-unconfirmed-liability”: billed: Claim HC-10429: billed $300.00 ≠ adjustment $0.00 + allowed $0.00 (under review: $300.00). — intended: The claim is denied-pending-review: the whole billed amount is under review and nothing is allowed yet, so billed = adjustment + allowed + under review.
  - scenario “eob-unconfirmed-liability”: allowed: Claim HC-10429: allowed $0.00 ≠ plan paid $0.00 + member responsibility $300.00. Liability is unconfirmed, so the studio never shows that amount as owed. — intended: Deliberate: the oracle expects UNCONFIRMED_MEMBER_LIABILITY (member responsibility supplied while liability is unconfirmed); the amount is never shown as owed.
- Every rule, alternative, conditional section and language is reached:
  - rule R19: Approved rule: several claims show a claim index. Every fixture customer has exactly one claim. Reached by EOB-0001 with overrides {"claims":[{"claimId":"HC-90001","serviceDate":"2026-10-18","service":"Office visit","billedCents":40000,"allowedCents":.
  - alternative multi-claim-index/multi-claim-index: The index’s one alternative, shown only by R19. Reached by EOB-0001 with overrides {"claims":[{"claimId":"HC-90001","serviceDate":"2026-10-18","service":"Office visit","billedCents":40000,"allowedCents":.
  - shown multi-claim-index: Shown only by R19 (see above). Reached by EOB-0001 with overrides {"claims":[{"claimId":"HC-90001","serviceDate":"2026-10-18","service":"Office visit","billedCents":40000,"allowedCents":.
  - hidden claim-summary: The claim summary is hidden only for a claim that says neither that the member’s liability is confirmed nor that it is not; every fixture claim says one or the other. Reached by EOB-0001 with overrides {"claims":[{"claimId":"HC-90001","serviceDate":"2026-10-18","service":"Office visit","billedCents":40000,"allowedCents":.
  - language es-US: There is no Spanish-speaking EOB customer; Spanish exists as labelled sample drafts only. Reached by EOB-0001 with overrides {"customer":{"locale":"es-US"}}.
- Every data field is used, or listed as intentionally unused:
  - claim.serviceDate: A field of the approved claims data: the first claim’s service date. The claim table shows every claim’s service date (claims[].serviceDate). The document has no date of its own (see the notes), so no calculation reads it.
  - claim.service: A field of the approved claims data: the first claim’s service. The claim table shows every claim’s service (claims[].service), so for these one-claim customers it is shown there.
- Wording rules: no “must” finding, only the intended “should”:
  - harbor-no-patient in Claim totals (en-US) — The approved “Claim totals” disclosure says “patient responsibility”. An approved disclosure; the finding shows a “should” rule warning on protected wording.

**Does not apply**

- Pinned tests pass (this part only; the rest of the check ran):
  - A pinned test “as issued on” a date: this document has no date of its own (its data has no issue or processing date), so a test cannot run on another day.
- The seeded release was approvable: no blocker but the known data problem, its pinned tests pass:
  - the example is seeded without a release (it starts as a Draft), so there is no released version to check. The release made from it is checked under Settings.

## The approved card and benefits fixtures (read only)

The same style of arithmetic and date checks over `fixtures/customers_100.json` (70 card and 30 benefits customers). The files are never changed; their deliberate inconsistencies are listed in `fixtures/expected_scenarios.json`.

No findings: every card record adds up (new balance, purchases and transactions) with its dates in order, and every claim follows the fixtures’ own rule — on a processed claim billed less the adjustment is the allowed amount and the allowed amount is what the plan paid plus the member’s amount; a denied or appealed claim has nothing allowed or paid and its whole billed amount under review. The oracle’s deliberate inconsistencies are made by overrides in `fixtures/expected_scenarios.json`, not in the records; run on those scenarios, the same checks find exactly them (below, all intended).

| Customer | Finding | Intended? | Why |
|---|---|---|---|
| CARD-0001 + “card-inconsistent-payment-state” | payment status current with missed payments | yes | Deliberate: the oracle scenario “card-inconsistent-payment-state” overrides this record to make it inconsistent (fixtures/expected_scenarios.json). |
| EOB-0002 + “eob-unconfirmed-liability” | claim HC-10429: an unadjudicated claim with amounts allowed, adjusted or paid | yes | Deliberate: the oracle scenario “eob-unconfirmed-liability” overrides this record to make it inconsistent (fixtures/expected_scenarios.json). |


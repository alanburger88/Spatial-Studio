# The example documents

Four example documents come with the studio (D106). Every person, company, account, fund, number and address in them is
invented; each names its issuer as fictional where the document says who it is from, and carries the synthetic-data
notice. They exist so that a new user who opens any screen finds something real to look at, and so that every feature
of the studio is shown working on a document that looks like one a real company would send.

| Example | Document id | Kind | What it is for |
|---|---|---|---|
| **Aster Card** | `aster-card-demo` | Credit-card statement (built-in kind) | The hero path of the approved POC: payment guidance chosen by rules, journeys over 60 days, a long transaction list, the guided demo. |
| **HarborCare Health** | `harborcare-demo` | Explanation of benefits (built-in kind) | Engine reuse on a second domain: THIS IS NOT A BILL, unconfirmed member liability never shown as owed, claims. |
| **Northwind Energy** | `northwind-energy-demo` | Utility bill — a document with its own data | A dual-fuel electricity and gas bill: sections appear and disappear by service, meter readings (actual and estimated), tiered rates from a lookup table, a dated rate change, a usage chart, payment-plan and overdue messages, a tear-off payment slip on the last page. Seeded with release 1 in Production and a working version that differs. |
| **Meridian Wealth** | `meridian-wealth-demo` | Quarterly portfolio statement — a document with its own data | A two-column first page (summary beside allocation) over a tint, holdings from one fund to forty across two pages, transactions, income and fees, performance against last quarter, messages by risk profile, a fall in value, concentration, a dated fee change and fourth-quarter tax documents. |

## How the two new examples are built and kept accurate

- **Built by code, through the command bus.** `packages/model/src/samples/northwind.ts` and `meridian.ts` start from the
  blank project and apply ordinary commands (`SET_CUSTOM_FIELDS`, `INSERT_NODE`, `UPSERT_RULE`, `LINK_LIBRARY_ITEM`, …),
  so every part passes the validation a person's edit would. The builders are pure and deterministic.
- **Their own customers.** 34 customers each, stable ids `NWE-60001…` and `MWS-60001…`, written in the customer's
  language (a Spanish-speaking customer's charge lines and transaction types are in Spanish). Stored as project records
  with origin `sample`: they count as built-in sample customers for the "no customer data in a package" rule
  (`pinnedCustomerRefs`, `builtInSampleCustomers`); a sample customer a person edits becomes `supplied` and stops counting.
- **Seeded once.** On the first start the server seeds each document, its customers, its known data problem, the house
  library (`packages/model/src/samples/houseLibrary.ts`) and, for Northwind, release 1 approved and in Production with
  four proof records. A data folder that already has the document is never touched again; *Restore sample* puts the
  document, its customers and its known data problem back. The registry (`@iss/model/samples/index`) is server-side
  only: the web bundle does not grow by it.
- **Notes.** Each sample carries notes (`SampleNotes`): its demonstration blockers, its known data problem, the one
  deliberate "should" wording finding, the fields carried but not shown, the calculations that are missing on purpose,
  the translation counts and the mappings' completeness. The accuracy check reads them.
- **The accuracy check.** `npx tsx scripts/audit-examples.ts` (report: `reports/EXAMPLES_AUDIT.md`) and
  `apps/api/test/examples-audit.test.ts` run named checks over each example: data, template and rules, outcomes, real
  outputs and settings. Anything not listed in the notes fails. To add an example, call `registerExample({ … })` from the
  script's module with the project, customers, notes and (optionally) a domain-arithmetic function and an independent
  recomputation of its calculations.

### Deliberate exceptions (both in the notes, with reasons)

| Example | Customer | What | Why it is there |
|---|---|---|---|
| Northwind | NWE-60033 | Blocker: “Total amount due” cannot be worked out | The data does not reconcile: charge lines but no current-charges total. |
| Northwind | NWE-60017 | Blocker: no approved Spanish for “Your account is in credit” | The credit message added in the working version has only a draft Spanish text; this Spanish-speaking customer is in credit. |
| Northwind | NWE-60034 | Known data problem: no due date (set aside, with a reason) | Shows the known-data-problem flow; frozen into release 1. |
| Meridian | MWS-60018 | Blocker: the largest holding's share cannot be worked out | The data does not reconcile: holdings but no closing value. |
| Meridian | MWS-60012, MWS-60027 | Blocker: no approved Spanish for the aggressive-growth commentary | That commentary has only a draft Spanish text. |
| Meridian | MWS-60014 | Known data problem: no adviser (set aside, with a reason) | A self-directed account. |
| Both | — | One “should” wording finding each (“kilowatt-hours”; “risk-free”) | Shows the document's own wording rules beside the house rules. |
| Both | — | A second mapping deliberately incomplete | Shows what an unfinished mapping looks like. |
| Northwind | — | The customer-rights notice linked at version 1 of 2 | Shows “Update available” from the library. |

## Feature matrix

Where to see each feature in each example. "being added" marks a cell the enrichment of the two existing examples
(`packages/model/src/samples/showcaseExisting.ts`, a separate piece of work) is adding; the integrator reconciles it.
"—" means the example does not show it.

| Feature | Aster Card | HarborCare | Northwind Energy | Meridian Wealth |
|---|---|---|---|---|
| Kind of document | Credit-card statement (built-in fields) | Explanation of benefits (built-in fields) | Your own data: 24 fields, 3 lists | Your own data: 22 fields, 3 lists |
| Customers | 70 shared sample customers, 12 personas | 30 shared sample customers | 34 own customers (`NWE-6…`) | 34 own customers (`MWS-6…`) |
| Letterhead zone (fixed items on the first page) | Logo, title, cardholder block | Logo, title, member block | Logo, title with name and account, amount-due box, due date | Logo, title, adviser |
| Running header and page footer | Yes | Yes | Yes | Yes |
| Summary metrics | Balance row | Claim amounts | Account summary row (keep together) | Closing value |
| Bound field with “error” null policy | Payment due date | Claim id | Due date (known data problem) | Adviser (known data problem) |
| Rich text with data values (bold values) | Greeting | Title | Usage paragraphs | Performance |
| Message with alternatives chosen by rules | Payment guidance (R01–R05) | Claim message | Payment message: standard, overdue, plan, automatic payment, credit | Commentary by risk profile |
| Fallback alternative | Standard payment | Processing | Standard; gas rates | Balanced; fee unchanged |
| Conditional region (inline condition) | High-volume note | — | Estimated reading; winter help | Concentration; tax documents |
| Rule-driven section (additive rule) | Relationship team, rewards | Network, deductible, member summary | Higher-use message (R05) | Fall in value (R04) |
| Section hidden by a condition on a container | — | — | Electricity / gas sections by service | Fee-waived note |
| Obligation rule (approved Spanish only) | R07 | — | R08 | R07 |
| Required notice (protected disclosure) | Sample disclosures | Totals and terms, not-a-bill banner | Customer rights (from the library) | Important information |
| Repeating table, continued with repeated headings | Transactions (250-row case) | Claims | Charges (25 rows over two pages) and meter readings | Holdings (40 funds over two pages), transactions |
| Table total | Transactions | Claims | Charges (marked total) | Holdings (marked total) |
| Bar chart | Top spending | — | Usage by month, in order, one colour | — |
| Donut chart | — | Claim breakdown | — | Asset allocation |
| Action link and QR code | Payment options | Questions | Pay online | View your account |
| Expandable explanation | Minimum payment | Terms explained | — | Gains explained |
| Brand kit and logo | Built-in mark | Built-in mark | From the library (logo, colours, Arial) | From the library (logo, colours, Georgia) |
| Calculated fields | being added | being added | 17: sums with a row condition, count, lookups, IF, DAYS, ADD_DAYS, ROUND, ABS, JOIN, LARGEST | 19: change and % change with rounding, investment return, fees and income from the transactions, largest holding, count, fee from a two-key lookup, JOIN |
| Lookup table by text | being added | being added | Late fee by rate plan | Risk wording by profile |
| Lookup table by number range | being added | being added | Delivery rate by monthly use (from the library) | Management fee by value band |
| Lookup table by date range | being added | being added | Supply rate by bill date | Management fee rows dated around 1 Dec 2026 (two keys) |
| The document's date | being added | being added | The bill date | The period end |
| Rule in effect for a period | being added | being added | R06 until / R07 from 1 Dec 2026 | R05 until / R06 from 1 Dec 2026 |
| Alternative in effect for a period | being added | being added | Rate notice: upcoming / new | Fee notice: going down / lower fee |
| Section in effect for a period | being added | being added | Winter heating help (Nov–Mar) | Tax documents (fourth quarter) |
| Page design: paper | US Letter | US Letter | US Letter | US Letter |
| First page flow area below the letterhead | Yes (standard) | Yes (standard) | Own flow area | Own flow area |
| Last page template with fixed items | being added | being added | Tear-off payment slip | — |
| Columns, spanning components, break to a column | being added | being added | — | Two columns; notices and tables span; allocation starts column 2 |
| Page background | being added | being added | — | Tint on the first page |
| Keep together | being added | being added | Summary, messages, notices, use rows | Summary, notices, chart |
| “Accessible PDF is required” | being added | being added | On, passing | On, passing |
| Interactive web page (sort, filter, chart data) | Yes | Yes | Yes | Yes |
| Email and SMS wording with data values | Default wording | Default wording | Calculated total and dates | Closing value, return, adviser |
| AFP simulation | Yes | Yes | Yes (default profile) | Yes (default profile) |
| Spanish | Approved fixture wording; labelled sample drafts on request | Approved fixture wording; labelled sample drafts on request | 121 approved, 4 drafts (labelled) | 118 approved, 4 drafts (labelled) |
| Data written in the customer's language | — | — | Charge lines, fuels, read types | Asset classes, transaction types |
| Glossary | being added | being added | From the library | From the library |
| Journeys | Day 1/30/45/60 | Received → appeal resolved | Due date missed → plan → automatic payment | Issued → risk review → new adviser |
| Pinned tests (one “as issued on”) | being added | being added | 8 (two on each side of the rate change) | 7 (two on each side of the fee change) |
| House wording rules (library) | being added | being added | Linked | Linked |
| The document's own wording rules | being added | being added | 2 (one “should” finding on purpose) | 2 (one “should” finding on purpose) |
| Library links | being added | being added | Brand, block, wording (behind: update available), glossary, lookup table, wording rules | Brand, block, glossary, wording rules |
| Mappings | being added | being added | Print house (complete), customer portal (incomplete) | Print house (complete), client portal (incomplete) |
| Demonstration blockers | Defect toggles (tie, no continuation) | Unconfirmed liability scenario | Data does not reconcile; draft Spanish | Data does not reconcile; draft Spanish |
| Known data problem | being added | being added | NWE-60034 | MWS-60014 |
| Releases | being added | being added | Release 1 in Production, working version 2 differs | None (Draft) |
| Before & after | being added | being added | Release 1 against the working version | — (no release yet) |
| Proof records | being added | being added | 4 produced from release 1 | — |
| Cube and landscape dimensions | Payment status, tier, channel | Claim status, network | Services, rate plan, payment status | Account type, risk profile |
| Guided demo (S11) | Yes | Yes | — | — |
| Edge-case generator presets | Yes | Yes | — (built-in kinds only) | — (built-in kinds only) |
| Accuracy check (`scripts/audit-examples.ts`) | being added | being added | Registered | Registered |

### What neither new example shows, and why

- **Image backgrounds, A4 or US Legal paper, landscape, three columns, “start on a new page”, text that splits across
  pages** — a US bill and a US statement are portrait Letter; Meridian uses a tint rather than an image and two columns.
  These page-design features are exercised by `e2e/page-design.spec.ts`.
- **Named text styles** — the brand kit gives both their look; styles are shown in the studio's own tests.
- **The guided demo and the edge-case presets** — they belong to the built-in kinds (card and claim).
- **The EOB liability guard and THIS IS NOT A BILL** — domain rules of HarborCare only.
- **Comments and review in progress** — the samples start as Draft, like the fixture samples; Northwind's history shows
  an approval (release 1) and the return to Draft when version 2 was saved.
- **A starter template for each new example** — the built-in starters are derived from the two fixture samples by
  kind; a custom-kind starter would need the server's sample registry in the template list. *Duplicate* gives the same
  result (an editable copy with customers of its own).

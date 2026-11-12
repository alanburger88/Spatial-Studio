# InfoSlips Spatial Studio

**Comprehensive POC/MVP Build Specification — Version 1.0**  
**Baseline approved:** 12 November 2026  
**Status:** Approved requirements baseline; implementation specification  
**Identity:** InfoSlips-branded; final brand assets pending  
**Deployment destination:** Pending user instructions at publication stage  
**Classification:** Internal concept and stakeholder demonstration; all example customers and organizations are fictional

> **Product thesis.** Design in 2D. Understand in 2.5D. Simulate across personas and time. Compose into faithful page-based and interactive experiences. The designer should reveal hidden communication complexity while keeping business logic deterministic and auditable.

## 0. Decision record and authority

This document consolidates three product-discovery rounds and the final architectural decisions. These requirements are agreed. The solution is a standalone, extensible, browser-based InfoSlips application. The primary example is a fictional US credit-card statement; the second is a functional healthcare explanation of benefits (EOB). The first slice has 15 authorable component types, real drag-and-drop operations, four genuinely connected spatial visualizations, curated synthetic data, editable journey events, live AI assistance with a reliable fallback, and real PDF and interactive HTML. AFP is explicitly **simulated**, not produced or certified.

**Approved selections:** mixed business/technical audience; hybrid professional visual theme; all four 2.5D views; Exploded Document as hero; fixed and flowing page design plus responsive HTML profiles; editable components and rules; 12 representative personas and approximately 20 rules; three configurable Cube axes; combined population/risk Scenario Landscape; rules, pagination, content parity and basic accessibility diagnostics; private hosted demo plus local fallback; approval-required AI suggestions; standalone codebase; extensible architecture; external AI permitted through a secure server-side adapter.

**Scope terminology:** **POC** means connected, demonstrable functionality for selected cases. **MVP** means an increment suitable for broader pilot use after performance, security, QA and operational hardening. The project defined here is a POC with an MVP-ready architecture, not an enterprise-ready CCM replacement. No release date, vendor contract, hosting platform or brand palette is assumed.

**Unresolved only when needed:** supply the official InfoSlips brand pack when final visual styling begins; supply publication destination, environment access and domain configuration when deployment begins. Neither blocks implementation of a neutral, tokenized theme or a local demo.

## 1. Product vision, users and measurable success

### 1.1 Problem

Traditional CCM tools typically expose a single layout or a succession of previews while hiding the combinatorial effects of rules, data, format, language, personalization and customer-state changes. Designers must mentally reconstruct relationships between scenarios. Layout failures and conditional-content defects are discovered late, often in test outputs rather than during design.

### 1.2 Product promise

Spatial Studio exposes those relationships directly. A user designs a document on a conventional precision canvas, pulls a conditional component into an exploded 2.5D representation, explores the possible variants and why they occur, modifies the data or rule, and watches all relevant views re-resolve. The same model drives genuine paged PDF and interactive HTML renderings with distinct presentation profiles. It can also show how a customer journey changes **future** communications.

### 1.3 Primary users

| User | Primary job | Important evidence in demo |
|---|---|---|
| CCM template designer | Build components and layouts | Real drag, resize, edit, bind, undo and save |
| CCM developer / architect | Model and debug rules | Inspectable data lineage, versioned rules, traceability |
| Business owner / CX leader | Understand outcomes and impact | Personas, clusters, journey, clear visual explanation |
| QA / compliance reviewer | Find defects | Repeatable scenario tests and accurate diagnostics |
| Production specialist | Understand page/AFP constraints | Page overflow, continuation, production profile metadata |
| Executive stakeholder | Assess differentiated value | Immediate visual aha, working outputs, short guided journey |

### 1.4 Demonstration success

The audience must understand the concept in 30 seconds. A demonstrator must complete the signature flow—select conditional payment section, explode variants, change one rule or scenario, recompose, inspect reasoning, export PDF, show responsive HTML—in a single coherent session. A technical user must be able to change a genuine component or rule and see resulting changes rather than a pre-rendered screen swap. The application must make diagnostic findings inspectable and reproducible.

**Initial, noncontractual quality targets:** scenario changes visibly acknowledge interaction within 150 ms; deterministic resolution of typical sample document within 300 ms after relevant input changes on the reference development machine; a normal sample PDF generated within 5 seconds after composition resources have been warmed; 250-row stress scenario completes within 15 seconds; spatial interactions should feel fluid on a modern laptop. These are targets to measure and tune, not existing benchmark results.

## 2. POC scope, boundaries and priorities

### 2.1 In scope

1. Two editable document projects: **Aster Card** (fictional credit-card issuer) and **HarborCare Health** (fictional insurer). Both use the same component library and runtime.
2. A high-quality studio shell with project picker, 2D design canvas, Layers tree, Component palette, Properties inspector, Data/Rules editor, Scenario bar, Journey timeline, four spatial views, Validation drawer, Preview/Export panel, and Guided Demo.
3. Fifteen component classes as specified in §5, with drag/drop, selection, standard transform and common properties; meaningful deep behavior for conditional, repeating and bound components.
4. Two presentation profiles sharing one semantic document: paged (PDF and AFP simulation) and responsive interactive HTML. A profile is editable independently without forking the content or rules.
5. Seeded editable synthetic data, a reproducible scenario generator, and deterministic evaluation with decision traces and rule versions.
6. Editable event timeline with immediate *preview* recomposition; immutable issued snapshots are not modified by later events.
7. Real PDF export, downloadable standalone HTML experience, simulated AFP profile and a visibly labeled AFP readiness panel.
8. Real diagnostics for rule conflicts, missing required content, invalid bindings, selected pagination failures, semantic parity and basic accessibility issues.
9. Secure server-side AI connector supporting a constrained scenario-exploration and explanation toolset; a clear scripted/local command fallback for offline use.
10. Save, load, reset demo, import/export project JSON, undo/redo and guided-demo replay.

### 2.2 Explicitly out of scope

Native production AFP/MO:DCA output; IPDS; print-stream certification; full regulatory conformity of sample credit statements or EOBs; real healthcare PHI or banking PII; live financial/claims data; enterprise customer/tenant management; approval workflow; production archive/delivery; postal optimization; production-scale batch composition; omnichannel orchestration; automatic claim adjudication; autonomous AI rule changes; real payments; formal PDF/UA certification; fully editable arbitrary vector design; real-time team collaboration.

### 2.3 Important safety and domain boundary

Synthetic credit statements are **educational demonstration artifacts**, not legal consumer statements. Regulation Z sets substantive periodic-statement requirements, including disclosures and formatting (CFPB 12 CFR §1026.7). Our fixtures can represent relevant placeholders, but do not imply certification. Synthetic EOBs must visibly state **“THIS IS NOT A BILL”**; an EOB explains plan payments and potential patient responsibility, not a demand for payment. This distinction is documented by CMS. Test cases must not suggest that denied claim amounts automatically become patient obligations.

## 3. Core architecture and invariants

### 3.1 Canonical model

A project consists of **Semantic Document Definition** (structure, IDs, tokens, variants, constraints), **Data Contracts**, **Rules**, **Journey**, **Presentation Profiles**, and **Published/Issued Snapshots**. The same resolved semantic tree is passed to separate output adapters. The spatial views are **projections** of the canonical model and never own independent copies of rules or content.

**Critical invariants:**

- Every node and rule has a stable identifier. Selection persists across 2D, spatial, inspector and output provenance views.
- Rules are pure and deterministic given a versioned snapshot of inputs and rule definitions; evaluation does not invoke the AI provider.
- Numeric financial amounts are stored as integer cents; dates are ISO-8601 values; locale controls formatting but not arithmetic.
- Rule/variant resolution precedes target-specific layout. Target-specific differences may change representation, not factual values or mandatory semantic content.
- Output adapters expose provenance linking semantic node IDs to HTML DOM IDs and PDF page/region diagnostics where feasible.
- Preview is recomposable; **issued** communication snapshots are immutable and content-hash identified. A later journey event produces a new preview/snapshot rather than altering an issued record.
- All external AI actions are validated against a typed allowlist and are nonmutating until the user approves an editable change.
- AFP simulation and estimated population impact must always be labeled accordingly.

### 3.2 Resolution pipeline

`ProjectVersion + DataSnapshot + JourneySnapshot + ScenarioOverrides → Normalize/Validate → EvaluateRules → ResolveVariants → SemanticOutputTree + DecisionTrace → ApplyPresentationProfile → Layout/Compose → PDF / HTML / AFP-Simulation + Diagnostics`.

Prefer a common intermediate **Resolved Communication Tree** (RCT), independent of DOM or PDF internals. The RCT contains semantic objects, resolved values, visibility reasons, provenance, accessibility roles, source node IDs and supported output behavior. It does not store camera orientation or 2.5D view coordinates.

### 3.3 Source of truth and versioning

Projects are versioned with `projectVersion`, `modelSchemaVersion`, and stable IDs. A composition run records `{projectVersion, dataSnapshotId, journeySnapshotId, rulesDigest, outputProfileId, outputEngineVersion, createdAt, contentDigest}`. Published outputs never silently inherit unapproved project edits. Editor undo/redo is implemented as command transactions on the model.

## 4. Information architecture and visual system

### 4.1 Studio shell

**Top rail:** InfoSlips Spatial Studio mark placeholder; project switcher; view switcher; persona selector; target preview; save/undo/redo; Demo button; user/session status. **Left rail:** searchable component palette and hierarchical Layers tree. **Center:** page canvas or spatial visualization. **Right inspector:** context-sensitive tabs for Content, Data, Rules, Layout, Accessibility, Impact. **Bottom dock:** Scenario controls, Journey events, Validation issues, Composition status. **Floating assistant:** natural-language scenario exploration and explanations, never obscuring the selected component.

**Navigation modes:** Design (2D Page), Experience (responsive HTML), Exploded, Cube, Landscape, Page Stack, Rules/Data, Journey, Validate/Production. These are views over a shared project, not separate products. Navigation preserves selection and a breadcrumb back to the editing context.

### 4.2 Visual direction

The UI is a premium hybrid workstation: dark charcoal/navy application surfaces, crisp bright paper canvases, sparing electric cyan/teal focus cues, restrained purple for alternate variants, warm amber for warnings and red for actual errors. Final palette, typeface and logo come from the later InfoSlips brand pack and must be implemented as theme tokens (`--surface`, `--paper`, `--accent`, `--danger`, `--warning`, `--font-body`, etc.). Typography is practical and high-contrast. Shadows and motion indicate hierarchy, not arbitrary decoration.

**Motion language:** 200–450 ms context-preserving transitions, adjustable easing, no gratuitous spins. `prefers-reduced-motion` suppresses unfolding/camera transitions; show an instantaneous flat equivalent. Limit camera tilt and constrain panning. The spatial canvas must never be required to edit legal or financial text precisely.

### 4.3 Screen definitions

| Screen ID | Screen | Primary functions / outputs |
|---|---|---|
| S01 | Project Gallery | Create/open Aster Card or HarborCare; reset fixtures; view last saved state |
| S02 | Design Studio | Drag/drop; select; rich text; rulers/snapping; bound fields; properties; output profile |
| S03 | Exploded Document | Pull a conditional region outward; inspect variants, rules, population and effect |
| S04 | Document Cube | Choose X/Y/Z dimensions; filter slices; inspect an intersection; open output |
| S05 | Scenario Landscape | Cluster outcomes; inspect count, coverage and defects; select representative scenario |
| S06 | Page Composition Stack | Compare paged scenarios; page numbers, continuation and overflow markers |
| S07 | Rules & Data | Edit typed rules; data schema explorer; record editor; decision trace |
| S08 | Journey Simulator | Timeline; add/edit/trigger event; compare before/after; snapshot distinction |
| S09 | Validate & Compare | Test runs; rule issues; page diffs; content parity; accessibility findings |
| S10 | Preview & Export | Responsive HTML, PDF download, AFP simulation, semantic diff, provenance |
| S11 | Guided Demo | Narrated/stepwise guided flow using real state-changing application actions |
| S12 | AI Assistant | Prompts, safe action preview, reason trace, provider status, fallback mode |

### 4.4 Interaction contracts

A selected semantic node stays selected when changing between compatible views. The Inspector is always synchronized to the same ID. A user can return to Design in one action. Each spatial item has an accessible label, a keyboard-selectable equivalent in an adjacent tree/table, and a context menu with `Inspect`, `Compare`, `Show rules`, `Open in designer`, `Validate`. An editor must never mistake a camera movement for an actual layout operation. All state changes show saved/unsaved status.

## 5. Exact 15-component catalog

| ID | Component | POC behavior | Output adaptation |
|---|---|---|---|
| C01 | Container / Section | Nested layout, group children, fixed/flow constraint | Page region vs responsive CSS box |
| C02 | Rich Text | Inline formatting, token insertion, controlled links | Paginated text vs semantic HTML |
| C03 | Image / Logo | Upload supported sample, alt text, crop and fit | Static image / responsive image |
| C04 | Shape / Divider | Lines, rectangles, fill, border | Vector-like CSS/SVG |
| C05 | Header / Footer | Repeating page chrome and document header | Page running area / HTML header |
| C06 | Bound Field | Typed schema path, formatting, null handling | Static resolved value / labeled HTML |
| C07 | Repeating Table | Bound array, row template, columns, sort constraints | Continued page table / sortable/filterable table |
| C08 | Summary / Metric | Calculated or bound value, label, importance | Summary cell / responsive metric card |
| C09 | Chart | Basic bar/donut from data, legend, fallback summary | Static vector/image in PDF / interactive HTML chart |
| C10 | Conditional Region | Condition expression, additive/exclusive behavior | Present/omit resolved region |
| C11 | Variant Set | Named alternatives, exclusive precedence, fallback | One resolved variant; exploded view lists all |
| C12 | Disclosure | Mandatory flag, jurisdiction tags, immutable approved text version | Protected paged block / accessible HTML section |
| C13 | Action / Link | Safe URL, action label, fallback text | Printed URL/QR prompt / active link or button |
| C14 | QR Code | Validated destination, caption, contrast guardrail | Encoded printed QR / optional HTML QR/link |
| C15 | Expandable Explanation | Title, summary, details, semantic associations | Expanded appendix/footnote / details accordion |

**Component capability contract:** all 15 have an ID, type, property schema, data-binding slots, visibility policy, `layoutProfiles`, accessibility metadata, inspector schema, preview rendering, and one or more tests. Complex interactions are deep for C02, C06, C07, C10, C11 and C12; other components may have bounded feature sets. No component may serialize arbitrary executable code.

## 6. Authoring, layout and profile behavior

### 6.1 Real drag-and-drop

A user can drag a palette item onto a permitted target; insertion is previewed; on release the model is updated and one undo transaction created. Select, multi-select, nudge with keyboard, move, resize, snap to grid/guides, align, layer-order, duplicate, delete, lock, and edit common properties. Invalid drop targets show a reason and do not mutate the model. Editing survives save/load and affects composition.

### 6.2 Rich-text and data experience

Rich text permits paragraphs, headings, bold/italic, lists, links and tokens such as `{{customer.givenName}}`, supported by a token picker and field-type hints. A token resolves only from an allowlisted schema path. Missing data follows a defined policy: blank, fallback, suppressed optional section, or hard validation error. Format dates, amounts and percentages using locale-aware formatting. Raw HTML/script is disallowed.

### 6.3 Fixed positioning and flowing regions

Each paged profile defines physical page size, margins, document grid, fixed anchors and **flow regions** with repeat/continuation policies. Page units should be physical (`pt`/`mm`) rather than unbounded pixels. A long repeating table stays inside flow regions, repeats its column heading on following pages and honors keep-with-next/avoid-break constraints to the extent supported by the POC renderer. Fixed positioned blocks may coexist around flowed content but cannot silently overlap it. Overflow triggers a diagnostic if no valid continuation path exists.

For HTML, use a separate editable responsive profile with grid/flex constraints and breakpoints. Content and rules stay shared. HTML can add sort/filter, expand/collapse, charts and actions; the PDF uses documented noninteractive fallbacks. Switching layouts does not overwrite the other's geometry.

### 6.4 Editing boundaries and safeguards

Profiles may hide purely decorative elements and implement presentation-specific fallbacks, but cannot independently change a financial amount, claim outcome, or mandatory disclosure. Show a warning for presentation divergence that might compromise semantic parity. Protected disclosure nodes require an explicit advanced action to edit content version; standard dragging can reposition them within permitted layout constraints but cannot deactivate their business obligation.

### 6.5 Save, undo, reset

Autosave is optional, but explicit `Save` and visible dirty state are required. A user can undo/redo at least 20 structural/content operations in a session. The demo includes `Reset this scenario`, `Reset this project`, `Reload approved sample` and `Export project JSON` with confirmation. Every reset is documented and reversible until a new session is started.

## 7. Detailed 2.5D design specifications

**Spatial principle:** depth must encode a clearly labeled data relationship. Each view has a designated meaning for spatial axes or layering. It does not implicitly make content more correct. A flat table/list equivalent and direct numeric tooltips are mandatory; 2.5D effects must be testable against a conventional 2D counterpart.

### 7.1 Exploded Document — the signature

**Entry:** select a Conditional Region or Variant Set in Design, choose `Explore variants`, or pull the selection using a dedicated, visually indicated handle. The paper remains visible as the base plane. The selected region emerges as a series of offset panels: one for each named variant (including fallback). Connectors tie panels to the canonical component; concise chips show match conditions, representative personas, warnings and estimated synthetic reach. A panel can be selected to show its content, decision trace and related rule. Choosing `Compare` opens two panels side by side; `Edit` returns to the canonical variant editor. `Collapse` restores the original page presentation with the same selection.

**Depth semantics:** Z separation = alternative resolved outcomes of this component, not physical paper layers and not time. Horizontal layout may group similar outcomes, but Z is reserved for variants. Camera supports subtle bounded tilt and zoom, keyboard arrows traverse panel order, and reduced-motion transitions are instantaneous. Panels are actual projections of model variants, not saved screenshots. Editing one variant changes its preview without changing others unless they share underlying content parts.

**Featured walkthrough:** overdue customer shows `Assistance invitation` instead of `Standard pay-now`. Drag its panel forward, change the relevant threshold/condition (after approval if AI-proposed), and verify the selected resolved outcome changes in the page and in exports.

### 7.2 Document Cube — configurable dimensional analysis

**Entry:** choose three dimensions from a bounded list: `persona`, `journeyState`, `outputProfile`, `language`, `paymentStatus`, `accountTier`, `claimStatus`, `networkStatus`. Dimension compatibility is checked; the same dimension cannot be used twice. X, Y and Z are labeled at all times. Axes map to discrete categories, not arbitrary 3D physical distances. A cube cell represents one scenario intersection and shows a count of matching records, resolved variant marker and diagnostic state. Clicking a cell opens a representative scenario and direct route to its document output. Null combinations display `No matching fixture` rather than fake output.

**First demo preset:** X = persona, Y = output profile (PDF/HTML/AFP simulation), Z = journey state. `Configure axes` must work in the POC, with a sensible maximum number of categories (e.g., five categories per axis at once) and pagination/filtering for larger datasets. Avoid 3D occlusion with hide-front-planes, slicers, 2D matrix fallback and an always-visible selected-cell summary. AFP cells are simulation only and cannot be exported to AFP.

### 7.3 Scenario Landscape — outcome clusters, impact and risk

Resolve a controlled set of synthetic scenarios and group them by an **outcome signature**: ordered set of visible variant IDs, key conditional section decisions, output target and selected journey state. Adjacent clusters may be positioned by similarity or common rules; the positioning method is documented. Bubble/platform size encodes synthetic record count, not inferred real-world market share. Height or badge size can encode a selected single metric: rule complexity, number of exception findings or mean page count; the legend must change accordingly. Color indicates diagnostic severity with non-color indicators.

**Interactions:** filter by persona/status/language, click a cluster for exact count, contributing rules, representative customers and issue list; open selected output or exploded component; select `Show defects only`; switch to a nonspatial grouped table. **Coverage:** show `N scenarios evaluated / M planned` and disclose whether counts represent actual seeded records, generated combinations or weighted scenarios. Unreachable rule branches are not demonstrated merely by absence; they require explicit structural or bounded-domain analysis with its limits stated.

### 7.4 Page Composition Stack — real pages, meaningful comparisons

Stack or fan the rendered pages of one or more scenario results with consistent page dimensions. Show page number, source scenario, continuation header placement and layout diagnostics. Users can switch between `Same customer through time`, `Different personas` and `Same content across page profiles`; all pages are derived from real PDF composition metrics or renderer diagnostics. Interactive HTML is shown alongside as a responsive preview, not presented as a literal stack of paper pages. Clicking an overflow marker opens the selected semantic node and flow-region constraint. `Overlay diff` compares two composed pages but never assumes identical page numbering; use node provenance and semantic differences to avoid misleading visual comparisons.

**Special demo:** change transaction count from 12 to 250 and compare 2–6-page results (actual count depends on renderer, not hard-coded). The test checks heading repetition and stable totals. A forced `noContinuation` configuration must produce a genuine overflow diagnostic.

### 7.5 Cross-view synchronized state

Persistent UI state: `{projectId, modelVersion, selectedNodeId, activeScenarioId, selectedPersonaId, journeyCursor, outputProfileId, spatialMode, spatialFilters, activeValidationIssue}`. Mode-specific camera settings are ephemeral. Changing scenario recalculates each dependent view through shared selectors. Selection cannot silently switch to a different node because a spatial item has similar appearance. When a node disappears under rules, keep it selected in the inspector and explicitly state `not rendered in this scenario`.

## 8. Synthetic demonstration data

### 8.1 Seed design

The first bundle contains **100 deterministic synthetic records** (70 Aster Card, 30 HarborCare) generated from seed `SPATIAL-STUDIO-DEMO-2026-11`. Twelve named archetypes serve as persona presets; records can reference the same persona but differ in transactions, language, payment state, claim status and accessibility preference. The user can edit a sample, generate a stress variant, or reset to seed. Synthetic user-facing names, account numbers, provider names and organization names carry conspicuous `DEMO DATA` cues. No real customer or PHI is allowed in the default build.

### 8.2 Persona presets (12)

| ID | Persona | Dominant attributes / example behavior |
|---|---|---|
| P01 | Everyday | English, standard tier, current, 12 transactions |
| P02 | Premier | Premium tier, relationship contact, current |
| P03 | First Missed Payment | 1 missed payment, reminder messaging |
| P04 | Financial Assistance | 2 missed payments, assistance request, approved/supportive variant |
| P05 | Spanish Preferred | Locale `es-US`, translated approved variant, current |
| P06 | Digital First | Prefers interactive HTML, online actions |
| P07 | Paper Preferred | Print-first, QR/URL fallbacks, no interactive-only message |
| P08 | High Volume | 250 transaction rows, multi-page continuation stress |
| P09 | New Cardholder | New account, onboarding content, minimal history |
| P10 | Accessibility Focus | Large-text preference, descriptive labels, high contrast |
| P11 | Rewards Focus | Rewards balance, personalized reward explanation |
| P12 | Edge-Case Customer | Missing optional field, unusually long merchant name, negative credit adjustment |

The healthcare fixtures reuse common customer preference traits where relevant, but do not conflate credit-card attributes with medical claims. In a single-claim view, the resolver supplies a typed `claim` alias for the selected member of the `claims` array, making paths such as `claim.claimId` and `claim.status` unambiguous. In addition, specific EOB scenario presets are `routine-covered`, `deductible-applied`, `out-of-network-review`, `denial-review`, `appeal-filed`, and `multi-claim`.

### 8.3 Concrete primary credit-card fixture

`CARD-0001` (P01 Everyday): account holder **Jordan Mercer**, masked account `•••• 1842`, USD, English, statement period `2026-10-01` to `2026-10-31`, statement issue date `2026-11-01`, due date `2026-11-25`, credit limit **$8,000.00**, previous balance **$1,040.00**, purchases **$508.00**, payments/credits **$300.00**, fees/interest **$0.00**, new balance **$1,248.00**, illustrative minimum due **$45.00**, current, standard tier, 12 synthetic transactions. The balance equation is 1,040 + 508 - 300 = 1,248. APR, payoff and statutory disclosure fields are visibly marked as sample/illustrative and never represented as compliant financial calculations.

`CARD-0002` (P04 Assistance): **Taylor Rivers**, masked `•••• 9027`, locale `en-US`, payment state `overdue`, 2 missed payments, `assistanceRequested=true`, `journeyState=assistance_requested`, balance **$2,460.00**, minimum due **$94.00**, 45 synthetic transactions. The journey produces supportive payment-assistance text, not an ungrounded eligibility promise.

### 8.4 Concrete primary healthcare fixture

`EOB-0001`: **Morgan Lee**, plan **HarborCare Select**, claim `HC-10428`, service `Office visit`, service date `2026-10-18`, billed **$400.00**, allowed **$250.00**, contractual adjustment **$150.00**, plan paid **$200.00**, patient responsibility **$50.00**, status `processed-covered`, in network. Reconciliation: billed = adjustment + allowed; allowed = plan paid + patient responsibility. Render `THIS IS NOT A BILL` prominently.

`EOB-0002`: **Avery Stone**, claim `HC-10429`, service `Diagnostic laboratory`, service date `2026-10-19`, billed **$300.00**, allowed **$0.00**, plan paid **$0.00**, patient responsibility **$0.00**, status `denied-pending-review`, amount requiring review **$300.00**. This is a deliberately simplified *unresolved* mock claim; do **not** infer that $300 is collectible from the member. A validation warning appears if an author tries to show `$300 owed` without an approved liability field.

### 8.5 Edge-case generator

Preset scenarios: zero transactions; one transaction; 250 transactions; 1,000-character merchant description; missing language-specific content; nullable optional field; negative adjustment; value exactly on a rule threshold; crossed rule priorities; two mandatory disclosures; long Spanish copy; small page body region; orphaned heading; combined `premium + overdue + assistance`; claim denied with unknown patient liability; claim with several line items. Generator uses stable seed plus scenario hash and shows inputs before applying them. A user can inspect and edit generated records.

## 9. Twenty exemplar deterministic rules

The following 20 rules are the initial sample rule set. Each has a stable ID, scope, condition and action. Conditions operate on typed values, not formatted strings. Priority is explicit; mandatory disclosures are independent of optional personalization. **The provided 20 count is exactly the seeded exemplar set**, not a claim that 20 rules cover every domain regulation.

| Rule | Scope | Condition (simplified) | Result / constraint |
|---|---|---|---|
| R01 | Card | `paymentStatus = current` | Select `payment-standard` |
| R02 | Card | `missedPayments = 1` | Select `payment-reminder` |
| R03 | Card | `missedPayments >= 2 AND !assistanceRequested` | Select `payment-support-offer` |
| R04 | Card | `assistanceRequested = true` | Select `payment-assistance-requested` |
| R05 | Card | `arrangementStatus = approved` | Select `payment-arrangement-active` (highest exclusive priority) |
| R06 | Card | `tier = premium` | Add optional `relationship-manager` block |
| R07 | Card | `locale = es-US` | Select approved Spanish copy for supported variants; error on missing required translation |
| R08 | Card | `channelPreference = digital` | Expose interactive payment action in HTML; printed URL/QR fallback |
| R09 | Card | `channelPreference = print` | Select print-friendly guidance without interactive-only dependency |
| R10 | Card | `transactions.count > 25` | Enable repeat headings and continuation flow |
| R11 | Card | `rewardsBalance > 0` | Add rewards summary |
| R12 | Card | `documentType = credit-statement` | Require `billing-summary`, `payment-due` and `sample-disclosure-set` nodes |
| R13 | EOB | `claim.status = processed-covered` | Select covered-claim explanation |
| R14 | EOB | `claim.status = denied-pending-review` | Select review-needed explanation; no ungrounded member debt |
| R15 | EOB | `claim.status = appeal-filed` | Select appeal-status guidance |
| R16 | EOB | `claim.network = out-of-network` | Add network explanation |
| R17 | EOB | `claim.deductibleAppliedCents > 0` | Add deductible explanation |
| R18 | EOB | `claim.patientResponsibilityCents > 0 AND claim.liabilityConfirmed` | Show member-responsibility summary |
| R19 | EOB | `claims.count > 1` | Show claim index and multi-claim summary |
| R20 | EOB | `documentType = eob` | Require `not-a-bill-banner`, `claim-identifiers`, `totals-and-terms` |

**Rule priority and exclusivity:** R05 > R04 > R03 > R02 > R01 within `payment-guidance`. R06–R11 are independent additive/formatting conditions. R12 and R20 enforce mandatory-group constraints. A `paymentStatus=current` with `missedPayments>=2` is a contradictory data combination and raises an input-consistency diagnostic; it must not be resolved by hoping priority hides the error. Rule R07 does not authorize machine translation of legal text at runtime.

**Deliberate defect fixtures:** (D01) conflicting exclusive payment outcomes with equal priority; (D02) missing Spanish version for a mandatory section; (D03) page overflow when continuation is disabled; (D04, optional) EOB “amount owed” shown without confirmed patient liability. D01–D03 must be reproducible through a guided demo toggle and appear as real diagnostics from the underlying validators.

## 10. Deterministic rule resolution and traceability

### 10.1 Rule evaluation steps

1. Validate project schema, field types and snapshot consistency.
2. Normalize input dates/time zones, monetary cents, enum values and nulls.
3. Compute derived fields using a versioned pure-functions registry (e.g., `transactions.count`, formatted totals, no LLM calculation).
4. Evaluate each rule against a snapshot; record pass/fail, exact input values, expression tree and rule version.
5. Apply mandatory content policy first, then additive rules, then exclusive variant precedence. An exclusive set must have one selected variant or a flagged unresolved state; `fallback` is an explicit variant, not a silent default.
6. Emit a resolved semantic tree with `visibleBecause`, `dataLineage`, `ruleIds` and `contentVersion` fields per node.
7. Validate semantic obligations, then compose each output target separately.
8. Persist run metadata and diagnostics; published/issued artifacts are immutable.

### 10.2 Policy for overlap and no-match

- **Exclusive, different priorities:** highest applicable priority wins, while losing matches remain in trace; alert only if a policy violation exists.
- **Exclusive, same priority:** blocking ambiguity error, no silently chosen winner.
- **No exclusive match with fallback:** select named fallback and record its use.
- **No exclusive match without fallback:** blocking validation error.
- **Additive matches:** all applicable sections appear in defined order unless prohibited by an explicit exclusion.
- **Mandatory missing:** blocking issue regardless of other rules; not overridden by an AI suggestion.
- **Null field:** obey explicit null policy; never assume false when the distinction matters.

### 10.3 Rule authoring UI

A visual builder shows `IF [field] [operator] [value] AND/OR ... THEN [select variant / show section / set presentation hint]`, with type-safe field picker and syntax validation. Advanced mode displays/edit the same JSON expression tree, not unrestricted JavaScript. Rules show priority, scope, latest version, dependencies and affected content. A `Test this rule` button runs cases and immediately displays decision traces. Draft changes are versioned and can be undone.

## 11. Event-driven journey simulation

### 11.1 Event model

Each event includes `eventId`, `eventType`, effective date/time, typed payload, preconditions, effects, new state and provenance. State transitions are deterministic and reversible in **simulation**; a published statement remains an immutable historical artifact. Journey Preview can show “As customer state stood on day 30” and “New communication generated on day 30”; it must not imply that the issued day-1 statement was rewritten.

### 11.2 Banking journey example

| Step | Synthetic event | State transition | Communication result |
|---|---|---|---|
| Day 1 | `statement.issued` | `current → current`, freezes issue snapshot | Standard statement, real PDF/HTML |
| Day 30 | `payment.missed` | `missedPayments=1`, `overdue` | New reminder communication preview; issued statement unchanged |
| Day 45 | `assistance.requested` | `assistanceRequested=true` | Future assistance communication/next-statement variant |
| Day 60 | `arrangement.approved` | `arrangementStatus=approved` | Active arrangement guidance for next communication |

User can add, delete, reorder permitted demo events, edit payload and replay from start. Timeline indicates what is an event, what is a preview, and what is an immutable issued snapshot. A `Compare snapshots` action selects two states and navigates to Exploded Document or Page Stack as appropriate.

### 11.3 EOB journey example

`claim.received → claim.adjudicated → claim.review.requested → appeal.filed → appeal.resolved` with member-visible status and explanations. The engine does **not** adjudicate coverage. In the sample, a denied claim with `liabilityConfirmed=false` never becomes an amount-due demand. User-modified event states automatically rerun the applicable EOB rules. The timeline exposes event payload and the resulting member-friendly communication.

## 12. AI assistant — safe, useful, and presentation-ready

### 12.1 Purpose and allowed actions

The live AI assistant converts plain-language instructions into approved, typed operations: `select_persona`, `set_scenario_fields`, `navigate_view`, `explain_variant`, `explain_rule`, `suggest_rule_change`, `run_validation`, `compare_scenarios`, `generate_edge_case`. It must not execute arbitrary code, query the web, alter private secrets, send real communications, or mutate rules/content without explicit user acceptance.

**Example:** “Show me a Spanish-speaking cardholder who has missed two payments and requests assistance.” The assistant responds with a proposed structured scenario; the scenario engine validates the fields, resolves the rules, and updates previews. An explanation uses the decision trace as evidence; the LLM must not invent reasons not present in the trace.

### 12.2 Provider design

`AIProvider` interface, configured server-side; server stores credentials outside the client. Send only synthetic, allowlisted scenario/context data to the external provider. Validate tool-call JSON against schemas; discard invalid or unauthorized requests. Separate prompt text from trusted model state. Provide per-request IDs, timeouts, optional rate limiting and redacted demo telemetry. Disable outbound calls entirely in local fallback mode.

### 12.3 Reliable fallback

Offline mode is clearly labeled **Guided Assistant (offline)**. It accepts a documented subset of structured commands and preset demonstrations. It can perform real local scenario selection, trace lookup and deterministic validations; it should not impersonate a live language model or claim AI-generated novelty. Guided Demo defaults to known paths and can switch to live AI opportunistically. If the provider fails, users retain working deterministic scenario actions.

### 12.4 AI change approval

AI suggestions generate a `Proposal` with affected rule IDs, before/after expression, forecasted impacted scenarios, and `Apply` / `Reject`. Applying creates a versioned command and reruns tests; it never bypasses mandatory content protection. Provide a simple provenance label: “Assistant suggestion; evaluated by deterministic engine; approved by user.”

## 13. Composition and cross-format integrity

### 13.1 PDF (genuine POC export)

Create paged HTML from the RCT and paged layout profile using a stable CSS print template. A Chromium/Playwright composition worker creates a PDF, extracts page count, and returns the artifact. Evaluate Paged.js for advanced fragmentation features, but treat it as a candidate requiring test gates, not as guaranteed to solve all pagination requirements. Financial tables must support header repetition, continuation and balance checks. Use consistent font packs in runtime and renderer; protect against layout drift. Export includes demo disclaimer and composition metadata where appropriate. Screen preview and generated PDF must be based on the same composition request, not manually recreated.

### 13.2 Interactive HTML (genuine)

Render from the same RCT with the responsive HTML profile. Include keyboard-accessible expand/collapse, sortable/filterable transaction table (with stable totals), responsive metrics, contextual explanations, accessible chart summary and safe link actions. No internet-only dependencies should be required for the local stakeholder demo once assets have been bundled. Use semantic headings, tables, labels, focus states and text alternatives. Provide a downloadable self-contained HTML package or standalone HTML where feasible; if packaging separates assets, export a ZIP with fixed relative paths.

### 13.3 AFP simulation

Provide a **clearly marked** AFP Output Profile Inspector with paper size, duplex flag, font/resource mapping concept, print overlay concept, continuation regions, resource checklist, and a simulated page-sequence view. Store AFP-relevant metadata in the paged profile for future adapters. A PDF rendering may be used to illustrate page appearance, but must not be renamed `.afp` or described as AFP data. The output panel states `AFP simulation only — no MO:DCA / AFP print stream generated`. The AFP Consortium defines AFP as a document and printing architecture with native objects, resource management and production workflows; these are not implemented by a browser PDF engine.

### 13.4 Semantic parity validation

Each output adapter emits a manifest of semantic node IDs, normalized monetary/date values, disclosure IDs/content hashes, selected variants, visible actions and documented fallbacks. The parity checker compares these manifests rather than requiring pixel-identical layouts. Differences allowed: layout, page count, interactivity and explanatory expansion. Differences not allowed without explicit approved mapping: monetary totals, patient responsibility, disclosure omission, selected customer identity, statement date, or resolved meaning. Tests cover exact sample fixture values. PDF extraction checks are additional smoke tests, not the sole integrity mechanism.

### 13.5 Validation capabilities

| Check | Mechanism | POC outcome |
|---|---|---|
| Exclusive variant collision | Deterministic rule evaluation | Blocking; show both competing rule IDs |
| Missing fallback / required content | Schema + resolved tree validator | Blocking; select affected semantic node |
| Broken or null binding | Typed schema/path resolver | Severity based on field policy |
| Repeating table overflow | Actual layout metrics + continuation policy | Visual page marker; diagnostic details |
| Orphaned heading | Page-layout postcheck (bounded implementation) | Warning with page number |
| PDF/HTML parity | Compare emitted semantic manifests | Blocking for factual value/disclosure mismatch |
| Basic accessibility | HTML semantic checks + automated axe-style checks + manual keyboard checklist | Findings with links; **not** WCAG certification |
| EOB liability inference | Domain-specific invariant | Blocking if unconfirmed debt shown as owed |
| Population impact | Seed-record count or disclosed scenario weights | Clearly marked synthetic count |

Use WCAG 2.2 AA as a design target for the **application and HTML demo**, while treating automated checks as incomplete. PDF accessibility is a later hardening task; do not call the generated PDF PDF/UA-compliant without independent testing.

## 14. Technical architecture and implementation choices

### 14.1 Recommended stack (subject to spike validation)

| Layer | Preferred implementation | Rationale / constraint |
|---|---|---|
| Web app | React + TypeScript + Vite | Component ecosystem; fast development; explicit types |
| App state | Zustand or equivalent with selectors; command-history layer | Shared IDs, selection, undo/redo, view synchronization |
| Schema | JSON Schema + Zod validation, versioned migration hooks | Portable contracts, typed API boundaries |
| Rich text | ProseMirror/Tiptap class editor with restricted schema | Structured inline tokens; safe serialization |
| 2D canvas | DOM/CSS layout primitives + drag/resize overlays | Real selectable text, natural HTML composition |
| Graphic overlays | SVG; optionally React Konva for rulers/guides/shapes | Precise transforms and editable UI chrome |
| 2.5D exploded/stack | CSS 3D transforms + SVG connectors | Legible document DOM; economical interactions |
| Cube/Landscape | React Three Fiber / Three.js with 2D fallback | Interactive discrete spatial scene when helpful |
| Rule engine | Pure TypeScript JSON-AST evaluator | Deterministic, inspectable, nonexecuting expressions |
| API/backend | Node.js + TypeScript + Fastify (or equivalent) | Shared contracts, AI gateway, persistence, export jobs |
| POC persistence | Local SQLite and project JSON exports | Reproducible local mode, simple reset; PostgreSQL-ready repository abstraction |
| PDF composition | Paged HTML/CSS + headless Chromium via Playwright | Real output, controlled headless environment |
| Advanced pagination candidate | Paged.js behind composition adapter | Spike for table continuation and print paged media |
| AI integration | Server-side provider adapter with strict tool schema | Secret isolation, model-agnostic upgrade path |
| Automated testing | Vitest + Playwright + accessibility audit library | Determinism and realistic workflow verification |

**Why DOM-first for editing:** using only bitmap/Canvas for document authoring complicates rich-text selection, focus, browser accessibility and print fidelity. Use DOM as the actual editable/document plane; spatial renderers receive snapshots/thumbnails and semantic metadata. React Konva can handle geometric tools but should not become an incompatible second document model. 3D libraries should handle camera and spatial geometry, not replace all text editing.

### 14.2 Proposed modules

`studio-web`, `model-core`, `schema-contracts`, `rules-engine`, `scenario-engine`, `journey-engine`, `spatial-projections`, `html-renderer`, `paged-renderer`, `composition-service`, `validation-engine`, `ai-gateway`, `fixture-generator`, `demo-orchestrator`. Where practical these are workspace packages rather than independent microservices. The codebase remains a modular monorepo for the POC.

### 14.3 Data and request flow

The UI edits normalized `ProjectModel` through typed commands. Each edit creates an immutable version delta for undo/redo. Selectors compute `ScenarioSnapshot`; the core resolver emits RCT + trace; view-specific projections compute page DOM, HTML DOM, or spatial nodes. The PDF service accepts only a canonical resolved-run ID and approved output profile; it recomposes from that data, avoiding dependence on unsaved UI state. An export job records content digest and returns the PDF artifact and page metrics. Local fallback uses the same core resolver and fixture bundle.

### 14.4 Persistence, security and privacy

The initial private deployment requires password or equivalent access gate, HTTPS, server-side secrets, origin validation, bounded file uploads, and sanitized rich text. Escape data tokens; sanitize URLs; disallow arbitrary script in content and rule JSON. Avoid exposing real personal, card or medical data; only synthetic fixtures are used. AI calls may include synthetic customer descriptors but no production credentials or real personal data. Store project JSON and sample outputs with configurable expiration, and limit access to reviewers. Rate-limit AI/export endpoints. Log technical events without patient/financial content bodies wherever possible.

Local demo must run without an external model provider and without the hosted backend if packaged accordingly; PDF generation in the local fallback may require a bundled local composition service. Define this in the build package and test offline before stakeholder demonstrations.

### 14.5 Logical data types

- `Project`: ID, title, schemaVersion, modelVersion, lastSavedAt, design tokens.
- `DocumentType`: `credit-statement` or `eob`, content structure and domain validation profile.
- `SemanticNode`: stable ID, type, data bindings, content, child IDs, policies, variant configuration, accessibility hints.
- `PresentationProfile`: ID (`paged-pdf`, `paged-afp-sim`, `html-responsive`), node layout map, page/media properties and interaction fallbacks.
- `DataContract`: typed paths and required/optional metadata; no path evaluation against arbitrary objects.
- `Rule`: ID, scope, priority, mode (`exclusive`, `additive`, `obligation`), expression AST and action.
- `Persona`: sample field overrides plus human-readable description.
- `Scenario`: base fixture ID, overrides, simulation seed, selection of journey point.
- `Journey`: event definitions, state transitions, versioned snapshots.
- `Resolution`: run ID, content digest, resolved tree, decision trace, diagnostics, selected output profile.
- `CompositionArtifact`: output type, page count or HTML package, provenance manifest, filename and hash.

## 15. API and schema contracts

The following is a representative API, not a commitment to an external public API. Internal package functions may implement the same contracts locally. `POST` handlers validate inputs and return structured errors with stable codes and trace IDs.

### 15.1 Suggested endpoints

| Verb + path | Purpose | Key output |
|---|---|---|
| `GET /api/projects` | List sample and saved projects | IDs, names, versions |
| `GET /api/projects/:id` | Load canonical model | Versioned project JSON |
| `PUT /api/projects/:id` | Save optimistic-concurrency version | New model version / conflicts |
| `POST /api/projects/:id/reset` | Restore seeded sample | Fresh approved model version |
| `GET /api/projects/:id/schemas` | Typed field registry | Data paths and enum values |
| `GET /api/fixtures` | Browse sample customers | Redacted synthetic summaries |
| `POST /api/scenarios/generate` | Generate edge case | Seeded record and provenance |
| `POST /api/rules/validate` | Syntax and semantic rule checks | Errors, impacted nodes |
| `POST /api/resolve` | Resolve a snapshot | Run ID, RCT, trace, diagnostics |
| `POST /api/journey/replay` | Apply event sequence deterministically | Snapshots, emitted previews |
| `POST /api/compose/pdf` | Produce real PDF from run ID | Job/artifact ID, page metrics |
| `POST /api/compose/html` | Produce HTML package from run ID | Artifact and parity manifest |
| `POST /api/compose/afp-sim` | AFP feasibility simulation only | Page profile report, no AFP bytes |
| `POST /api/validate` | Rule, layout, parity and a11y suite | Typed diagnostics |
| `POST /api/assistant/action` | AI-safe interpretation/action proposals | Validated tool calls and explanations |
| `GET /api/artifacts/:id` | Download owned demo output | PDF or HTML package |

### 15.2 Representative canonical JSON fragment

```json
{
  "schemaVersion": "1.0.0",
  "projectId": "aster-card-demo",
  "documentType": "credit-statement",
  "modelVersion": 1,
  "rootNodeId": "doc-root",
  "nodes": [
    {"id": "doc-root", "type": "container", "children": ["balance", "payment-guidance"]},
    {"id": "balance", "type": "bound-field", "binding": "card.newBalanceCents", "formatter": "usd-cents"},
    {"id": "payment-guidance", "type": "variant-set", "policy": "exclusive", "fallbackVariantId": "payment-standard", "variantIds": ["payment-standard", "payment-reminder", "payment-support-offer", "payment-assistance-requested", "payment-arrangement-active"]}
  ],
  "presentationProfiles": [
    {"id": "paged-pdf", "kind": "paged", "paper": "US-Letter", "pageMarginsMm": [14, 14, 14, 14]},
    {"id": "html-responsive", "kind": "responsive", "breakpointsPx": [600, 960]},
    {"id": "paged-afp-sim", "kind": "afp-simulation", "paper": "US-Letter", "duplex": false}
  ]
}
```

This sample omits content bodies, layout maps and rule definitions for brevity; the accompanying machine-readable fixtures include fuller example records, rules and journey data. A production schema would use discriminated unions keyed by component type and validate referential integrity between node IDs, variants and actions.

### 15.3 Typed rule example and result trace

```json
{
  "id": "R04",
  "scope": "credit-statement",
  "mode": "exclusive",
  "exclusiveGroup": "payment-guidance",
  "priority": 400,
  "when": {"op": "eq", "path": "card.assistanceRequested", "value": true},
  "then": {"op": "selectVariant", "targetNodeId": "payment-guidance", "variantId": "payment-assistance-requested"}
}
```

```json
{
  "runId": "resolve-demo-0002-day30",
  "selectedVariants": {"payment-guidance": "payment-assistance-requested"},
  "decisionTrace": [
    {"ruleId": "R04", "matched": true, "inputs": {"card.assistanceRequested": true}, "outcome": "selected"},
    {"ruleId": "R03", "matched": false, "inputs": {"card.missedPayments": 2, "card.assistanceRequested": true}, "outcome": "not-applicable"}
  ],
  "diagnostics": []
}
```

The trace is an illustrative expected result, not an output from an already implemented engine. Any source values sent to the assistant must be associated with an exact run ID to avoid explanations based on stale scenarios.

### 15.4 Event example

```json
{
  "eventId": "evt-assist-30",
  "effectiveAt": "2026-11-30T10:00:00-05:00",
  "eventType": "assistance.requested",
  "payload": {"requested": true},
  "preconditions": [{"path": "card.paymentStatus", "op": "eq", "value": "overdue"}],
  "effects": [{"op": "set", "path": "card.assistanceRequested", "value": true}],
  "emits": "communication-preview"
}
```

## 16. Guided stakeholder demonstration — approximately 7–8 minutes

The Guided Demo is a sequence of real app interactions with clearly labeled synthetic data. It can run with optional narrator text and user-triggered `Next` buttons. Each checkpoint supports `Pause`, `Explore freely`, and `Reset demo` without losing application reliability.

| Segment | Demo action | Visual / proof point |
|---|---|---|
| 0:00–0:40 | Open Aster Card in premium 2D designer | Familiar crisp statement; editable real component tree |
| 0:40–1:25 | Select Payment Guidance and pull into Exploded Document | Signature unfolding of alternatives with rule/persona chips |
| 1:25–2:05 | Change persona current → assistance, show selected rule | Real variant change and inspectable decision trace |
| 2:05–2:50 | Return to 2D; drag in bound field or conditional content; save | Proof this is an editor, not a viewer |
| 2:50–3:35 | Modify rule threshold, run scenario, inspect impact | Real deterministic evaluation, audience sees cause/effect |
| 3:35–4:20 | Open Cube; reassign an axis; then Landscape risk filter | Connected scenarios, configurable dimensions, diagnostics |
| 4:20–5:10 | Trigger missed-payment and assistance journey events | Time changes future communication; issued snapshot remains fixed |
| 5:10–6:00 | Set 250 transaction rows; open Page Stack; fix overflow | Genuine continuation/page diagnostics, not fake page count |
| 6:00–6:45 | Export real PDF and HTML; inspect semantic parity | Different output strengths, shared data/rules |
| 6:45–7:25 | Open HarborCare EOB and deny/review a synthetic claim | Same core platform, different domain, clear “not a bill” |
| 7:25–8:00 | Ask AI why a variant appeared; show safe action and fallback | Explainable decision trace and presentation resilience |

**Demo guardrails:** never rely on a live AI response to control timing. Aster Card and HarborCare fixtures are always restorable. An AFP panel may be briefly shown if stakeholders ask, but must state simulation. Presentation mode provides a display-safe caption explaining every spatial axis. Demonstrators can skip segments without corrupting state.

## 17. Detailed acceptance tests and exit criteria

Every test has a known fixture, steps and observable result. IDs below form the minimum automated/manual acceptance suite. “PASS” must rely on actual app behavior, not static screenshot comparison alone.

| Test ID | Action / input | Required observable result |
|---|---|---|
| AT-01 | Open Aster Card and reload | Same node IDs/content/profile selection persist |
| AT-02 | Drag C02 Rich Text into allowed flow region | A real editable component appears; saved model updated |
| AT-03 | Resize, align and nudge C06 Bound Field | Geometry persisted in selected profile; undo/redo restores |
| AT-04 | Drop a component into forbidden protected area | Drop blocked; reason shown; model unchanged |
| AT-05 | Insert `{{customer.givenName}}` | Fixture value appears; lineage points to correct field |
| AT-06 | Introduce unknown token path | Schema/binding validation catches problem |
| AT-07 | Create 3 variants for a Conditional Region | All alternatives appear in editor and Exploded view |
| AT-08 | Switch persona P01 to P04 | Correct payment variant selected; rule trace explains why |
| AT-09 | Force R03/R04 conflict at same priority | Blocking overlap finding; no silent arbitrary winner |
| AT-10 | Remove exclusive fallback and make no rule match | Blocking no-match diagnostic |
| AT-11 | Change an unrelated chart style | Financial content digest values remain unchanged |
| AT-12 | Open Exploded, click variant, return to Design | Same semantic node remains selected |
| AT-13 | Expand/collapse repeatedly with reduced motion | No lost model edits; instant accessible alternative works |
| AT-14 | Cube choose persona × language × journey | Recomputed intersections, labels and filters correct |
| AT-15 | Cube select empty intersection | Honest `no matching fixture` state |
| AT-16 | Landscape cluster count vs seeded records | Counts reconcile, synthetic label visible |
| AT-17 | Landscape show defects only | Contains only evaluated scenarios with recorded findings |
| AT-18 | Generate 250-row card scenario | Continuation pages produced; table headings repeat where configured |
| AT-19 | Disable continuation on overflowing region | Real overflow finding and affected node/page indicated |
| AT-20 | Change customer language to `es-US` with missing required copy | Blocking translation/content error, no silent AI translation |
| AT-21 | Trigger Day 30 event | Future preview changes to reminder; Day 1 issued snapshot unchanged |
| AT-22 | Trigger Day 45 assistance event | Variant and explanation track exact event/rules |
| AT-23 | Edit, reorder and replay permitted event | New deterministic snapshot; timeline matches evaluated state |
| AT-24 | Export PDF from CARD-0001 | Valid PDF with correct account suffix, $1,248 total, pages recorded |
| AT-25 | Export responsive HTML from same run | Sort/filter and expandable explanation work; factual totals preserved |
| AT-26 | Compare PDF/HTML manifests | Required disclosures and amounts match; format-specific differences documented |
| AT-27 | Open AFP simulation | No AFP binary emitted; explicit simulation warning visible |
| AT-28 | Open EOB-0001 | Billed/allowed/plan/member amounts reconcile; “NOT A BILL” visible |
| AT-29 | Open EOB-0002 and insert `$300 owed` with unconfirmed liability | Blocking domain validation prevents misleading amount-due status |
| AT-30 | Ask AI to select assistance persona | Validated scenario tool call changes selection; trace comes from engine |
| AT-31 | Ask AI to change rule; decline proposal | No mutation; approved model version unchanged |
| AT-32 | Disconnect AI provider | Offline labeled fallback still demonstrates core scenario/trace actions |
| AT-33 | Keyboard navigate 2D node tree and spatial alternative | Selected node/variant inspectable without 3D camera |
| AT-34 | Run automated accessibility checks | Results shown with source nodes; no claim of certification |
| AT-35 | Reload project after editing and saving | Edit persists; default fixture can still be restored |
| AT-36 | Guided Demo start → finish → reset | No stale state; deterministic replay of every scripted step |

**Exit gates:** (G1) all core tests AT-01–AT-08, AT-12, AT-18, AT-21, AT-24–AT-28, AT-35–AT-36 pass; (G2) all four spatial views are data-driven and usable; (G3) no unresolved severity-1 defects; (G4) offline fallback demo tested; (G5) a technical reviewer can trace outputs to inputs/rules; (G6) visual QA completed at standard laptop viewport and 125% browser zoom; (G7) report limitations candidly. The remaining tests should pass for the claimed feature scope before promoting from POC to pilot MVP.

### 17.1 Test layers

- **Unit tests:** schema, money arithmetic, rule precedence, null handling, state transitions, semantic parity calculations.
- **Contract tests:** JSON model versioning, output adapters, AI tool validation, composition job IDs.
- **Integration tests:** authoring command → resolver → output projections; event replay → new run; validation → navigation to node.
- **End-to-end:** browser drag/drop and export, four spatial modes, guided demo, provider failure.
- **Golden fixtures:** expected semantic manifests for CARD-0001, CARD-0002, EOB-0001, EOB-0002.
- **Visual regression:** typography, selected components, spatial transitions and paged document screenshots across defined viewports.
- **Accessibility:** keyboard-only runs, reduced-motion, focus order and screen-reader spot-check; automated audit is necessary but insufficient.

## 18. Nonfunctional requirements and quality targets

| Area | POC target / boundary |
|---|---|
| Performance | Typical resolution target <300 ms after change; interactive feedback <150 ms; profile metrics visible |
| Composition | Normal fixture PDF target <5 s warmed; 250-row stress target <15 s on reference test system |
| Spatial | Target 45–60 FPS for typical curated scenes on modern laptop; degrade to 2D table when necessary |
| Browser | Current Chromium desktop primary; Firefox/Safari smoke tests to define support matrix |
| Viewport | Optimized for 1440×900 desktop; still usable at 1280×720 with panels collapsible |
| Accessibility | WCAG 2.2 AA design target for studio/HTML; keyboard alternate to every 3D-only insight |
| Availability | Private preview, no production SLA; local demo package must function without internet for core paths |
| Data | Synthetic-only by default; no real PHI/PII; fixture generation deterministic and resettable |
| Security | TLS hosted; server-only AI keys; type validation; sanitization; upload limits; basic access control |
| Auditability | Persist resolved run IDs, rule versions and exported artifact digests |
| Observability | Aggregate timing, error codes, sanitized demo analytics; never log full sensitive payloads |
| Packaging | Reproducible build; lockfile; containerized PDF service; installation/run instructions |
| Reliability | Failed external AI call cannot break core authoring/composition; clear error and fallback |

These are **proposed targets to validate**, not measured performance commitments. Browser-specific output differences will be recorded and mitigated in the reference environment. Font licensing must be checked before bundling any fonts. Avoid proprietary production output claims.

## 19. Engineering risks, trade-offs and mitigations

| Risk | Why it matters | Mitigation / decision gate |
|---|---|---|
| Scope overload | Two docs + 4 spatial scenes + editor + composition is substantial | Build banking vertical slice end-to-end before breadth |
| DOM vs Canvas conflicts | Text editing/selection and 3D projection require different primitives | Canonical model + DOM editing; spatial read-only projections for first slice |
| Pagination fidelity | Browser CSS differs from enterprise CCM/page definitions | Early page-layout spike with 250 rows, table breaks and fixed/flow interactions |
| Four spatial modes feel gimmicky | More visuals do not guarantee better comprehension | Each view answers one question; usability comparison against 2D fallback |
| Cube occlusion | Three categorical axes create dense scenes | Bounded category windows, slicers, labels, 2D matrix fallback |
| Population inference | Synthetic counts may be mistaken for real analytics | Persistent synthetic-data label and visible coverage count |
| AI hallucinations | Incorrect rule explanations harm credibility | Treat decision trace as sole explanation evidence; no autonomous rule execution |
| Privacy / regulated claims | Banking and healthcare fixtures create perceived production validity | Fictional data, disclaimers, content/domain validators, no compliance certification |
| AFP overclaim | AFP is a production architecture, not just PDF pages | Simulation always labeled; native engine explicitly deferred |
| Accessibility of 3D | Depth can become a barrier | Keyboard/table alternatives, reduced motion, contrast, text labels |
| Cross-format drift | Separate profiles could silently diverge on facts | Semantic manifest parity and immutable resolved values |
| Historical mutation | Journey simulator could appear to rewrite issued records | Separate immutable issued snapshot from recomposable previews |
| Local demo failure | Hosted AI/internet cannot be depended on | Bundled fixtures, deterministic offline assistant mode, locally available renderer |
| Tool/provider churn | Frontend and AI ecosystem evolves | Version pinning; adapters; architectural spikes; automated regression tests |

## 20. Phased build plan and gates (sequenced, not scheduled)

**Phase 0 — Design and technology spikes.** Deliver clickable interaction storyboard and verify: DOM rich-text selection with transform overlays, 250-row pagination through chosen renderer, stable semantic IDs through layout/3D views, composition service and reliable local run. **Gate:** no architecture-blocking browser/renderer issue.

**Phase 1 — Connected banking vertical slice.** Implement canonical model, schemas, real 2D editing of selected components, 12 card personas sample setup, R01–R12, decision trace, page and responsive profiles, real PDF and HTML. **Gate:** change a conditional section in designer and see real outputs, save and replay.

**Phase 2 — Signature 2.5D.** Exploded Document and Page Composition Stack; selected-node identity and real page measurements. **Gate:** variants/provenance visible in context; 250-row continuation and overflow demo genuine.

**Phase 3 — Scenario intelligence.** Cube configurable axes, Landscape clustering/population/diagnostics, edge-case generator, visual rule editor. **Gate:** clusters reconcile to seeded scenarios; scenario selections drive the model.

**Phase 4 — Journey and AI.** Event editor, immutable issued snapshots, replay, AI action gateway and labeled offline fallback. **Gate:** user-induced event produces new correct future communication; AI failure leaves deterministic app intact.

**Phase 5 — Healthcare EOB.** Second real template, R13–R20, claim data, liability check, EOB time example; same components and output targets. **Gate:** product is demonstrably not banking-specific.

**Phase 6 — Demonstration hardening.** Visual polish, accessibility alternatives, guided 8-minute path, project reset, private hosted packaging and local fallback. Brand assets applied when provided; publication configured when destination instructions are supplied. **Gate:** complete demo repeated on a clean machine, tests and limitations documented.

**Critical path:** model → rules → paged/responsive outputs → component authoring → Exploded → journey → other spatial projections → EOB → polish. This ordering protects correctness while creating an early wow moment.

## 21. Release checklist and artifacts

The finished POC repository should contain: source code and reproducible lockfile; `README` with setup/command reference; JSON Schemas and generated type definitions; 100 synthetic fixture records and 12 persona presets; complete twenty-rule seed definitions; both editable project JSONs; real PDF and interactive HTML composition adapters; AFP simulation module; four spatial views; event/journey fixtures; test suite; visual design tokens; guided demo configuration; reset command; security/privacy and limitation notices; and a build/test/deployment guide.

**POC handoff:** show a ten-minute technical walkthrough of the canonical model and trace pipeline, run at least one automated test, change one rule in the UI, inspect a generated PDF, view HTML interaction, and demonstrate local fallback. A reviewer should be able to audit what is real versus simulated without relying on presenter assertions.

## 22. Deferred roadmap beyond first slice

- Production AFP/MO:DCA, AFP resource management, IPDS/finishing and certification.
- Enterprise-scalable render farms, queue scheduling, customer-segregated batch operations, full production logging.
- Shared template governance, approval workflow, role/permission policies and collaborative editing.
- Certified regulated-content libraries and comprehensive jurisdiction-specific compliance management.
- Tagged PDF/PDF-UA implementation and verification, full WCAG conformance program and assistive-tech matrix.
- Integration adapters to existing InfoSlips services and third-party CCM/composition engines.
- Real data connectors, managed data contracts, schema evolution and data privacy classification.
- Enterprise scenario-coverage tooling, formal satisfiability checks of complex rule sets, broad combinatorial testing.
- Full responsive design system, multilingual content lifecycle/translation approval workflow, advanced charts.
- Production AI model governance, robust human-approval workflows, content recommendation and optimization loops.
- True multi-user collaboration, real-time cursors, comments, audit trail across approval teams.
- Cross-channel orchestration and customer-journey analytics linked to real response events.

## 23. Research and implementation references

The following are external technical/domain references used to make implementation recommendations and set scope boundaries. They do not mean any technology has been integrated or tested in the POC yet.

1. CFPB Regulation Z, §1026.7, periodic statements: https://www.consumerfinance.gov/rules-policy/regulations/1026/7/
2. CMS, How to read an Explanation of Benefits: https://www.cms.gov/initiatives/your-patient-rights/medical-bill-rights/get-help/guides-resources/read-explanation-benefits
3. W3C WCAG 2.2 Recommendation: https://www.w3.org/TR/wcag/
4. Playwright, Page.pdf API: https://playwright.dev/docs/api/class-page
5. Paged.js, overview and CSS paged media approach: https://pagedjs.org/en/about/
6. React Three Fiber, Canvas: https://r3f.docs.pmnd.rs/api/canvas
7. Konva, drag/drop patterns: https://konvajs.org/docs/react/Drag_And_Drop.html
8. AFP Consortium, AFP FAQ: https://www.afpconsortium.org/faq.html

---

**Specification end — Version 1.0.** Build-time inputs still outstanding only when needed: official InfoSlips branding assets and publication destination. Other scope choices are fixed by this baseline unless explicitly amended.

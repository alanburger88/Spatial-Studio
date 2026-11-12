# InfoSlips Spatial Studio
## POC/MVP Implementation Plan, Architecture Decisions and Delivery Backlog

**Version:** 1.0  |  **Date:** 12 November 2026  |  **Status:** Execution plan based on approved requirements  
**Companion documents:** Comprehensive POC/MVP Build Specification v1.0; Screen-by-Screen UX Blueprint v1.0; Interactive UX Atlas v1.0; Synthetic Fixture Bundle v1.0.

**Architecture decisions frozen by sponsor:** standalone InfoSlips-branded application; US credit-card statement hero and functional healthcare EOB; extensible codebase; external AI allowed through secure server-side integration; final brand assets and deployment destination pending.

> **Delivery strategy:** Create one end-to-end, genuinely working **banking vertical slice** before building four isolated 2.5D demos. Extend the same data, rule, composition and provenance model into the second document type and all four spatial lenses. Treat the attached HTML atlas as a **UX review aid only**.

## 1. Outcome and engineering principles

### 1.1 Definition of done for the POC

A reviewer can open Aster Card; drag, edit and bind a component; define/select conditional variants; enter Exploded Document with persistent node selection; change data or an actual rule and see the resolved output change; trigger a journey event; inspect a real pagination condition; generate valid PDF and interactive HTML from the same resolved run; see an authentic diagnostic; and repeat the story on HarborCare EOB. Cube and Landscape must operate on true scenario projections. Live AI exploration must fail safely into a deterministic local fallback. AFP must always be labeled **simulation only**.

### 1.2 Rules the team must not violate

1. Canonical semantic nodes and immutable stable IDs are the source of truth. A spatial view is a projection, not a second editor or a copied template.
2. Decision engine is deterministic, pure and nonexecuting; AI never directly selects required legal/financial content.
3. Financial amounts stored in integer cents and dates as ISO strings; exact semantic values identical across output targets.
4. Separate page and HTML presentation profiles may use different layouts, but cannot change mandatory values/disclosures.
5. Issued snapshots are immutable; journey events only recompose future previews/snapshots.
6. PDF pagination metrics are measured by the composer, never invented by the visualization.
7. Sample data is synthetic only; EOB clearly states **THIS IS NOT A BILL** and liability is not implied without confirmation.
8. Source content, active scenario, output profile, rules version, and artifact digests remain inspectable end-to-end.
9. Every gesture has keyboard alternative for essential understanding; reduced motion and flat fallback are planned from the beginning.
10. A POC is not a certified banking/healthcare output engine or a production AFP renderer.

## 2. Recommended implementation stack and rationale

| Layer | Recommended selection | Engineering rationale |
|---|---|---|
| Frontend | React + TypeScript + Vite | Mature tooling, typed editing state, fast local preview |
| UI and styling | CSS variables/design tokens, reusable headless controls | Official InfoSlips branding can be applied later without UI rewrite |
| App state | Zustand-style selector store plus typed command history | Persistent selected node; replayable undo/redo; fine-grained subscriptions |
| Canonical model | JSON Schema + Zod/TS contracts, semantic version | Validate stored projects and API boundaries; future migrations |
| Rich text | Restricted ProseMirror/Tiptap-compatible document model | Structured tokens, safe marks, deterministic serialization |
| 2D designer | DOM and CSS layout blocks with drag/resize handles; SVG guides | Real text editing, keyboard access, print rendering reuse |
| Exploded/Page Stack | CSS 3D transforms and SVG connectors | Preserve readable HTML previews; easy controlled perspective |
| Cube/Landscape | Three.js / React Three Fiber, plus 2D table fallback | Real picking and bounded spatial visualization |
| Rules | Typed JSON expression AST evaluator, pure TypeScript | Safety, traceability, deterministic replay |
| Backend | Node.js TypeScript, Fastify-style HTTP adapter | Shared validation packages; straightforward AI and export services |
| Persistence | Local SQLite initially, repository abstraction | Reproducible seed/reset; eventual Postgres portability |
| PDF | HTML/CSS paged layout → headless Chromium/Playwright; evaluate Paged.js | Real PDF export with inspectable page metrics; early pagination spike |
| HTML | Semantic, accessible standalone export with restrained interactive JS | Different presentation, same semantic resolved content |
| AI | Server-side provider adapter, strict action schema, local fallback | Secret isolation, auditable assisted exploration, offline resilience |
| Test suite | Vitest unit/contract; Playwright E2E; axe-based audit + manual checks | Fast rule tests and realistic user-flow validation |
| Local delivery | Monorepo scripts plus containerized export process | Clean-machine demo without external services |

**Library versions:** Use pinned, mutually compatible stable versions at implementation time after spikes; do not hard-code unsupported specific versions in the spec. **Hosting:** no vendor commitment before the sponsor supplies publication instructions.

## 3. Architecture and data flow

```text
User gesture / AI-approved command / journey event
            │
            ▼
Typed Command Bus  ──────────► Undo/redo + model version delta
            │
            ▼
Canonical Project Model (semantic nodes, rules, profiles)
            │                    ▲
            ├── data fixture ────┤
            ▼                    │
Typed Scenario Snapshot + Event State
            │
            ▼
Deterministic Resolver ─────► Decision Trace + Semantic Manifest
            │                          │
            ├────► 2D preview          ├──► Diagnostics / explanation
            ├────► Spatial projections └──► Semantic parity checks
            ├────► Paged renderer ────────► PDF + actual page metrics
            ├────► Responsive renderer ───► Interactive HTML bundle
            └────► AFP-simulation adapter ► Feasibility report only
```

**Suggested monorepo packages:** `apps/studio-web`, `apps/api`, `packages/schema-contracts`, `packages/model-core`, `packages/command-history`, `packages/rules-engine`, `packages/scenario-engine`, `packages/journey-engine`, `packages/spatial-projections`, `packages/html-renderer`, `packages/paged-renderer`, `packages/validation-engine`, `packages/fixture-generator`, `packages/demo-orchestrator`, `packages/ai-adapter`, `packages/test-goldens`.

### 3.1 Mandatory contracts

| Contract | Key fields / behavior | Source of truth |
|---|---|---|
| `ProjectModel` | `projectId`, `schemaVersion`, `modelVersion`, nodes, rules, profiles, tokens | Saved project JSON |
| `SemanticNode` | Stable `id`, type C01–C15, children, bindings, content, constraints, a11y | Canonical tree |
| `ScenarioSnapshot` | Fixture ID, overrides, journey time/state, target profile, seed, context hash | Resolver input |
| `ResolveResult` | `runId`, `tree`, `trace`, `manifest`, diagnostics, `modelVersion` | Pure resolver output |
| `SpatialProjection` | `nodeId`, visual bounds, variant/rule references, group/signature, view metadata | Projection derived from ResolveResult |
| `CompositionJob` | run ID, target, queue status, artifact ID, page metrics, digest, error | Backend composer |
| `ValidationIssue` | code, severity, node ID, rule IDs, fixture/run, reproducible steps | Validator |
| `AIAction` | allowlisted `kind`, typed payload, requires approval flag, trace refs | AI gateway validation |
| `EventSnapshot` | event ID, timestamp/day, state before/after, issued boolean, digest | Journey engine |

**APIs:** preserve the endpoint intent from the approved spec (`/api/projects`, `/api/fixtures`, `/api/resolve`, `/api/rules/validate`, `/api/journey/replay`, `/api/compose/{pdf,html,afp-sim}`, `/api/validate`, `/api/assistant/action`, `/api/artifacts/:id`). Implement shared TS contracts and consistent structured errors with correlation IDs. Avoid unsupported public API commitments.

### 3.2 Reference command sequence

```json
{
  "type": "component.variant.update",
  "projectId": "aster-card-demo",
  "nodeId": "payment-guidance",
  "variantId": "payment-support-offer",
  "expectedModelVersion": 13,
  "patch": {"content": "We can help you explore your payment options."}
}
```

Successful command: validates allowed operation → emits updated `ProjectModel` modelVersion 14 + history entry → invalidates dependent scenario cache → resolves active snapshot → updates 2D and 2.5D selectors → marks any prior export stale until recomposed. Rejected command: stable error code, no partial mutation. Internal event schema must distinguish a template change from a data-override or journey cursor change.

## 4. Workstream allocation and ownership

| Workstream | Responsible capability | Deliverables |
|---|---|---|
| W1 Product and UX | Product owner, product designer | Screen flows, component states, demo narrative, design system |
| W2 Model / rules | Senior TS engineer | Canonical contracts, engine, decision trace, undo history |
| W3 Authoring / layout | Frontend document engineer | Drag/drop, rich text, profiles, flow regions |
| W4 Spatial | Frontend visualization engineer | Exploded, Cube, Landscape, Page Stack with flat alternatives |
| W5 Composition | Document/composition engineer | Real HTML/PDF, pagination, metrics, parity artifacts |
| W6 Scenario / journey / AI | Backend+frontend engineer | Fixtures, event replay, assistant gateway/fallback |
| W7 Quality & delivery | QA/automation and DevOps support | Unit/E2E, accessibility, packaging, guided demo stability |

**Practical team shape for planning:** product owner (part-time), UX/UI designer (0.5–1 FTE early), senior frontend engineer, document/editor frontend engineer, backend/composition engineer, visualization engineer (can overlap with frontend), QA automation engineer (part-time then full later). This is **planning capacity**, not assigned staff.

### 4.1 Indicative effort and calendar assumptions

Because this is a real editor plus four data-driven spatial modes and two composition outputs, a credible connected POC is substantially more work than a visual demo. With approximately **four experienced engineers plus design/QA support**, plan a **roughly 20–26-week calendar envelope** if phases overlap sensibly. A thinner cinematic mock could be faster but would violate the agreed real-functionality criterion. A smaller team or a more ambitious pagination engine can push beyond that range. These are directional planning estimates, not commitments.

Use two-week iterations and milestone gates. Keep planning in *ranges* until the three technical spikes validate DOM editing, paged flow, and stable spatial-projection IDs. The actual project plan should be baselined after those spikes.

## 5. Phased build and release gates

### Phase 0 — Product foundations and risk spikes (illustrative 2–3 weeks)

**Goal:** eliminate architecture killers before visual polish.  
**Build:** repository/tooling, fixture import smoke test, one editable DOM text block with drag/resize and caret stability, one two-page flow region with 250-row table, `selectedNodeId` preserved between page and a spatial projection, headless PDF service producing page metrics. Establish design tokens and screen skeleton using the UX atlas.

**Work packages:** P0-01 repo/CI; P0-02 JSON contracts and seed loader; P0-03 rich-text+transform proof; P0-04 pagination spike; P0-05 projection ID spike; P0-06 technical decision memo.  
**Gate G0:** genuine page overflow/continuation measured; no DOM/transform selection blocker; team adopts or changes stack with evidence. **Kill/redirect condition:** if page composition cannot satisfy fixed+flow requirements, replace adapter before proceeding, not at final QA.

### Phase 1 — Canonical banking vertical slice (illustrative 4–6 weeks)

**Goal:** first trustworthy end-to-end composition.  
**Build:** Aster Card project; types C01–C15 with placeable, configurable contract; deep C02/C06/C07/C10/C11/C12; semantic schema and command history; core R01–R12; 12 persona presets; 70 synthetic card records; data editor; fixed and flowing page profile; responsive HTML profile; actual PDF & HTML; save/load/undo.  
**Work packages:** P1-01 normalized semantic model; P1-02 command bus/history; P1-03 schema registry/token picker; P1-04 rule AST/evaluator/trace; P1-05 drag-drop/layers/inspector; P1-06 content editor/variants; P1-07 paged profile/composer; P1-08 interactive HTML; P1-09 save/reset; P1-10 semantic parity manifest.

**Gate G1:** On a clean fixture, alter payment guidance; change persona; inspect R04 trace; export real updated PDF and HTML; reload without losing edit; pass baseline authoring/composition tests. If this fails, **do not** move effort into Landscape cosmetics.

### Phase 2 — Signature spatial demonstration (illustrative 3–4 weeks)

**Goal:** create the memorable product moment on working model data.  
**Build:** Exploded Document with selected 2D region as anchor; actual variant projections; scene/panel selection, connector lineage, compare/collapse, rule jump and flat accessible list; Page Composition Stack using actual composer metrics, 12↔250 row stress toggle, continuation/overflow link.  
**Work packages:** P2-01 spatial projection contracts; P2-02 exploded scene/transitions; P2-03 selector synchronization; P2-04 compare/edit jump; P2-05 PDF thumbnail/metrics pipeline; P2-06 Page Stack/diff; P2-07 reduced-motion and keyboard alternatives.

**Gate G2:** person selects a page component → sees real variants → picks one → opens exact rule → changes it → collapses to updated page → exports matching PDF; page stack shows measured continuation. This is the **executive and technical proof**.

### Phase 3 — Cube, Landscape and scenario validation (illustrative 3–4 weeks)

**Goal:** prove breadth without uncontrolled combinatorial complexity.  
**Build:** configurable discrete Cube axes (max five visible values each), axis validation and 2D fallback; deterministic grouping of resolved outcome signatures; synthetic population impact/coverage; scenario generator; rule, missing required content and selected accessibility diagnostics; D01–D03 seeded defects.  
**Work packages:** P3-01 scenario index/coverage; P3-02 Cube visualization/slicer; P3-03 Landscape clusters/legend; P3-04 deterministic defect suite; P3-05 source navigation; P3-06 flat matrix/table alternatives.

**Gate G3:** scenario/cube totals reconcile to fixtures; same scenario outcome appears consistently in designer, cube and landscape; defects are produced by validators and can be fixed.

### Phase 4 — Journey simulation and AI (illustrative 3–4 weeks)

**Goal:** show time as a meaningful dimension and AI as a safe interface.  
**Build:** event timeline editor, snapshot immutability/hash, deterministic replay, state compare and recomposition; server-side AI gateway with allowlisted commands, approval overlay, source-backed explanation, provider status, deterministic offline fallback and recorded demo prompts.  
**Work packages:** P4-01 event model; P4-02 replay/state transitions; P4-03 issued snapshot ledger; P4-04 journey UI; P4-05 AI action schema; P4-06 provider adapter; P4-07 fallback runner; P4-08 approval trace/audit.

**Gate G4:** emitted Day-1 record never changes after subsequent events; assistance request modifies next preview; AI offline fallback demonstrates same deterministic scenario without a cloud call.

### Phase 5 — EOB, domain breadth and production diagnostics (illustrative 2–3 weeks)

**Goal:** establish reusability beyond card statements.  
**Build:** HarborCare template, 30 synthetic healthcare records, R13–R20, EOB claim schema, benefit explanation and conditional claim guidance, `THIS IS NOT A BILL` control, liability guardrail, EOB journey example; extend HTML/PDF exports and cross-output checks. AFP readiness **simulation** panel and media metadata.  
**Work packages:** P5-01 EOB schema/template; P5-02 claim rules; P5-03 EOB journey; P5-04 no-unsupported-liability validator; P5-05 AFP simulation; P5-06 cross-domain smoke tests.

**Gate G5:** same component engine and rule runtime produce functional EOB outputs; denied-review claim without confirmed member liability does not display an unsupported debt demand. AFP shows clear simulation label and no .afp file.

### Phase 6 — Showcase hardening and handoff (illustrative 2–3 weeks)

**Goal:** make the complete demonstration resilient, accessible, and delightful.  
**Build:** guided 8-minute controller, motion polish, keyboard/flat fallbacks, viewport adaptation, comprehensive E2E/golden tests, performance profile, seeded reset, private-hosted packaging specification, local offline bundle, visual QA and concise presenter playbook.  
**Work packages:** P6-01 demo controller/checkpoints; P6-02 branded design token adapter; P6-03 accessibility pass; P6-04 visual regression; P6-05 export/AI failure recovery; P6-06 deployment package; P6-07 final rehearsal/handoff.

**Gate G6:** repeat complete scripted demonstration twice from clean reset; required acceptance tests pass; local demo works with network disconnected; no open Severity-1 defects; two domain projects generate real files. Apply official InfoSlips assets if supplied; ask for publication destination **only when deployment is actually requested**.

## 6. Priority backlog by epic and screen

**Priority definitions:** P0 must work for G2 hero vertical slice; P1 required for complete approved POC (G6); P2 refined UX/optional, never used to substitute fake functionality.

| Ticket | Epic / screen | Priority | Functional acceptance |
|---|---|---|---|
| UX-101 | Studio shell / S01–S12 | P0 | Persistent project, persona and selected-node context |
| MOD-101 | Schema registry and canonical nodes | P0 | Save/load 15 typed component classes; stable IDs |
| MOD-102 | Undo/redo command bus | P0 | 20 meaningful operations reversible with one-step history |
| AUT-101 | Drag/drop and transform / S02 | P0 | Valid inserts, selection, nudge, resize; invalid drop has no mutation |
| AUT-102 | Rich text and token picker | P0 | Safe token insertion, typed formatting, null policy |
| AUT-103 | Variants and protected disclosures | P0 | Named variants, correct fallbacks and mandatory protection |
| RUL-101 | Rule AST evaluator / S07 | P0 | Pure deterministic rule precedence, trace and contradiction handling |
| DAT-101 | Fixtures/scenarios | P0 | Seeded 70 banking records, 12 personas and resettable overrides |
| CMP-101 | PDF composition | P0 | Actual PDF, page count, continuation diagnostics, download |
| CMP-102 | Interactive HTML | P0 | Responsive page, transactions sort/filter, details, fallbacks |
| CMP-103 | Semantic parity manifest | P0 | Matching required financial/data nodes across outputs |
| SP-101 | Exploded Document / S03 | P0 | Real named variants, source anchor, inspect/compare/collapse |
| SP-102 | Page Stack / S06 | P1 | Real composed page metrics and stress-view diagnostics |
| SP-103 | Cube / S04 | P1 | Three configurable distinct axes, accurate intersection counts |
| SP-104 | Landscape / S05 | P1 | Outcome signatures, reconciled synthetic counts, issue mapping |
| DAT-102 | Rule & data authoring / S07 | P1 | Visual editor + validated advanced expressions, fixture editing |
| JRN-101 | Event timeline / S08 | P1 | Editable events, replay and immutable issued digest |
| QA-101 | Validation / S09 | P1 | Real D01–D03 findings with node/rule navigation |
| CMP-104 | Export workbench / S10 | P1 | Real HTML/PDF tabs, jobs, stale status and AFP simulation |
| AI-101 | Assistant gateway / S12 | P1 | Validated allowlisted actions, approval before edit |
| AI-102 | Offline fallback / S12 | P1 | No provider dependency for core guided prompt path |
| EOB-101 | HarborCare functional template | P1 | R13–R20, EOB outputs, Not a Bill and liability safeguards |
| DEM-101 | Guided Demo / S11 | P1 | Real state-changing checkpoints with pause/recover/reset |
| A11Y-101 | Keyboard/flat alternative | P1 | All important spatial information available without 3D/pointer |
| OPS-101 | Private and local packaging | P1 | Clean-machine run, reset script, secret isolation |
| VIS-101 | Deep animation polish | P2 | Choreographed nonessential embellishment; motion preference respected |
| VIS-102 | Extended camera customizations | P2 | No effect on canonical model or required content |

**Definition of ready for a ticket:** user outcome, model fields touched, expected command/result, design reference, accessibility behavior, test fixture, acceptance case, error state, and dependency recorded. **Definition of done:** code review, unit/contract/E2E where appropriate, accessibility pass for changed workflow, no unexplained deterministic difference in golden fixture, updated demo documentation.

## 7. Dependencies and critical-path controls

```text
P0 schema + page spike
    ├──► Commands + drag/drop ────────► Exploded Document ───► Demo chapter 2
    ├──► Rule engine + fixtures ──────► Scenario index ───────► Cube/Landscape
    ├──► PDF + HTML adapters ────────► Page Stack + parity ───► Export workbench
    └──► Event schema ───────────────► Journey ──────────────► AI exploration
                                     EOB adds rules and template, not new engine
```

**Do not parallelize at the expense of the model boundary.** A separate team may prototype Cube geometry while rules are built, but it must receive mock projections in the *actual approved projection schema*. Avoid creating hard-coded scene data that later needs wholesale replacement. The page renderer spike is a gate before committing to the chosen paged-layout approach.

### 7.1 Architecture decisions to document in ADRs

- ADR-01: canonical semantic content tree vs target-specific presentation profiles.
- ADR-02: DOM-first authoring plus SVG controls; no Canvas-only rich-text editing.
- ADR-03: deterministic JSON rule AST; explicit exclusivity and obligations.
- ADR-04: CSS 3D for Exploded/Stack; Three-based Cube/Landscape with accessible fallback.
- ADR-05: paged HTML/Chromium composer; measured metadata and overflow reporting.
- ADR-06: snapshot immutability, digests and journey replay.
- ADR-07: server-side AI allowlist, approval and offline fallback.
- ADR-08: simulated AFP as metadata/report only; no production output claim.

## 8. Early proofs and technical spikes (exact checklists)

**Spike A — Rich text vs transforms:** Drag Rich Text C02 into fixed page, type in rich text with cursor selection, resize containing block, insert a bound token, undo, compare Firefox and Chromium focus handling. **Pass:** caret stability, no token loss, accessible keyboard path, serialized structure round-trips.

**Spike B — Pagination:** Compose a fixed header + flowing 12-row statement, then 250 rows, with long merchant names and repeated table headings. Disable continuation. **Pass:** actual PDF artifact and measured page count, correct total, intentional overflow detected, no silent overlap or truncation; otherwise reconsider renderer/layout model.

**Spike C — Cross-view identity:** Select C11 in DOM, project into floating card, select another variant, open rule, return to page, undo rule. **Pass:** `selectedNodeId` unchanged, canonical model version synchronized, no detached duplicate.

**Spike D — EOB trust:** For `denied-pending-review` with `liabilityConfirmed=false`, export both targets and inspect manifest. **Pass:** **THIS IS NOT A BILL** and no unsupported member-debt statement. This spike catches domain-model assumptions early.

**Spike E — Offline demo:** Disconnect network, relaunch local package, resolve fixture, switch persona, generate PDF, execute fallback prompt. **Pass:** no hidden CDN/script/model dependency for critical story.

## 9. Testing strategy and acceptance gates

The approved build spec defines **AT-01 through AT-36**. Do not rewrite away its expected behaviors. Map them to test jobs as follows:

| Gate | Automated/observed evidence | Required reviewers |
|---|---|---|
| G0 feasibility | Spike logs, PDF samples, ID consistency record | Tech lead + UX lead |
| G1 vertical slice | Core authoring/data/rule/export tests; golden card manifest | CCM engineer + QA |
| G2 hero moment | S02→S03→S07→S10 E2E, 250-row page stack | Product owner + CCM engineer |
| G3 analytics | Cube axes, Landscape reconciliation, real D01–D03 validators | QA + data/rules lead |
| G4 time/AI | Issued hash invariant, future preview change, AI approval/fallback | Security/AI reviewer + QA |
| G5 cross-domain | EOB fixtures, no unsupported debt, exports, AFP label | Healthcare domain reviewer + QA |
| G6 showcase | 2 consecutive guided demos, all mandatory ATs, keyboard passes | Sponsor + UX + QA |

**Test categories:**

- Unit: typed formatting, cents arithmetic, rule precedence, null/missing value policy, exclusive ties, input contradictions, snapshot hashing, outcome signatures.
- Contract: schema version, normalized IDs, rule AST parser, tool-action allowlist, composition status, artifact ownership.
- Integration: edit→resolve→manifest→HTML/PDF; event→new preview; issue→selected source node; API errors.
- End-to-end: drag/drop, rich-text token, variant compare, Cube axis change, Landscape cluster selection, Page Stack stress, journey edits, AI rejection/approval, both output downloads.
- Visual regression: S02, S03, S04, S05, S06, S08, S10 at 1440×900 and 1280×720; validate actual rendered outputs at relevant page widths.
- Accessibility: keyboard-only path, reduced motion, visible focus, semantic tables for spatial content, screen-reader sample runs; automated audits supplemented by manual checks.

**Exit policy:** No Severity-1 failures. G1/G2 end-to-end hero sequence must be green. All four spatial views use true data projections. Real PDF/HTML assets accessible; AFP remains simulation. At least one authentic diagnostic and a complete offline fallback are demonstrated. Claim limitations plainly if any noncritical features are deferred.

## 10. Performance, security and nonfunctional budgets

| Attribute | Planning target and measurement |
|---|---|
| Input responsiveness | Acknowledge relevant interaction under 150 ms on reference laptop |
| Typical resolver | Under 300 ms target for curated fixture after state change |
| Normal PDF | Under 5 seconds warmed target; actual value measured and reported |
| 250-row PDF | Under 15 seconds target, with job/progress feedback |
| Spatial views | Target 45–60 fps for curated scenes; 2D fallback if poor |
| Browser/viewport | Chromium primary, Safari/Firefox smoke; 1440×900 designed and 1280×720 usable |
| Accessibility | Design for WCAG 2.2 AA; reduced motion and text equivalents; no claim of certification |
| Privacy | Synthetic-only; no real PHI/PII, no credentials in fixtures/prompts |
| Security | Private access gate, TLS hosted, server-side AI secrets, upload/input validation, rate limits |
| Resilience | Provider outage does not block project editing, rules, PDF or HTML |
| Data provenance | Run ID, rule version, model version, artifact digest and snapshot state accessible |

All numbers are **proposed validation targets** drawn from the approved baseline, not established benchmarks or commitments.

## 11. Risks, mitigations and decisions if gates fail

| Risk | Leading signal | Mitigation / alternative |
|---|---|---|
| Real pagination too complex | Overlap, failing headings, browser print drift | Reconsider paged adapter and narrow fixed+flow affordances before building more visuals |
| Full editor becomes enormous | Multi-select and rich text consume disproportionate time | Preserve 15 placeable classes; prioritize deep C02/C06/C07/C10/C11/C12; defer advanced CAD-like vector editing |
| 2.5D looks beautiful but unclear | Users can't identify why a variant exists | Strengthen labels, connectors, trace chips, flat comparison; test with experienced designers |
| Cube occlusion | Users lose orientation/selection | Clamp camera, slicers, cap visible categories, matrix fallback |
| Landscape count confusion | Audience believes counts represent real customers | Synthetic badge, explicit numerator/denominator, fixture-set link |
| PDF/HTML divergence | Amounts/disclosures differ after profile edits | Resolve once; shared semantic manifest; block export when required parity fails |
| AI invents explanation | Model output contradicts resolver | Explanation from trace only, provider text treated as wrapper, block unsupported claims |
| Demo network dependency | Live provider or CDN stalls | Local bundles and deterministic fallback; rehearsed offline path |
| EOB legal implications | UI treats denied claim as bill | Mandatory banner and liability guardrails; domain reviewer signoff |
| Delivery scope creeps | Stakeholders add whole CCM features | Classify change as P0/P1/P2 and assess impact on gate/schedule |

## 12. Guided stakeholder demo: exact running order and recovery

**Presenter setup:** Clean seeded Aster Card project, persona Everyday, C11 Payment Guidance selected, approved rule set loaded, D01–D03 initially disabled, PDF service warm, no real data, offline fallback tested, browser at reference viewport.

| Target time | Screen/action | Audience takeaway | Recovery if needed |
|---|---|---|---|
| 0:00–0:35 | S01→S02 open Aster Card page | Familiar document but genuinely editable | Reload approved sample |
| 0:35–1:25 | S02→S03 pull C11 into Exploded | Hidden possibilities become visible | Open S03 direct with selected C11 |
| 1:25–2:05 | Switch current→assistance scenario; show rule R04 | Personalization is traceable, not magic | Restore named assistance preset |
| 2:05–2:50 | Return S02; insert bound field, edit variant, save | This is a designer, not an animation | Undo or reset project checkpoint |
| 2:50–3:30 | S07 adjust rule threshold; observe change | One source of truth and deterministic behavior | Restore R03 from seed |
| 3:30–4:15 | S04 change Cube axis, S05 show exception cluster | Explore scenario space and impact | Use default axis preset/filter |
| 4:15–5:05 | S08 missed payment→assistance journey | Future communications respond to events | Replay known four-event timeline |
| 5:05–5:50 | S06 250 rows and overflow diagnostic | Page complexity becomes understandable | Use cached last valid real render, clearly marked |
| 5:50–6:40 | S10 real PDF and HTML; AFP tab simulation | Same facts, different composition strengths | Open last valid artifact with version badge |
| 6:40–7:20 | S01 HarborCare EOB; show Not a Bill, claim variant | Same engine, different domain | Load EOB named scenario fixture |
| 7:20–8:00 | S12 ask why variant appeared; if offline use fallback | AI accelerates discovery but rules stay deterministic | One-click scripted local command |

**Never pretend** a cached artifact is the current run. If recovery uses a prior artifact, display its model/run version and say it is a fallback. Guided Demo only orchestrates real app commands.

## 13. Stakeholder handoff pack and ongoing project controls

**Required repository deliverables:** tested monorepo and lockfile; `README` with one-command local run; canonical schema + 15 component definitions; 20 exemplar rules; 100 deterministic synthetic fixture records and 12 personas; Aster and HarborCare editable projects; PDF and HTML composers; AFP simulation; four spatial views; live AI gateway and deterministic fallback; guided demo controller; automated tests and golden manifest outputs; styling tokens; issue/limitations register; installation and deployment guide.

**Reviews:** product/UX check once each phase; domain and compliance review for EOB/credit content; architectural risk check at G0/G2; accessibility check at G2/G6; a stakeholder rehearsal before G6. Track acceptance by test ID and build version, not by screenshots alone.

**Change protocol:** requested change must state whether it affects model, visualization, outputs, AI, or deployment; estimate effect on gates; update data contract and tests; record a decision. Resist changing agreed architecture because a single animation is awkward.

## 14. Explicitly deferred after the POC

True AFP/MO:DCA/IPDS composition and finishing; enterprise batch scale; production delivery/archiving; certified regulatory content; PDF/UA certification; enterprise authentication/RBAC and approvals; real PHI/financial data and connectors; multiuser collaboration; formal advanced rule satisfiability; full document-production migration; all-device mobile authoring; production AI governance and automated content approvals.

## 15. Pending sponsor inputs and exact request trigger

| Input | Request trigger | Why it is not a blocker now |
|---|---|---|
| InfoSlips logo, brand palette, approved fonts, visual guidelines | When the app shell and showcase visual styling are ready for final brand application (late design/polish gate) | All colors/fonts/logo positions are replaceable design tokens |
| Deployment destination, DNS/domain, access policies and credentials | Only when sponsor instructs team to publish (after local acceptance) | Local package and neutral deployment manifests are built independently |
| Optional AI provider account/credentials | At first live AI gateway integration test; offline fallback can be developed sooner | Typed action model and local fallback require no provider key |

**Immediate execution recommendation:** authorize G0 technical spikes and G1 banking vertical slice as the first development tranche. Do not authorize independent visual-only implementations of four spatial scenes. The single connected model is the differentiator that the prototype must prove.

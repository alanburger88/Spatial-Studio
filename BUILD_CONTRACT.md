# Build Contract — approved complete POC, no decorative substitutes

**Contract version:** 1.0 · **Status:** Ready to build (not implemented) · **Sponsor selections:** rounds 1–3 plus final standalone, credit statement, extensible codebase, external AI.

## Product objective

Deliver a visually stunning **InfoSlips Spatial Studio** desktop-first browser application for mixed business and CCM stakeholders. A designer creates a structured document, edits data and conditions, unfolds one component into real conditional variants (2.5D), explores outcomes in three other genuinely data-driven spatial projections, replays events, validates a problem, and exports the **same resolved facts** into a true paged PDF and interactive HTML. A separate HarborCare EOB template proves engine reuse.

## Scope that must not be silently dropped

- **12 application screens** with the routes, core actions and test hooks defined in `contracts/SCREEN_CONTRACT.json` and `docs/approved/UX_BLUEPRINT.md`.
- **15 components**, as named in `fixtures/component_catalog_15.json`. Each inserts, selects, transforms in a supported region, edits properties, saves and reloads. Deep behavior is required for rich text, data field, repeating table, conditional region, variant set and disclosure; see the approved spec for exact C IDs.
- **Hybrid page editing:** fixed-position elements coexist with flowing regions, content-aware continuation, repeating table headings, measured overflow diagnostics, undo/redo (20 operations), keyboard alternatives and distinct layout profiles for paged/PDF-AFP simulation and HTML.
- **Rules and data:** real visual rule editing + validated typed expression AST (no arbitrary JavaScript), 20 seed rules, 12 personas, 100 synthetic customer records, scenario edge-case generator and traceable deterministic resolution.
- **Four spatial views:** Exploded Document (hero), configurable Cube, outcome-based Landscape, composer-backed Page Stack. Stable IDs, shared selection, calibrated depth meaning, flat fallbacks.
- **Journey:** editable event-driven timeline with immutable issued snapshots, reversible simulation cursor and new previews.
- **AI:** secure external model adapter with allowlisted scenario navigation, source-backed explanation and approval-based edit suggestions; deterministic fallback when offline.
- **Output:** real PDF, downloadable responsive HTML (sorting/filtering and expandable details), AFP simulation with **NO `.afp` bytes**. Semantic parity and visible diagnostics.
- **Demo and quality:** guided eight-minute story, full reset, synthetic data labels, accessibility targets, local offline fallback, gated evidence.

## Architectural invariants (verify by tests)

1. **Canonical immutable/serialized project model** with stable node/rule/content IDs and `schemaVersion`/`modelVersion`.
2. **Pure resolver:** `(versionedProject, typedFixture, overrides, journeyState, outputContext) => resolvedTree + trace + diagnostics + semanticManifest`. No AI calls or browser state dependence inside it.
3. **Unified typed command bus:** editing actions create undoable project model versions. Active resolved results become stale/recomputed on relevant edits. No hidden per-screen copies of conditions.
4. **Presentation profiles share semantic identities:** separate paged vs responsive geometry; parity compares amounts, claim outcomes, required sections, data lineage, not pixels.
5. **Composed page provenance:** page count/overflow from actual renderer and its metrics, not guessed from transaction count or screenshots.
6. **Immutable issuance:** a snapshot gets a canonical digest; later events create later versions without mutating the issued one.
7. **Privacy/security:** synthetic data only, typed/validated inputs, sanitized rich text, allowlisted tokens and URLs, server-side AI credentials, no external deployment without permission.
8. **AFP honestly simulated:** printable paper/media metadata and warnings; never output or claim native AFP/MO:DCA.

## Exact acceptance benchmark: two signature paths

**Hero path:** open `aster-card-demo` with `CARD-0001` → drag/edit a component → select `payment-guidance` → explode its real named variants → choose `CARD-0002` → select actual `payment-assistance-requested` (R04) → trace rule inputs → toggle Rule R04 within editing UI and observe changed resolution → undo change → run Day 30/45 events → 250-row composition with genuine continuation → real PDF and interactive HTML generated and checked for semantic parity. The UI and downloadable artifacts must reflect real state changes.

**Cross-domain path:** open `harborcare-demo` with `EOB-0001` → show paid/allowed/member amounts and `THIS IS NOT A BILL` → switch to `EOB-0002` denied-pending-review → prove that unconfirmed liability never becomes `$300 owed` → export real PDF and HTML with the same semantic facts. AFP remains simulated.

## Explicit anti-shortcut checks

| Claim | Required evidence | Forbidden substitute |
|---|---|---|
| Four spatial views are connected | changing rule/data alters projection identities/markers | fixed scene cards or rotating demo pictures |
| Real authoring | a new bound component survives save/load and appears in exports | overlays that do not update project JSON |
| Rules work | independent reference goldens, traces, tie/no-match findings | branch logic hidden in React views |
| Pagination works | 250-row real PDF + repeated heading + actual page count; noContinuation defect | hardcoded 'six pages' text |
| Journey works | issued snapshot unchanged; preview changes after event | toggled screenshot text |
| PDF works | file starts with `%PDF-`, loads successfully, totals/required text verified | preloaded PDF sample |
| HTML works | saved/exported artifact opens, sort/filter/expand actions work | static HTML table alone |
| AI works | typed command + trace, decline causes no mutation, offline fallback | fabricated LLM explanation |
| Landscape works | sum of cluster sizes = evaluated sample universe | random cluster values |
| EOB guardrails | claim facts reconcile and unconfirmed liability is not a debt | 'amount owed' derived from denied billed amount |

## Narrow first-slice compromises allowed without sponsor approval

- Curated (not unbounded) component configuration affordances. All 15 remain authorable.
- One reliable browser target with documented Firefox/Safari smoke-test limitations.
- Renderer-specific pagination constraints documented and tested; do not hide unsupported flow scenarios.
- A defined 3-axis category cap and 2D slicer in Cube; no unlimited population geometry.
- A limited approved AI command vocabulary and meaningful fallback examples.
- Seeded SQLite/local persistence in lieu of enterprise database. No real integrations.

**Not allowed:** reduce 12 screens to marketing mockups, reduce four spatial views to decorative art, fake PDF page counts, remove separate HTML profile, drop the EOB, silently disable AI approval, replace real PDF with an image, or label AFP ready.

## Success vs verification

`python3 scripts/verify_pack.py` verifies only the **supplied pack**. `python3 scripts/verify_app.py` and the new application test suite verify the **built application**. A successful pack check is NOT application acceptance. Before sign-off, every required gate in `execution/MILESTONE_GATES.md` must have its own evidence and every `AT-01..AT-36` case must be PASS or explicitly NOT PASS/BLOCKED (never quietly skipped). The POC only qualifies as fully accepted if the approved exit gates are green and all required claims are demonstrated.

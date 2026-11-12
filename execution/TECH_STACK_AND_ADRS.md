# Technology decisions and architecture records

**Status:** Approved POC implementation decisions (agent may choose compatible stable patch versions; record deviations in `reports/DECISIONS.md`). **Deployment is NOT authorized.** Use local/dev only. No InfoSlips branding assets or destination are required now.

## Chosen stack

| Layer | Default | Rationale and constraint |
|---|---|---|
| Repository | pnpm workspaces + TypeScript strict mode + Node 22+ LTS | Single install, type-shared contracts; pin via lockfile |
| Web | React + Vite + React Router | Desktop-first browser workbench; no server-side framework required |
| UI | Accessible HTML/CSS modules + CSS custom-property tokens; Radix primitives optional | Hybrid dark shell, white document plane, keyboard-supported controls |
| Document authoring | DOM-backed rich text (e.g., TipTap/ProseMirror) and DnD-kit; Moveable or custom precise handles | DOM is authoritative for text selection and accessible semantics; canvas-only text is forbidden |
| Spatial | CSS `transform: perspective(...)` + SVG overlays for Exploded/Page Stack; React Three Fiber/Three.js for Cube/Landscape if needed | Real 2.5D depth while retaining 2D/list equivalents; WebGL fallback |
| State | Central command store + pure resolver; Zustand/Redux Toolkit optional | Undoable edits and versioned selection state; no per-screen rule code |
| Validation | Zod runtime schemas + JSON Schema exported contracts | Validate all data/rule changes before applying; enforce stable IDs |
| API | Fastify or Express on Node, TypeScript | HTTP `/api/v1`; simple, testable and local-first |
| Persistence | SQLite for local save/restore; JSON seed fixtures | Easy local demonstration/reset, no cloud costs |
| Rendering | DOM/CSS paged renderer with measured pages and print styles, headless Chromium/Playwright PDF | Generate actual PDF; prove continuation rather than guess page counts |
| HTML export | Self-contained responsive HTML bundle with local JS/CSS and semantic manifest | Interactive table sorting/filtering and disclosure details offline |
| Tests | Vitest + React Testing Library + Playwright + axe-core and independent Python oracle | Unit, integration, browser, accessibility and visual evidence |
| AI | Server adapter, configurable hosted provider; local deterministic fallback | Never ship API key in browser; no AI in core resolver |
| CI | Local `verify-all` first; optional GitHub Actions once code exists | Do not provision resources automatically |

## Architecture diagram

```text
Web UI / Routes / Visualizations
        | typed commands + view state
        v
Document command store --> versioned canonical project (SQLite/JSON)
        |                              |
        +--> pure resolver <-----------+--- typed synthetic record + journey overrides
                  | resolved tree / trace / diagnostics / semantic manifest
                  +--> 2D DOM preview / Exploded / Cube / Landscape
                  +--> measured paged layout --> PDF export + Page Stack metrics
                  +--> responsive HTML renderer/export
                  +--> AFP simulation (NO binary)
                  +--> provenance-based validation
                  +--> AI explanation tools (read-only trace)
```

## Package boundaries

```text
apps/web/            # shell, authoring, routes, spatial views, demo & assistant
apps/api/            # save/reload, composition, rule lookup, simulation, AI proxy
packages/model/      # canonical types, identifiers, schema, commands & serializers
packages/resolver/   # deterministic AST evaluation, trace and document semantic tree
packages/layout/     # paged + responsive profiles, measured layout and provenance
packages/renderers/  # PDF generation, HTML export, AFP simulation metadata
packages/scenarios/  # generators, cube aggregation and landscape grouping
packages/validation/ # rule, source-data, layout, content parity, basic a11y checks
packages/ui/         # shared tokens, controls, shortcuts, inspector primitives
```

Do not share code from `oracle/reference_resolver.py` with application runtime. Treat it as independently authored expected-output evidence. It is fine to consume the fixture JSONs.

## Architecture Decision Records (locked)

**ADR-001 — Canonical model:** stable IDs, schemaVersion, modelVersion; immutable/resolved outputs. Separate editing representation from rendering snapshots. A layout profile adds properties to nodes but never changes their semantic ID.

**ADR-002 — Authoring geometry:** edit actual HTML components, keeping fixed anchors and flow containers distinct. Coordinates for paged geometry use points or millimeters in canonical model, not view pixels. HTML uses grid/flex/flow constraints. Node styles apply per target profile.

**ADR-003 — Resolver contract:** use a deterministic, side-effect-free function. Priority resolution: highest-priority exclusive match; equal highest priority is blocking, missing match uses explicitly defined fallback only; obligation nodes cannot be suppressed; additive outcomes combine without duplicates. Pure trace is recordable. Never call AI in resolver.

**ADR-004 — Paged composer:** source truth for page counts is composer layout output. PDF renderer consumes its page tree. 250 rows must continue across multiple pages, repeat configured table heading and remain readable. If browser fragmentation cannot satisfy requirement, implement explicit page grouping and measured per-row content heights, but do not hardcode expected count.

**ADR-005 — Spatial projections:** same resolver snapshot and stable node IDs as design; render projections instead of maintaining copies. Exploded variant source is `variantIds`/rules; Cube intersections require real scenario resolution; Landscape clusters derive group keys from resolved facts; Page Stack uses composed page metrics.

**ADR-006 — Journey:** events edit *simulation* state; issuing snapshots stores a hashed immutable record and its referenced model/data versions. Event replay must never mutate issuance bytes.

**ADR-007 — External AI:** server-only model access with allowlisted tools and explicit user acceptance for mutations. Offline fallback is a deterministic command parser + canned help, clearly labeled as fallback.

**ADR-008 — Monetary correctness:** integer minor currency units in fixtures/resolver; formatting occurs at view/export boundary; avoid floating financial calculations.

**ADR-009 — POC security:** local access in development; synthetic-only demo data; safe rich-text sanitizer and strict binding whitelist; no general user JavaScript expressions, untrusted remote templates or external deployment.

**ADR-010 — Brand/deployment deferred:** replaceable CSS variable tokens; placeholder synthetic issuers Aster Card and HarborCare, InfoSlips product name in app shell. Request official InfoSlips brand assets and publication destination only when respective integration/deploy step begins.

## Required baseline behaviors

- 12 routes in `contracts/SCREEN_CONTRACT.json`; each needs a readable semantic page and screen-specific actions.
- Shared top-bar context: project, persona, selected node, mode, output profile, model version, dirty/saved state.
- Every mutation goes through typed, undoable commands, persists, triggers resolver invalidation and re-projection.
- Provenance links rendered nodes back to rule IDs, field bindings and canonical source nodes.
- Responses include meaningful `error.code`, `error.message`, correlation id and appropriate HTTP status.

## Make-or-buy spikes (agent must document results)

1. DOM rich text plus drag/resize with mixed flow/fixed page coordinates, keyboard nudge.
2. Browser print pagination of 250 rows with heading repetition and measured page provenance.
3. 2.5D transform performance, selection coherence and reduced-motion fallback.
4. Self-contained exported HTML actions offline.
5. Playwright screenshot fidelity at 1440×900 and 1280×720.

Selection changes that preserve these contracts do not require sponsor approval. Record package versions and tradeoffs.

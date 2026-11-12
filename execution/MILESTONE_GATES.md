# Autonomous build milestones and evidence gates

**One mission; multiple locally verified development gates.** Never treat a successfully verified packaging script as a successful application test. The agent may continue autonomously after each successful gate; no routine sponsor approval is required.

| Gate | Minimum working deliverable | Automated evidence | Exit rule |
|---|---|---|---|
| G0: Contract | Scaffold monorepo, typed schema, seeded data, package manager lock, two sample projects | Fixture/oracle Python tests pass, TypeScript typecheck and build pass, manifest schema checks | All commands documented, reproducible fresh-install |
| G1: Banking vertical slice | Functional 2D editor, save/reload, rule editing, trace, approved field tokens, real paged PDF, HTML export, flow continuation | AT-01–AT-11, AT-18–AT-20, AT-24–AT-26, AT-35; 250-row PDF with measured page count + repeated header | Live model edits survive reload and change real exports |
| G2: Spatial hero | Exploded Document + Page Composition Stack connected to real resolver/composer, selected node persists, accessible alternatives | AT-12–AT-13, AT-18–AT-19 plus visual screenshots | No hardcoded scenario cards, no guessed pages |
| G3: Scenario intelligence | Configurable Cube + outcome-based Landscape; 100 synthetic records evaluated, aggregation and risk filters | AT-14–AT-17; per-cluster sum equals analyzed universe | Every selected intersection links to reproducible resolved run |
| G4: Journeys and AI | Editable event ordering, issued-snapshot hash, live provider adapter, offline fallback and consented proposals | AT-21–AT-23, AT-30–AT-32; offline run proof | Issued snapshots unchanged, declined proposal leaves model untouched |
| G5: Cross-domain and accessibility | HarborCare EOB using same engine, EOB liability protection, 12 screens, keyboard and basic axe | AT-27–AT-29, AT-33–AT-34 | EOB exports real PDF and HTML, NOT A BILL visible |
| G6: Showcase and release | Eight-minute guided demo, reset, animations, visual review, local fallback, artifact/report bundle | AT-36 and full acceptance matrix; 12 screenshots, golden output comparisons, final report | No severity-1 defects, accurate unfinished list, reproducible run |

## Standard gate loop

1. Implement smallest real behavior needed for this gate; commit or checkpoint when permissible.
2. Run lint/typecheck/unit/contract tests. Fix failures.
3. Start real app, run API and Playwright browser smoke tests (see `scripts/verify_app.py`). Do not silently skip missing tests.
4. Capture artifacts in `reports/evidence/GN/` with screenshots, test outputs, PDFs, HTML exports and manifests.
5. Update `reports/BUILD_PROGRESS.md` and `reports/ACCEPTANCE_STATUS.json` with PASS/FAIL/BLOCKED/NOT_RUN and evidence paths. Any unsupported claim is FAIL/BLOCKED, not PASS.
6. Advance only after required gate acceptance is met. If blocked by environment, preserve exact failing command and error and work on independent milestones without claiming success.

## Screen-by-screen UX completion rule

Each route needs: screen title/goal, real model data, at least its primary action, empty state, error state, navigation back, selected-node continuity, keyboard path or fallback. An illustrative atlas/screenshot is not a pass.

## Release evidence contract

- `reports/evidence/screens/screen-01.png` … `screen-12.png` from **built app** at 1440×900 (not copied from `reference/`).
- `reports/evidence/exports/card-standard.pdf`, `card-250-rows.pdf`, `eob-covered.pdf`, and corresponding interactive HTML, created from real composer.
- `reports/evidence/manifests/*.json` with resolver/provenance/render summary and page counts.
- `reports/FINAL_IMPLEMENTATION_REPORT.md` including exact commands and 36 individual AT statuses.
- `reports/DECISIONS.md` with ADR deviations; `reports/BUILD_PROGRESS.md` describing last verified state.

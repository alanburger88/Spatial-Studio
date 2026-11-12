# Autonomous implementation checkpoint

**Status:** POC v0.3 (polish pass + "Now" and "Next" bundles) built and verified locally (2026-11-12). Branch `claude/magical-franklin-aonsol`.

## Gate log

| Gate | Status | Last command / result | Evidence path |
|---|---|---|---|
| G0 | PASS | `pnpm test` → 12/12 oracle goldens (byte-identical digests) | `packages/resolver/test/golden.test.ts` |
| G1 | PASS | `pnpm e2e` AT-01–11, 18–20, 24–26, 35 | `reports/evidence/e2e-results.json` |
| G2 | PASS | AT-12, 13, 18, 19 | `reports/evidence/screens/screen-03.png`, `screen-06.png` |
| G3 | PASS | AT-14–17 + scenarios unit tests | `screen-04.png`, `screen-05.png` |
| G4 | PASS (offline AI) | AT-21–23, 30–32 | `screen-08.png`, `screen-12.png` |
| G5 | PASS | AT-27–29, 33, 34 | `reports/evidence/exports/eob-*.pdf` |
| G6 | PASS | AT-36 (demo ×2, identical digests) | `screen-11.png`, `reports/FINAL_IMPLEMENTATION_REPORT.md` |

Last full gate: `./scripts/verify-all.sh --app` → exit 0. Its log is `reports/evidence/logs/verify-all.txt`.

| Stage | Result |
|---|---|
| Pack validation | PASS |
| `verify_app.py` | 18/18 |
| Lint | Clean |
| Unit tests | 113/113 |
| Browser tests | 89/89 (49 acceptance/pack + 29 v0.2/v0.3 feature tests + 11 v0.4 UX tests) |
| Build | OK |

## v0.2 additions (all verified by the tests above)

- Review polish: compact headers, Business/Technical view, light theme (default) + dark, searchable customer picker, consistent status dock, reworked Exploded/Cube/Landscape/Design/Rules/Outputs/Validate/Assistant/Journey/Page Stack/Demo screens.
- Project duplicate/rename/delete; CSV/JSON record import with column matching; custom data fields; impact preview; batch runs to ZIP; image library; Ctrl+K command palette; shortcuts sheet, help menu and first-visit tour; Docker one-command run; Windows-friendly scripts.

## v0.3 additions

- Version history & compare, review/approval workflow with component comments, optional sign-in with roles and an activity log, templates + text styles + brand kit, decision-table view with tie/shadow/gap analysis, regression test cases, Content & Translations (S13), email and SMS channels, 2.5D Landscape restored.

## v0.4 additions (UX pass — 11 changes approved by the user one by one)

- Menu grouped by job (Build / Explore / Check & publish / Help & admin); labelled top bar (*Previewing as*, *Output*, *Saved · vN* always readable) with one settings menu for detail level, theme, tour and shortcuts.
- Demo-only defect controls moved out of Rules & Data and Validate into one status-bar *Demo tools* panel (opens only when clicked).
- Validate & Compare and Preview & Export run automatically and show whether the result is up to date; automatic previews do not add export-history entries.
- Detail panels never open empty (Cube, Landscape, Page Stack, Validate, Design inspector pre-select the most relevant item); Cube cells no longer truncate.
- Design inspector: four tabs (Content, Data & rules, Layout, Review); collapsible component list.
- Business view shows names first with codes on hover (components, fields, customers, languages); rule numbers stay as small tags.
- Project Gallery: one main button per card plus a menu, a *Start here* panel, the synthetic-data statement and a collapsed real-vs-simulated list; restoring an unchanged sample no longer creates a version.
- Content & Translations: drafts save as you type, actions only on the active row, progress bar summary.
- Calmer visuals: rows instead of nested cards, three chip styles, sentence-case headings.
- Narrow windows: side panels become drawers at 900–1100 px; a notice below 900 px. Activity log groups repeated entries under day headings.
- Verified by `e2e/ux.spec.ts` (U01–U11) plus the existing suites; test IDs required by `contracts/SCREEN_CONTRACT.json` are unchanged.

### v0.4 follow-up

- Remaining capital-letter labels removed (Validate, Journey timeline, table headers); the inspector's data section and the translation error use names instead of codes in Business view; 3D Cube axis labels and Landscape captions are no longer cut off.
- The gallery's "Show me where" link highlights the customer picker once the project has really loaded (no timer).
- Design Studio fits the page width by default with a *Page* option; Page Composition Stack opens in Fan view with page 1 on top.
- Screens are separate downloads: first download 1,258 kB → 483 kB (387 kB → 157 kB compressed), measured from the production build.
- Export history keeps one PDF per distinct document (a rebuild replaces the earlier entry).

## Not verified / open

- **Live AI provider:** not exercised; no credentials were used.
- **Firefox/Safari:** smoke test not run.
- **Assistive technology:** screen-reader manual pass not run.
- **Deployment:** none; not authorised.
- **Brand logo:** official artwork to be supplied by InfoSlips (slot ready).
- **Load time:** the size reduction is measured from the build output; no timing was taken on a slow network or a hosted server.
- **Design Studio page size:** at a 1440 px window the page is still about 69% because the panel width limits it; it reaches about 100% only with the component list collapsed.
- **UX pass:** checked in Chromium at 1440×900, 1280×720 and 1000×700, light and dark; not every screen was inspected by eye in every theme/size/view combination, and no usability test with real users has been run.
- **Windows:** scripts made cross-platform but not executed on Windows here; Docker image built and smoke-tested on Linux.
- **Live AI:** still unverified (needs your API key in a local `.env`).

## Exact next runnable commands

```bash
pnpm install && pnpm dev
```

```bash
./scripts/verify-all.sh --app
```

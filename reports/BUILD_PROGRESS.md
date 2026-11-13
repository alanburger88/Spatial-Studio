# Autonomous implementation checkpoint

**Status:** POC v0.6 (assistant on every screen, on top of v0.5 languages and channels) built and verified locally (2026-11-13). Branch `claude/magical-franklin-aonsol`.

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
| Unit tests | 380/380 |
| Browser tests | 152/152 (49 acceptance/pack + 29 v0.2/v0.3 feature tests + 13 v0.4 UX tests + 36 v0.5 tests + 25 v0.6 assistant tests: fixes 6, rules 5, writing 7, side panel 6, import 1) |
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

### v0.4 decisions (D49–D52)

- Design Studio: the component list starts closed on windows under 1500 px, so the page shows at 100% at 1440×900 (was about 69%).
- 3D Cube: a crowded X axis shows full persona names, slanted; a wireframe plane no longer hides labels.
- Export history: a rebuilt PDF hides the earlier entry but its file and link keep working.
- Logo: the official InfoSlips artwork was supplied afterwards and is now in the top bar, the sign-in page and the browser tab (D53). Exported documents keep the issuer's own brand.
- Document Cube: legend switches and *Problems only* filter the Grid, 3D view and table; the 3D view opens on one layer with a stepper (D54).

## v0.5 additions (approved scope changes: languages, email/SMS editing, HTML web experience, blocker list)

- **Languages (D56–D58, D63):** project language list (47 languages), every customer-visible text translatable, top-bar Language selector, draft-marked previews with approved-only exports.
- **AI first-pass translation (D59–D60):** drafts only, token-checked, human approval; bundled Spanish sample drafts for the two sample projects.
- **Email & SMS editing (D61):** new screen S15; wording with data fields, section choice and order, live preview, SMS meter.
- **Interactive HTML (D62):** web-style structure and interactions; device frames in the studio.
- **Cross-customer blocker list (D55):** *All customers* view in Validate & Compare.
- **Exploded Document:** states that versions are the same for every output and shows the document language.
- **First download:** 486 kB → 525 kB (160 kB → 172 kB compressed): the language table and wording catalogue load with the shell.

## v0.6 additions (approved scope change: an assistant across the studio — nine decisions, D65–D71)

Policy (D65): the assistant proposes and a person approves; every applied proposal is one Undo step and is recorded in Activity as assistant-assisted; results are labelled *Built-in* (computed by the studio) or *AI suggestion* (from a model); it never approves, exports or publishes.

| Area | What was built | Works without an AI key | Needs an AI key |
|---|---|---|---|
| Side panel (D71) | **Ask AI** in every screen header; knows the screen, customer and selection; shares its conversation with the AI Assistant screen | Explain, change summary, jump-to actions, the guided assistant | Free-form model answers |
| Validate & Compare (D66) | **Suggested fix** per issue with its effect on all synthetic customers; **Fix all safe issues** | Everything | — |
| Rules & Data (D67, D68) | **Describe a rule**, **Review my rules**, **Find coverage gaps** with a scenario and a ready-to-pin test | Common sentence shapes, the review, coverage | Freer rule sentences |
| Writing (D69) | Reading level, **Fit in one message**, rewrite actions, new message version, subject lines | Reading level, SMS fit | Rewrites, new versions, subject lines |
| Translations (D69) | **Check drafts**, per-language **Glossary** | The check and the glossary | Meaning check, AI drafts |
| Small helpers (D69–D71) | Image descriptions, Explain everywhere, column matching on import, plain-word Activity search | All four (image description from the component's name and place) | Description from the picture itself |
| History / Review (D71) | **Summarise changes** with customer impact | Everything | — |

Engines are pure functions in `packages/scenarios/src/assist/`; model-backed features go through `/api/v1/projects/:id/assist/*`, where model output is validated before it is returned.

## Not verified / open

- **Assistant, model-backed features (v0.6):** no live model call was made (no key in this environment). Rewrites, new message versions, subject lines and free-form rule sentences were exercised only with a stand-in model on the server and intercepted replies in the browser. An AI image description, an AI rewrite of an SMS and AI meaning flags on translations were **never rendered on screen**, even simulated; only their server handling is tested.
- **Assistant, combinations not checked (v0.6):** the read-only (viewer) role, the HarborCare sample project, Technical view and windows narrower than 1280 px were not checked on every new assistant surface. The side panel was checked at 1000×700 on one screen only.
- **Assistant, known limits (v0.6):** rule sentences and Activity search understand English only; the reading level is English only; the History change summary compares the previous saved version with the current one (not automatically "since last approved"); a project reset does not clear its review state.
- **Live AI provider:** not exercised; no credentials were used. This now includes AI translation: the request, the handling of its output and the fallback are tested with a stand-in translator, but no real model call was made.
- **Sample Spanish drafts:** written for the demo by the build agent; not reviewed by a translator.
- **Other languages:** only Spanish was looked at in the outputs. French and others were exercised in unit tests (formatting, adding, obligations) but no translated document in them was inspected.
- **Email clients:** the email is checked as HTML in Chromium only, not in real mail clients.
- **Firefox/Safari:** smoke test not run.
- **Assistive technology:** screen-reader manual pass not run.
- **Deployment:** none; not authorised.
- **Load time:** the size reduction is measured from the build output; no timing was taken on a slow network or a hosted server.
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

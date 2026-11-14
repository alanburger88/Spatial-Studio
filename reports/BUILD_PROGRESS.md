# Autonomous implementation checkpoint

**Status:** POC v0.13 (roadmap wave 3: rebuild from a PDF or Word file, duplicate wording, mapping and assisted import; on top of v0.12) built and verified locally (2026-11-14): 1,051 unit tests and 354 browser tests pass, with lint, build and the pack and app checks. Branch `claude/magical-franklin-aonsol`.

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
| Unit tests | 636/636 |
| Browser tests | 222/222 (49 acceptance/pack + 29 v0.2/v0.3 feature tests + 13 v0.4 UX tests + 36 v0.5 tests + 25 v0.6 assistant tests + 9 v0.7 tests + 11 v0.8 tests + 32 v0.9 tests + 18 v0.10 tests: Blockers screen 11, Releases 7) |
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

## v0.7 additions (templates and CCM integration, phase 1 of 7 — D64, D72, D73)

- **Save as template** (approvers and admins): from a project's menu in the gallery. Carries layout, rules, wording, translations, email and SMS wording, glossary and pinned tests; never customers, history, review state or comments.
- **Numbered versions:** each save is a new frozen version; earlier versions stay usable; a project records the template version it started from. Templates can be retired and brought back.
- **Project files:** export as one JSON file; import as a new draft after the file's shape, every rule and resolvability are checked. An import never replaces an existing document.
- **Design record:** phases 2 to 7 are agreed and not built. Phase 7 is the runnable package per release (D72). AFP direction: PDF now through the print side's own transform, a native writer later.

## v0.8 additions (D75, D76)

- **Generate test customers** (Rules & Data): every outcome once plus edge values, made for one project only, marked *Generated* in the customer picker, replaced on regenerate, removable in one click. The dialog shows what would be created and anything no customer can reach before generating. A customer may prefer any language the studio supports.
- **Assistant panel:** the engine's explanation is one block per rule in plain words; the panel is resizable (drag the left edge or arrow keys) and remembers its width; top-bar menus open above it.
- **Live AI:** the model is told who the current customer is and the names of sample and generated customers (never names from imported records). `scripts/live-ai-check.mjs` checks every model-backed feature against the live model on purpose; automated tests always force the built-in assistant.
- **Name:** the design screen is "Design Studio" in the menu, the heading and the approved screen contract (D80).
- **In progress, not in this build:** a blank project with its own data fields (a third kind of document, with list fields), and setting up a template from a description.

## v0.9 additions (D77–D79)

- **Data Explorer** (new screen, Build menu): every customer as a nested record with typed fields, list rows inside the tree, a Form/JSON switch and a live "what this customer gets" panel. Samples and imported customers are read-only; copies, edits and deletions apply to the document's own customers.
- **Documents with their own data** (a third kind, "Your own data"): a Blank project with the user's issuer name and colour, data fields the user defines including lists with columns, tables bound to lists with a total, customers generated or supplied for the project. The two sample kinds are unchanged (goldens pass).
- **Set up a document from a description or a data file** (New project → Describe your document): a proposal of fields, sections, messages with conditions and email/SMS wording that the person reviews, edits, re-checks and approves before anything is created.
- **Live AI on screen, checked on purpose:** `scripts/live-ui-check.mjs` drove the real screens against Claude Opus 5.5 and all four checks passed (a described document proposed and created; the assistant panel answering about the current customer; a rewrite suggestion; a translation draft for one text). Screenshots: `reports/evidence/screens/live-0*.png`.

## v0.10 additions (D80–D83)

- **Releases and the release package** (template work, phase 2): approving a document creates a frozen, numbered release at stage Test; admins move a release to Production or withdraw it; a handover log; a downloadable package (template, wording per language, data dictionary, test scenarios, reference outputs, README) built on request and kept once built. Releases screen under Check & publish. API in `docs/api/RELEASES.md`, package format in `docs/design/RELEASE_PACKAGE.md`.
- **Blockers screen** (blockers design, phase 1): one always-current list for the whole document, one blocker per root cause, sorted by kind of fix, alternative fixes side by side, and a link to it from every place that shows a blocker.
- **Design Studio** is the screen's name in the menu, heading and approved contract (D80).
- **Fix found by the gate:** pressing Approve or Discard on a translation could do nothing when saving the draft re-flowed the page under the pointer; both buttons no longer depend on the layout holding still.
- **Designs agreed, not built:** blockers phases 2–6 (`docs/design/BLOCKERS.md`); template phases 3–7 (`docs/design/TEMPLATES_AND_CCM.md`).

## v0.11 additions (roadmap wave 1 — D84–D91)

The product owner asked for a critical review, chose improvements one by one, and approved a roadmap in five waves (`docs/ROADMAP.md`). Wave 1 is built:

- **Menu by stage of work** (eight entries, tabs inside each section), **Overview** (status, what is released, next steps worked out from real state), a **guided tour** offered once, and **help for every screen** with a glossary (D87).
- **Blockers phases 2–3:** data problems open in Data Explorer with the fields highlighted; known data problems (approver, reason) set a customer aside, are listed at approval and recorded in each release; "Resolve one by one"; a pinned test offered for what was fixed (D88).
- **Runnable package** per release (template phase 7): `run`, `serve`, `verify`, a data contract and a proof pack; byte-for-byte the studio's email, SMS and web page; writes proof records; measured throughput in `docs/design/RUNNABLE_PACKAGE.md` (D89).
- **Before & after:** who changes between two versions, side by side with outlines, and the edits behind it (D90).
- **Proof for any customer:** proof records without customer data, produced by the studio or added from the runnable package, looked up, re-created and verified (D86, D91).
- **Checked across builders by the integrator:** proof records written by a runnable package were added to the studio and all verified as the same; a changed customer was reported as different. This is now an automated test, on a release approved while it had translation drafts.
- **Found and fixed while integrating:** the runnable package refused its own sample input file (it now accepts a `.json` file with one customer or a list as well as one customer per line); four blockers browser tests still used the old menu (first full run: 281 passed, 4 failed); in the customer import dialog a background refresh could discard a column match chosen by hand, an older defect (second full run: 284 passed, 1 failed); two Activity entries showed a raw address instead of words. The third full run passed with nothing failing.
- **Evidence:** `reports/evidence/screens/w1-*.png` (eight screenshots, from `scripts/screens-wave1.mjs` on a clean stack); `reports/evidence/e2e-results.json` is the third full run.
- **Competitor comparison:** `docs/research/COMPETITORS.md`. It rests on search-result summaries only (the vendors' sites could not be opened from the build environment). Four items from it are held until all waves are done (D85).

## v0.12 additions (roadmap wave 2 — D92–D99)

Four check-in decisions (D92), then seven pieces, each built against a written design and merged by the integrator:

- **Calculations and lookup tables** (D94): a guided builder, a formula view and a plain-words reading of the same expression; tables read by calculations. Rules & data gains the tabs Calculations, Lookup tables and Dates.
- **The document's date and effective periods** (D95): "As issued on" in the status bar, periods on rules, alternatives and sections, the Dates timeline, the date through every route that resolves.
- **Page design depth** (D96): paper, page templates, zones, columns, backgrounds, keeping things together.
- **Accessible PDF checks** (D97): eleven checks by the studio on every PDF, corrections at the source, the "required" setting, a veraPDF bridge.
- **Shared library** (D98): a Library tab, frozen versions, read-only linked content, updates with their impact, where used.
- **Wording rules and checker** (D99): house rules and a document's own, must and should, findings as you type, blockers, AI suggestions checked by the same checker.
- **Clean-up from wave 1** (D93): first download trimmed, audit entries carry ids only, the import dialog keeps hand-chosen matches.
- **Found and fixed by the integrator while checking:** a suggested fix told people to correct the customer's data when the document's date is given per run; plain words repeated a lookup key's name; table problems wrote amounts as "1000.00 dollars"; the selected quick-pick date was unreadable. One list of "reads as a demand for money" wording is now shared by the engine and the wording checker.
- **Verification:** the full gate passed on its first run before the wording checker was merged (924 unit, 327 browser) and again on everything (949 unit, 335 browser).
- **Evidence:** `reports/evidence/screens/w2-*.png` (from `scripts/screens-wave2.mjs` on a clean stack); `reports/evidence/e2e-results.json` is the final run.

## v0.13 additions (roadmap wave 3 — D100–D103)

Two check-in decisions (D100), then three pieces built in separate branches and merged by the integrator:

- **Rebuild from an existing PDF or Word file** (D101): local reading, likely personal details marked, consent and placeholders before anything is sent, a reviewed proposal, several samples compared.
- **Duplicate wording across documents** (D102): a scan of all documents and the library, keep in the library, link with the impact shown.
- **Mapping and assisted import** (D103): the data dictionary and named mappings under Releases, mapping files in the release package, import of wording tables and of data field lists.
- **The first adapter is not built**: it waits for a named target system with a sample template export and its field names.
- **Verification:** the full gate passed on its first run (1,051 unit, 354 browser). The three builders were interrupted once by a usage limit and a container restart and resumed from their saved work.
- **Evidence:** `reports/evidence/screens/w3-*.png` (from `scripts/screens-wave3.ts` on a clean stack); `reports/evidence/e2e-results.json` is that run.

## Not verified / open

- **v0.13 (wave 3), not verified:** **no live AI call** for rebuilding from a file (a stand-in model only; `LIVE_ONLY=rebuild` in `scripts/live-ai-check.mjs` exists and was not run). **No real-world PDF or Word file was tried**: all test files are generated from invented values. The XLIFF importer was not checked against a translation tool. Mapping was not tried on a document with hundreds of fields, and no real package with mappings was composed with real PDFs. Duplicate wording was not tried beyond 5,000 generated texts or on real document sets. No accessibility scan, screen-reader pass or sign-in-on browser run of the new screens. An incomplete mapping does not block approval (confirmed by the product owner, D104).
- **Waves 4 and 5 of the roadmap are not built**, nor blockers phases 4–6 or the first adapter (template phase 6).
- **v0.12 (wave 2), not verified:** **no real veraPDF run** (not installed here; the bridge is tested with a stand-in report, and the rule numbers it treats as expected failures need confirming on a first real run). The studio cannot claim PDF/UA conformance: the composing browser writes no PDF/UA identifier, artifact markers or link descriptions. No accessibility scan or screen-reader pass of the new screens (Calculations, Lookup tables, Dates, Library, the Page panel, the Wording rules panel). No browser run with sign-in switched on (roles are tested at the server and with a stand-in session). No real AI model was called for "Suggest compliant wording". Not exercised by a browser test: the date on Page stack, journeys, the assistant's context, History wording, batches started from the screen and produce-from-release; wording findings inside the rich-text editor and under translation fields; editing calculations and tables with a restricted role; real PDF composition of a dated release package and of a document using library items. Not looked at by eye: the HarborCare sample on Calculations and Lookup tables; every theme and window size for every new screen. Columns are not balanced. A calculation per table row does not exist. The first download is 612 kB (199 kB compressed), up from 509 kB before this wave. Proof fingerprints of documents produced before the paged renderer change (accessibility tags) differ from a fresh run.
- **v0.11 (wave 1), not verified:** no accessibility scan and no screen-reader pass of the new screens (Overview, tabs, tour, help, Before & after, Proof, the resolve pass). No browser run with sign-in switched on for any of them (roles are tested at the server; in the browser with a stand-in session). Runnable package: no container image built or run (no container service here); no fonts included; only Linux, one Node version and one Chromium tried; throughput measured once on one 4-core development machine, not a load test. Before & after: email has no outlines; own-data documents were not run in the browser; not every theme and window size was looked at. Proof: real PDF composition is covered by one live run and the package test, not by the proof unit tests. Blockers: a built-in sample customer with a data problem does not exist, so the read-only path was tested with an imported customer; the resolve pass was not looked at by eye at 1280×720. Help text for Preview & Export, Landscape, Page stack, Journeys, Assistant and Activity was written from the screens' labels and code, not from using every control. The Activity log stores a customer's name for customer and known-data-problem entries (to change before any real customer data is used). The competitor comparison is unconfirmed against the vendors' own pages. **First download:** now 878 kB (284 kB compressed); it was 832 kB before this wave and 525 kB when last reported at v0.5 — the assistant's built-in engines have loaded with the shell since v0.6 and that growth was not reported at the time. Loading them on first use is a candidate for wave 2.
- **v0.10, not verified:** Releases — the PDF preview inside the screen (the test browser cannot show PDFs in a frame; the file itself was checked), the "package failed" state, "Check it again", a document approved before releases existed, keyboard-only use and an accessibility scan; automatic release on approval and admin-only promotion are recommended defaults the product owner has not explicitly confirmed; releases are not linked to the older "publish" action. Blockers — the links from Preview & Export and batch runs were checked once by script, not in the suite; a tie among three or more rules shows as more than one blocker; the status bar opens Blockers only when the previewed customer is blocked; phases 2–6 are not built.
- **v0.9, not verified:** Data Explorer — the browser Back button does not warn about unsaved edits; no accessibility scan; imported customers and the server-rejection display were not exercised in the browser. Own-data documents — dark mode, Technical view and 1280×720 were not checked by eye; the PDF's appearance was checked by text and parity checks, not by eye across layouts; the page's letterhead zone cannot be resized. Setup — column matching cannot be overridden by hand; the built-in reader assumes dollars and ISO dates; generated list rows are placeholders with zero amounts; the slow-request busy state was not observed beyond the live run (about 17 seconds).
- **Live AI on screen:** only the four flows above were looked at with a live model. An AI image description, an SMS fitted by AI, subject lines, a new message version, a rule drafted from a free sentence and meaning flags were verified against the live model at the server (`scripts/live-ai-check.mjs`) but not rendered on screen from a live reply.
- **Generated test customers (v0.8):** three states were never triggered in a test or screenshot: the collapse of more than five unreachable items, the "limit reached" note, and the "document has changed since" note. Nothing larger than the two samples plus a few added rules was generated for, so timing on a large document is unknown.
- **Templates (v0.7):** roles are enforced and tested on the server (author, reviewer, approver, admin). In the browser only the "not allowed" state was checked, by simulating an author's session; no browser run was made with sign-in switched on. Moving a template between two installations was not tried (the project file route was: export, then import into the same installation). A template version cannot be deleted, only superseded or retired.
- **Live AI, checked on purpose (2026-11-13):** with a key supplied by the product owner, `scripts/live-ai-check.mjs` made one call per model-backed feature against Claude Opus 5.5 and all 11 checks passed: the assistant recognises the current customer by name and finds another by name; translation drafts (3 texts, data fields intact); rewrite (plainer); SMS fit in one message; a new message version; subject lines; a rule from a free-form sentence; image description of an uploaded picture (and an honest decline for a built-in mark); the translation meaning check flagged a deliberately wrong draft. These checks call the **server**; the same results were **not looked at in the browser** with live AI on, so on-screen rendering of live results is still unverified. Automated tests always force the built-in assistant and never use the key.
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

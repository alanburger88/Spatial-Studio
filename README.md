# InfoSlips Spatial Studio — POC

**Design in 2D. Understand in 2.5D. Simulate across personas and time. Compose into faithful paged and interactive outputs.**

A working proof of concept of a customer-communications (CCM) design studio. One canonical document model drives a precision 2D editor, four data-driven spatial views, a deterministic rule engine with traceable decisions, an event-driven journey simulator, an approval-gated AI assistant, and **real** PDF and interactive HTML output. Two fictional demonstration documents ship with it: an **Aster Card** credit-card statement and a **HarborCare** explanation of benefits (EOB).

> All people, accounts, providers and organisations are fictional synthetic data. AFP output is a clearly labelled **simulation only**. Nothing here is a certified financial statement, medical document, or WCAG/PDF-UA conformant artefact.

## Quick start

Prerequisites: Node 22.13+, pnpm 10, Python 3.10+ (only for the pack verifiers), and Playwright's Chromium (used by the API to compose PDFs).

```bash
pnpm install
```

```bash
pnpm setup:browser
```

```bash
pnpm dev
```

### Easiest: Docker (Windows, macOS, Linux)

With [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running — no Node, pnpm, Python or browser setup needed:

```bash
docker compose up --build
```

Open **http://localhost:5173/projects**. The first build downloads about 2 GB and takes a few minutes; later starts take seconds. Data (projects, exports, imported records, images, batches) is kept in the `studio-data` Docker volume. Stop with `Ctrl+C`; `docker compose down -v` also deletes the data. The port is bound to your computer only.

### Windows (PowerShell)

1. If PowerShell says *“running scripts is disabled on this system”*, allow scripts for your user once: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` (answer **Y**).
2. `npm install -g pnpm`, then open a new PowerShell window.
3. Run the three commands above from the repository folder. All `pnpm` scripts are cross-platform (`pnpm verify` replaces `./scripts/verify-all.sh --app`; Python is found as `py`, `python` or `python3`).

Open **http://127.0.0.1:5173/projects**. The API runs on **http://127.0.0.1:3001/api/v1** (health: `/api/v1/health`). `pnpm start` runs the API plus the production build via `vite preview` instead of the dev server.

Data lives in `.data/` (SQLite + composed artefacts). Use **Reset demo** in the Project Gallery to restore the approved samples at any time.

## Using the studio

- **Business / Technical** (top bar → settings menu): Business view speaks in plain language — rules read as sentences, and run IDs, hashes and raw expressions sit behind *Proof* disclosures. Technical view shows every engine detail inline.
- **Light / dark theme** (top bar → settings menu). Light is the default; spatial viewports stay dark in both.
- **Customer picker** (top bar): search by name, persona, ID or language.
- **Your own projects**: *Duplicate* any project in the Project Gallery to get an editable copy; copies can be renamed and deleted (the approved samples can only be restored).
- **Your own records**: *Import records* (Project Gallery) accepts CSV or JSON. Every row is checked against the data contract and rejected rows say why; accepted rows get IDs `CARD-5001…` / `EOB-5001…` and appear in every view. Download the CSV template from the import dialog. **Use synthetic or anonymised data only** — records stay in the local `.data` folder. *Remove imported* deletes them.
- **Search everything** with **Ctrl+K** (⌘K on Mac): views, components, rules, customers, projects and actions. Press **?** for keyboard shortcuts; the settings menu in the top bar re-runs the first-visit tour.
- **Data fields** (Rules & Data → *Data fields*): see every standard field and where it is used, and add your own fields (text, choice, number, money, yes/no, date). Rules, text tokens and imports can then use them as `custom.<key>`. Fields are saved with the project and are undoable.
- **Column matching on import**: CSV files can use any column names — each column is matched to a data field automatically (by name or label) and you can change or ignore any match before importing.
- **Impact preview**: before a rule or text change is applied, the studio shows how many customers' documents change, what changes, and whether new blocking issues appear.
- **Image library**: upload PNG/JPEG/WebP images once (they are downscaled in the browser to fit the 280 KB limit) and reuse them in any Image component. The chosen image is embedded in the document so exports stay self-contained. SVG is not accepted, for safety.
- **Batch run** (Preview & Export → *Batch*): compose every customer (or a filtered selection) into one ZIP with PDFs and/or interactive HTML, a `manifest.json` and a `run-report.csv` (pages, timings, blocked and failed records). Records with blocking issues are skipped unless you ask for watermarked drafts.
- **Version history** (click *Saved · vN* in the top bar): every save is kept; see what changed between any two versions in plain words and restore an older one.
- **Review & approval** (status chip in the top bar): Draft → In review → Approved → Published, with comments pinned to components (Inspector → *Comments*). Approval is refused while any synthetic record has a blocking issue or a pinned test fails; editing an approved document returns it to Draft.
- **Users, roles and activity log**: off by default for local use. Set `AUTH=on`, `ADMIN_EMAIL` and `ADMIN_PASSWORD` (e.g. in `.env`) to require sign-in with Author / Reviewer / Approver / Admin roles; the **Activity** screen lists who did what, when.
- **New project from a template** (Gallery → *New project*): credit-card statement, explanation of benefits or a blank letter. **Styles & brand** (Design Studio toolbar): named text styles and a brand kit (colours, document font, logo) applied identically to the studio, PDF, HTML and email.
- **Decision table** and **regression tests** (Rules & Data → *Table* / *Tests*): see each rule group as a grid, with ties, never-winning rules and uncovered combinations flagged; pin scenarios as tests that re-run on every change and show which tests a draft would break.
- **Content & Translations**: every text with its Spanish translation status; draft, approve (data tokens must match the English) and exchange CSV files with translators. Approving the mandatory texts clears the Spanish customers' blocking issue.
- **Email and SMS** (Preview & Export): email-safe HTML (600 px, inline styles, plain-text part, subject and preheader) and SMS with GSM-7/UCS-2 and segment counting — both from the same resolved document, with parity checks.
- **Scenario Landscape** has a *Flat | 2.5D* switch; 2.5D shows clusters on a tilted plane with height = rule complexity or exception count.
- The status bar always shows the same rule & binding check counts as **Validate & Compare** (or the full validation result once you have run it for the current scenario); click it to open Validate.
- **Menu grouped by job**: Build (design, rules, content), Explore (the spatial views and journey), Check & publish (validate, preview/export), Help & admin. Hover a menu item for a one-line description.
- **Top bar**: *Previewing as* chooses the synthetic customer, *Output* the channel; *Saved · vN* opens version history. View, theme, tour and shortcuts live in the settings menu (sliders icon).
- **Checks run by themselves**: Validate & Compare and Preview & Export build their results when opened and again when the document or customer changes, and say whether what you see is up to date. Automatic previews reuse an existing export instead of adding to the export history.
- **Detail panels are never empty**: the Cube, Landscape, Page Stack, Validate and the Design inspector open with the most relevant item already selected.
- **Languages** (Content & Translations): add any of 47 left-to-right languages with **Add language**. Every text a customer reads is listed in three groups (messages & disclosures, labels & headings, email & SMS). **Draft missing with AI** prepares first-pass drafts (with a live AI key; without one, the two sample projects load labelled sample drafts for Spanish). Drafts are never approved automatically: edit them, then **Approve** one by one or **Approve reviewed drafts…**.
- **Switch the document language**: the **Language** selector in the top bar (*Auto* follows the customer's own preference). The Design canvas, Exploded view and Preview & Export (PDF, HTML, email, SMS) follow it. Previews show unapproved drafts and are marked as drafts; a clean export uses approved text only and stays blocked until required text is approved.
- **Email & SMS** (Build menu): edit the subject, preview text, heading, opening and closing text and the text message, insert data fields, choose which sections the email shows and in what order, and watch the live preview with the SMS length and segment count.
- **All customers' blockers**: Validate & Compare → **All customers** lists every blocking issue across the synthetic customers, with who is affected.
- **Interactive HTML** is laid out as a web page (sticky summary bar, section menu, searchable and sortable tables); the studio previews it in a phone, tablet or desktop frame.
- **More room to work**: **Collapse menu** at the bottom of the left menu shrinks it to a strip of icons on every screen (names stay on hover); the choice is remembered. In windows narrower than 1360 px the menu is already an icon strip.
- **Blank project with your own data** (Gallery → *New project* → *Blank project*): an empty page with your own issuer name and colour. Only the customer's name and language are given; you add the data fields in *Rules & Data → Data fields* (text, number, amount, date, choice, yes/no, and **lists** with columns, which a table can show with a total). The studio generates customers to preview with, and you can supply your own.
- **Describe your document** (Gallery → *New project* → *Describe your document*): say what the document is for, optionally add a sample data file, and the assistant proposes the fields, layout, messages and rules. You review, edit and approve before anything is created. A description needs an AI key; a data file alone does not.
- **Data Explorer** (Build menu): every customer as a nested record with typed fields and list rows inside it, a Form/JSON switch, and a live view of which messages that customer gets. Samples are read-only; make an editable copy to change one.
- **Blockers** (Check & publish menu): everything that stops the document being issued, as one list for all customers. One line per cause with the customers it stops, sorted by the kind of fix, with the ways to fix it side by side and their effect before you apply one. Every other screen that mentions a blocker links to it here.
- **Releases** (Check & publish menu): approving a document creates a frozen, numbered release at stage Test. An admin moves a release to Production or withdraws it. Each release downloads as one package for the team that produces the documents (template, wording per language, data dictionary, test scenarios, reference outputs), and a handover log records "received" and "live". See `docs/api/RELEASES.md` and `docs/design/RELEASE_PACKAGE.md`.
- **Generate test customers** (Rules & Data → *Generate test customers*): the studio makes synthetic customers for this document so that every rule, message version, optional section and language is tried, plus edge values around every limit a rule uses. It shows what it would create, and anything no customer can reach, before you generate. They appear in the customer picker under *Generated for this document*, belong to that project only, and are replaced when you generate again.
- **Your own templates** (Project Gallery): an approver or admin can **Save as template…** from a project's menu. It carries the layout, rules, wording, translations, email and SMS wording, glossary and pinned tests, and never customers, history or comments. Saving again adds a numbered version; earlier versions stay frozen and usable, and each project records the template version it started from. Templates can be retired and brought back.
- **Project files**: **Export project file** downloads a project as one JSON file. **Import project** checks a file (its shape, every rule, and that a document can be worked out from it), shows what it contains, and creates a new draft document. It never replaces an existing one.
- **Assistant** (works without an AI key unless noted; it proposes, you approve, and every applied proposal is one Undo):
  - *Panel size*: drag the panel's left edge (or focus it and use the arrow keys) to resize it; double-click resets it.
  - *Every screen*: **Ask AI** in the header opens a side panel that knows the screen, the customer and the selection. **Explain** says in plain words why a customer gets a message; **Summarise changes** lists what changed between saved versions and how many synthetic customers are affected.
  - *Validate & Compare*: every issue has a **Suggested fix** with its effect on all synthetic customers; **Fix all safe issues** applies the low-risk ones in one step.
  - *Rules & Data*: **Describe a rule** in a sentence, **Review my rules**, and **Find coverage gaps** (a scenario and a ready-to-pin test for anything no customer exercises).
  - *Writing help*: reading level, **Fit in one message** for SMS, image descriptions and **Check drafts** for translations are built in; rewrites, new message versions, subject lines and meaning checks need an AI key. A per-language **Glossary** keeps terms consistent.
  - *Import records*: columns are matched to data fields with a reason, and values that do not fit are flagged.
  - *Activity*: search in plain words ("what did the reviewer approve last week"); changes applied from the assistant are listed as such.
- **Document Cube filters**: click a legend chip to show only intersections with that outcome (several can be on at once), or **Problems only** for those with blocking issues or warnings. The Grid and table fade the rest; the 3D view hides them. The 3D view opens on one layer (the previewed customer's) with previous/next buttons; choose **All layers** for the whole cube.
- **Demo tools** (status bar): deliberate defects for demonstrations (rule tie, missing Spanish wording, table overflow, unconfirmed liability, no matching message) live in one panel that opens only when you click it.
- **Design Studio zoom**: the page fits the panel width by default (*Width*); *Page* shows the whole sheet. On windows narrower than 1500 px the component list starts closed so the page shows near full size; open it with **Components** (your choice is remembered).
- **Export history** keeps one PDF per distinct document: rebuilding the same document replaces the earlier entry.
- **Narrow windows**: between 900 and 1100 px side panels become slide-out drawers (buttons appear in the screen header); below 900 px the studio asks for a wider window.

## Verify

```bash
pnpm verify:pack
```

```bash
pnpm lint && pnpm typecheck && pnpm test
```

```bash
pnpm e2e
```

```bash
pnpm verify:app
```

```bash
pnpm verify
```

| Command | What it proves |
|---|---|
| `pnpm verify:pack` | Supplied fixtures, contracts and the independent Python oracle (inputs only) |
| `pnpm test` | 40 unit/integration/API-contract tests incl. all 12 oracle goldens (byte-identical `resultDigest`) |
| `pnpm e2e` | 49 browser tests: AT-01…AT-36 plus the pack's own route and critical-path specs, against the real running app |
| `pnpm verify:app` | The pack's independent live-service smoke check (18 checks) |
| `pnpm evidence` | Regenerates real PDFs, HTML, parity and composition manifests into `reports/evidence/` |
| `node scripts/screens.mjs` | Captures all 12 screens from the running app |
| `node scripts/screens-assist.mjs` | Captures five assistant screens (explain, suggested fix, describe a rule, coverage gaps, translation check) from the running app |
| `node scripts/screens-templates.mjs` | Captures five screens of saved templates and project file import from the running app |

## The screens

| Route | Screen |
|---|---|
| `/projects` | S01 Project Gallery |
| `/studio/:project/design` | S02 Design Studio — drag/drop 15 components, rich text with data tokens, fixed + flow layout, profiles, inspector |
| `/studio/:project/exploded/:nodeId` | S03 **Exploded Document** — the signature 2.5D view of a component's real variants |
| `/studio/:project/channels` | S15 Email & SMS — wording, data fields, sections and live preview |
| `/studio/:project/cube` | S04 Document Cube — three configurable scenario dimensions |
| `/studio/:project/landscape` | S05 Scenario Landscape — outcome clusters, reach and risk |
| `/studio/:project/page-stack` | S06 Page Composition Stack — composer-measured pages, continuation, overflow |
| `/studio/:project/rules-data` | S07 Rules & Data — visual/AST rule editor, trace, scenario data, edge cases |
| `/studio/:project/journey` | S08 Journey Simulator — events, immutable issued snapshots, previews |
| `/studio/:project/validate` | S09 Validate & Compare — rules, bindings, pagination, parity, accessibility |
| `/studio/:project/outputs` | S10 Preview & Export — real PDF, interactive HTML, AFP simulation, parity |
| `/studio/:project/demo` | S11 Guided Demo — 12 real, self-verifying steps |
| `/studio/:project/assistant` | S12 AI Assistant — typed actions, trace-sourced explanations, approval |
| `/studio/:project/content` | S13 Content & Translations — translation status, drafts, approval, CSV exchange |
| `/studio/:project/activity` | S14 Activity — audit log (who did what), users when sign-in is on |

## Architecture

```
apps/web        React + Vite studio (Zustand store, typed command bus, 12 screens)
apps/api        Fastify API: persistence (SQLite), runs, composition worker (Playwright/Chromium),
                validation suites, journey snapshots, assistant gateway (offline + optional Claude)
packages/model      canonical types, field registry (data contracts), commands, seeds, digests
packages/resolver   pure deterministic rule evaluation → resolved tree + trace + semantic manifest
packages/renderers  paged HTML + in-browser paginator (PDF), interactive HTML, parity, AFP simulation
packages/scenarios  Cube, Landscape, edge-case generator, journey replay
packages/validation static rule analysis, binding checks, accessibility mapping
```

One model → one pure resolver → many projections. The browser and the API run the **same** resolver package; exports are composed server-side from an immutable run. See `reports/DECISIONS.md` and `reports/FINAL_IMPLEMENTATION_REPORT.md`.

## Optional live AI

With a key configured, the assistant's model-backed features (rewrites, new message versions, subject lines, free-form rule sentences, translation meaning checks, AI translation drafts, image descriptions from the picture) turn on. Without one they say so, and everything computed keeps working. Only the project's own wording and synthetic data are sent; model output is checked on the server (data fields unchanged, no markup, known ids only) before it is shown.

Offline mode is the default and fully functional; when it does not understand a question it says so and lists questions it can answer. To enable the server-side Claude adapter, create a local, uncommitted `.env` file in the repository root (the API reads it at start-up; real environment variables take precedence):

```bash
AI_PROVIDER=anthropic
AI_MODEL=claude-opus-5-5
AI_API_KEY=your-key-here
```

Restart `pnpm dev` afterwards. Live usage is billed to the Anthropic account that owns the key.

Keys never reach the browser. Model output is treated as untrusted and re-validated against the typed allowlist; rule/content changes are proposals that require explicit approval.

## Continuing development

See **Continuation guide** in `reports/FINAL_IMPLEMENTATION_REPORT.md`, `docs/dev/AGENT_BRIEF.md` (how screens integrate with the store/command bus), and `reports/BUILD_PROGRESS.md`.

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
- **New project from a template** (Gallery → *New project*): credit-card statement, explanation of benefits or a blank letter. **Styles & brand** (2D Design toolbar): named text styles and a brand kit (colours, document font, logo) applied identically to the studio, PDF, HTML and email.
- **Decision table** and **regression tests** (Rules & Data → *Table* / *Tests*): see each rule group as a grid, with ties, never-winning rules and uncovered combinations flagged; pin scenarios as tests that re-run on every change and show which tests a draft would break.
- **Content & Translations**: every text with its Spanish translation status; draft, approve (data tokens must match the English) and exchange CSV files with translators. Approving the mandatory texts clears the Spanish customers' blocking issue.
- **Email and SMS** (Preview & Export): email-safe HTML (600 px, inline styles, plain-text part, subject and preheader) and SMS with GSM-7/UCS-2 and segment counting — both from the same resolved document, with parity checks.
- **Scenario Landscape** has a *Flat | 2.5D* switch; 2.5D shows clusters on a tilted plane with height = rule complexity or exception count.
- The status bar always shows the same rule & binding check counts as **Validate & Compare** (or the full validation result once you have run it for the current scenario); click it to open Validate.
- **Menu grouped by job**: Build (design, rules, content), Explore (the spatial views and journey), Check & publish (validate, preview/export), Help & admin. Hover a menu item for a one-line description.
- **Top bar**: *Previewing as* chooses the synthetic customer, *Output* the channel; *Saved · vN* opens version history. View, theme, tour and shortcuts live in the settings menu (sliders icon).
- **Checks run by themselves**: Validate & Compare and Preview & Export build their results when opened and again when the document or customer changes, and say whether what you see is up to date. Automatic previews reuse an existing export instead of adding to the export history.
- **Detail panels are never empty**: the Cube, Landscape, Page Stack, Validate and the Design inspector open with the most relevant item already selected.
- **Demo tools** (status bar): deliberate defects for demonstrations (rule tie, missing Spanish wording, table overflow, unconfirmed liability, no matching message) live in one panel that opens only when you click it.
- **2D Design Studio zoom**: the page fits the panel width by default (*Width*); *Page* shows the whole sheet. Collapse the component list (chevron on its header) to give the page more room.
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

## The 12 screens

| Route | Screen |
|---|---|
| `/projects` | S01 Project Gallery |
| `/studio/:project/design` | S02 2D Design Studio — drag/drop 15 components, rich text with data tokens, fixed + flow layout, profiles, inspector |
| `/studio/:project/exploded/:nodeId` | S03 **Exploded Document** — the signature 2.5D view of a component's real variants |
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

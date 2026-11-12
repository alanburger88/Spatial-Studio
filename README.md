# InfoSlips Spatial Studio — POC

**Design in 2D. Understand in 2.5D. Simulate across personas and time. Compose into faithful paged and interactive outputs.**

A working proof of concept of a customer-communications (CCM) design studio. One canonical document model drives a precision 2D editor, four data-driven spatial views, a deterministic rule engine with traceable decisions, an event-driven journey simulator, an approval-gated AI assistant, and **real** PDF and interactive HTML output. Two fictional demonstration documents ship with it: an **Aster Card** credit-card statement and a **HarborCare** explanation of benefits (EOB).

> All people, accounts, providers and organisations are fictional synthetic data. AFP output is a clearly labelled **simulation only**. Nothing here is a certified financial statement, medical document, or WCAG/PDF-UA conformant artefact.

## Quick start

Prerequisites: Node 22+, pnpm 10 (via Corepack), Python 3.10+ (for the pack verifiers), Chromium for Playwright (`npx playwright install chromium` if not already present).

```bash
pnpm install
```

```bash
pnpm dev
```

Open **http://127.0.0.1:5173/projects**. The API runs on **http://127.0.0.1:3001/api/v1** (health: `/api/v1/health`). `pnpm start` runs the API plus the production build via `vite preview` instead of the dev server.

Data lives in `.data/` (SQLite + composed artefacts). Use **Reset demo** in the Project Gallery to restore the approved samples at any time.

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
./scripts/verify-all.sh --app
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

Offline mode is the default and fully functional. To enable the server-side Claude adapter, set in a local, uncommitted `.env` / environment for the API only:

```bash
AI_PROVIDER=anthropic AI_MODEL=claude-opus-5-5 AI_API_KEY=... pnpm dev
```

Keys never reach the browser. Model output is treated as untrusted and re-validated against the typed allowlist; rule/content changes are proposals that require explicit approval.

## Continuing development

See **Continuation guide** in `reports/FINAL_IMPLEMENTATION_REPORT.md`, `docs/dev/AGENT_BRIEF.md` (how screens integrate with the store/command bus), and `reports/BUILD_PROGRESS.md`.

# Integration brief for delegated screen work

Owner/integrator: the lead architect (Opus). Screen implementers work **only in the files they are assigned**. Do not edit shared architecture files (`apps/web/src/state/store.ts`, `apps/web/src/shell/*`, `apps/web/src/api/client.ts`, `apps/web/src/styles/*`, `packages/**`, `apps/api/**`). If you need a shared change, implement it locally in your screen file and describe the request in your final report.

## Product rules you must honour (non-negotiable)

- Read `BUILD_CONTRACT.md`, `docs/approved/UX_BLUEPRINT.md` (your screen's section) and `contracts/SCREEN_CONTRACT.json` (your screen's `requiredTestIds`).
- **One canonical model.** Never copy rules/content into component state. Read the project via `useStudio((s) => s.project)` and derive everything from the pure resolver (`useResolution()`, `resolve()` from `@iss/resolver`) or the API.
- **Every mutation goes through the command bus:** `useStudio.getState().dispatch({ type: 'UPSERT_RULE', rule })` etc. (see `packages/model/src/commands.ts` for the `Command` union). It returns `{ok:false, message}` on rejection and toasts automatically. Undo/redo/save are global (top bar).
- **Scenario changes are not model edits:** use `setRecord`, `patchOverrides`, `setOverrides`, `clearOverrides`, `setJourneyCursor`, `setProfile`, `select(nodeId, variantId)`, `setCtx({...})`. These do not dirty the project.
- No fabricated numbers. Counts, page numbers, diagnostics must come from the resolver, `ScenarioEngine`/`buildCube`/`buildLandscape`/`replayJourney` (`@iss/scenarios`) or API responses (`api.*` in `apps/web/src/api/client.ts`). Empty states must be honest ("No matching fixture").
- Synthetic data label must remain visible (shell provides it). AFP is always "simulation only".
- Accessibility: every spatial/visual insight needs a keyboard-operable 2D/table alternative; visible focus; labels on controls; no information by colour alone; respect `prefers-reduced-motion` (CSS tokens `--iss-motion-*` already go to 0ms) and `useStudio((s)=>s.reducedMotion)`.

## Screen skeleton

```tsx
import { ScreenHeader, Loading, ErrorState, Empty, Dialog, SeverityLabel, formatMoney } from '../ui/common';
import { Icon } from '../ui/icons';
import { useStudio, useResolution, useScenarioEngine, useScenarioRequest, useRecord } from '../state/store';
import { api } from '../api/client';

export function MyScreen() {
  return (
    <section className="screen" data-testid="<first requiredTestId>">
      <ScreenHeader id="S0X" title="<exact title from SCREEN_CONTRACT>" subtitle="..." actions={<>...</>} />
      <div className="screen-body workbench">  {/* or your own grid */}
        <aside className="panel">...</aside>
        <div className="stage">...</div>
        <aside className="panel">...</aside>
      </div>
    </section>
  );
}
```

The shell already renders the top bar (project/record/output switchers, undo/redo/save), nav, `<main>`, dock and toasts. Your component renders inside `<main>`. The project is guaranteed loaded when your screen renders.

## Shared building blocks

- CSS classes (see `apps/web/src/styles/app.css`): `panel`, `panel-head`, `panel-body`, `section-title`, `stage`, `stage-grid`, `stage-toolbar`, `btn` (`primary`, `ghost`, `danger`, `sm`, `icon`), `segmented`, `select`, `input`, `textarea`, `field`, `row`, `kv`, `chip` (`accent`, `variant`, `warning`, `error`, `info`, `sim`), `tabs`, `table` (`num`, `selected`, `rowlink`), `card`, `callout` (`warning`, `error`, `accent`), `empty`, `spinner`, `sev`, `code`, `mono`, `muted`.
- Tokens: `var(--iss-accent)` (InfoSlips green #4EAF60, selection), `--iss-variant` (lime, alternatives), `--iss-warning`, `--iss-error`, `--iss-surface*`, `--iss-border*`, `--iss-text*`, `--iss-motion-*`, `--iss-ease`, `--iss-shadow-*`.
- Put screen-specific CSS in `apps/web/src/screens/<Screen>.css` and import it from your screen file. Prefix classes with a screen-specific prefix (e.g. `.cube-`).
- Icons: `Icon.*` and component-type icons `C['variant-set']` from `../ui/icons`.

## Data available

- `useStudio(s => s.records)` — all synthetic records of the project's document type (full objects).
- `useStudio(s => s.personas)` — 12 persona presets.
- `useResolution()` — current `Resolution` (`result`, `trace`, `findings`, `root` RCT, `semanticManifest`, `runId`, `contentDigest`, `journeySteps`, `effectiveRecord`).
- `useScenarioEngine()` — `ScenarioEngine` for Cube/Landscape (`buildCube(engine, axes, opts)`, `buildLandscape(engine, opts)`).
- `useScenarioRequest()` — `{projectId, recordId, overrides, journeyCursor, project}` body for API calls reflecting the **current unsaved model**.
- API: `api.composePdf/composeHtml/composePages/afpSim/parity/validate/replayJourney/snapshots/generateEdgeCase/artifacts/assistantMessage/decideProposal/...`.
- Node lookup helpers: `nodeMap(project)` from `@iss/model`; `indexTree(res.root)` and `explainNode(res, nodeId)` from `@iss/resolver`; `describePredicate(expr)` for human-readable rule conditions.

## Running and checking your work

- API (shared, already running): `http://127.0.0.1:3001`. Do **not** start or stop it.
- Start your own Vite instance on your assigned port: `cd apps/web && npx vite --host 127.0.0.1 --port <PORT> --strictPort` (it proxies `/api` to 3001). Kill it when done.
- Typecheck: `npx tsc -p tsconfig.json --noEmit` from the repo root (must be clean for your files).
- Screenshot: `node scripts/shot.mjs http://127.0.0.1:<PORT>/studio/aster-card-demo/<route> /tmp/<name>.png 1440 900` (prints console errors). Inspect it and iterate on visual quality. Also check `harborcare-demo`.
- Do not commit; the integrator commits.

## Report back

List: files changed, what works (verified how), test IDs present, known gaps, and any shared-file change requests.

## Polish pass (v0.2) — shared infrastructure every screen must use

Owned by the integrator; **do not edit** these files, request changes instead:
`apps/web/src/state/store.ts`, `apps/web/src/shell/*`, `apps/web/src/ui/*`, `apps/web/src/styles/tokens.css`, `apps/web/src/styles/app.css`, `packages/*`, `e2e/*`.

1. **Compact header.** `ScreenHeader` is now one line: `h1` + an ⓘ "About this view" disclosure holding `subtitle` + `actions`. Keep passing a good `subtitle`. Do not add your own page descriptions above panels.
2. **One disclaimer, but synthetic counts stay labelled.** The top-bar "Synthetic data" badge and the Project Gallery statement are the only general synthetic-data disclaimers — no per-screen disclaimer pills, chips or footers. **However**, the approved spec (PRODUCT_SPEC §population impact, AT-16) requires every population count (reach, cluster/bubble size, cube totals, impact "N of M") to be marked synthetic: use one word on the count itself, e.g. "70 synthetic scenarios", "7 of 70 synthetic records". Keep *functional* labels (AFP simulation, Offline assistant, DEMO DATA cues on documents).
3. **Business / Technical view.** `useStudio(s => s.viewMode)`; helpers in `ui/common.tsx`:
   - `<Tech>…</Tech>` renders only in Technical view; `<Biz>…</Biz>` only in Business view.
   - `<Proof label="…">…</Proof>` — inline in Technical view, collapsed "ⓘ Proof" disclosure in Business view. Use for run IDs, SHA-256 / content digests, model versions, raw JSON, AST.
   - CSS utility classes `.tech-only` / `.biz-only` also work.
   - In Business view show **plain language**: `ui/plain.ts` → `ruleTitle(project, rule)`, `ruleSentence(project, rule)` ("When missed payments is at least 2, show “Payment support” in Payment guidance."), `predicateSentence`, `fieldLabel(project, path)`, `nodeTitle(project, id)`. Rule IDs (R04) may stay as small secondary tags; raw expressions like `card.assistanceRequested = true`, priorities (P400), component codes (C11) go Technical-only.
   - Never remove information entirely: Business view must still let a user reach the proof.
4. **Themes.** Light is now the default; dark is a toggle (`data-theme` on `<html>`). **No hard-coded colours in screen CSS/TSX**: use tokens from `tokens.css` (`--iss-text`, `--iss-text-muted`, `--iss-surface*`, `--iss-border*`, `--iss-accent*`, `--iss-*-soft`, `--iss-*-line`, `--iss-*-fg` chip text, `--iss-overlay-1..3` for subtle tints, `--iss-row-border`, `--iss-row-hover`, `--iss-on-accent`). Status colours: `--iss-success/warning/error/info`.
   - `.stage` (and any element with class `dark-scope`) re-scopes the **dark** tokens even in light theme, so 2.5D/3D viewports stay a deep-slate viewport. Use tokens inside stages too; they will resolve to dark values there.
   - The document "paper" is always white (`--iss-paper`, `--iss-paper-ink`).
   - Check contrast in **both** themes (WCAG AA 4.5:1 for text). axe runs in E2E.
5. **Record picker.** The top-bar record control is now a searchable combobox (`shell/RecordPicker.tsx`, testid `record-selector` with `data-value`). Use `useStudio.getState().setRecord(id)` from code.
6. **Layout budget.** Must work at **1280×720** and **1440×900** without clipped primary actions or unreadable overlap. Primary tables should show ≥ 5 rows at 1440×900. Long identifiers: truncate with ellipsis + `title`, never wrap mid-identifier into 4 lines.
7. **Tests.** Keep every `data-testid` used by `e2e/acceptance.spec.ts` and `tests/e2e/*.spec.ts` (grep before renaming). Do **not** run the Playwright E2E suite (it resets the shared database other engineers are using); the integrator runs it. Do run `npx tsc -p tsconfig.json --noEmit` and capture screenshots with `node scripts/shot.mjs <url> <out.png> [w] [h]` (dev server: http://127.0.0.1:5173, API :3001 — already running; do not start or kill servers). Put screenshots under `/tmp/claude-0/-home-user-Spatial-Studio/60b1a659-14d2-561c-bbb9-5044a0a4d3ba/scratchpad/agents/<your-name>/`. To check the dark theme in a screenshot, set `localStorage['iss.theme']='dark'` (or click `theme-toggle`); for Technical view set `localStorage['iss.viewMode']='technical'`.

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

## UX pass (v0.4) — shared rules for every screen

The user reviewed the app and approved 11 changes. The lead owns `shell/*`, `ui/*`, `styles/*`, `state/*`, `api/*`, `packages/*`, `apps/api/*`, `e2e/*`, `scripts/*` and `screens/RulesData.*`, `screens/JourneySimulator.*`, `screens/ExplodedDocument.*`, `screens/GuidedDemo.*`, `screens/AiAssistant.*`. Work only in your assigned files.

**Hard constraints (unchanged):** keep every existing `data-testid` (tests and `contracts/SCREEN_CONTRACT.json` depend on them) unless your assignment says to remove one — if a control moves, the test ID moves with it; list any ID you removed or whose behaviour changed in your report. Keep spec wording: population counts say "synthetic"; empty Cube cells say "No matching fixture"; AFP is "simulation". No fabricated numbers. Every mutation through the command bus.

1. **Calm visuals.**
   - *One level of borders fewer.* Inside a `.panel`, lists of items are plain rows with dividers, not bordered cards: use the shared `.list-rows` class on the list container (children get a bottom divider, hover, and `.selected` / `aria-current="true"` / `aria-selected="true"` gets a soft accent background with a left bar). Use `.panel-body.flush` when rows should run edge to edge. Remove bespoke card borders/radii/shadows on such items from your screen CSS. A bordered box inside a panel is only justified for a callout or a form group.
   - *Three chip styles only:* status = `.chip` plus `accent | warning | error | info | variant | sim`; count = `.chip.count` (numbers such as "57 of 70"); code = `.chip.code` (IDs, paths, hashes — mono). Replace bespoke pills/badges in your screen CSS with these.
   - *Headings.* `.section-title` is now a calm sentence-case bold label (restyled globally). Do not add uppercase/letter-spaced green labels of your own; write headings in sentence case ("Why this outcome", not "WHY THIS OUTCOME").
2. **Names first, codes on hover (Business view).** In Business view never show a bare technical code where a readable name exists: component IDs (`payment-guidance`), field paths (`card.paymentStatus`), locales (`es-US`), record IDs (`CARD-0001`). Helpers: `<Named name="Payment guidance" code="payment-guidance" />` from `ui/common` (Business: name with the code as tooltip; Technical: name + code chip), `nodeTitle(project, id)`, `fieldLabel(project, path)`, `ruleTitle(project, rule)`, `localeLabel('es-US')` → "Spanish (US)" from `ui/plain`, and `recordSummary(record, personas)` from `shell/RecordPicker` for customers. Rule numbers (R04) stay visible as small secondary `.chip.code` tags next to the rule's title — never as the only label. Technical view keeps showing codes.
3. **Narrow windows.** Mark each side panel of your screen (`<aside>` beside the main view) with `data-side="left"` or `data-side="right"` and `data-side-title="Inspector"` (short, unique per screen). Below 1100px the shared CSS turns them into slide-out drawers and `ScreenHeader` renders the toggles; your screen body must be the element with class `screen-body` and must still work as a single column. Check your screen at 1000×700 (`node scripts/shot.mjs <url> <out> 1000 700`).
4. **No empty side panels.** A detail panel must never open on "Select a …": pre-select the most useful item (stated per assignment). Do not push the pre-selection into the URL or the shared store selection unless the assignment says so — it must not change what other screens show.

Verify with `npx tsc -p tsconfig.json --noEmit`, screenshots in light + dark (`THEME=dark`), Business + Technical (`VIEW=technical`), at 1440×900, 1280×720 and 1000×700, on both `aster-card-demo` and `harborcare-demo`. Do not run the Playwright suite (the lead does); do not commit.

## Languages and channels (v0.5) — rules for every screen and renderer

- **Never hard-code customer-visible English in a renderer.** Fixed wording goes in `SYSTEM_STRINGS` (`packages/model/src/systemStrings.ts`) and is read with `sysText(res.systemStrings, key, vars)` or `modeText(mode, key, vars)`; placeholders are `{name}`. It then appears in Content & Translations automatically.
- **Any new text field on a node** must get a slot in `slotsOf` (`packages/model/src/strings.ts`) so it is translatable; ids are `@<nodeId>/<field>`.
- **The document language** is `res.locale`; format dates and amounts with `formatValue`/`formatCents`/`formatDate` and that locale. Do not call `Intl` in renderers or the resolver (browser and server must agree).
- **Drafts:** `resolve({ includeDrafts: true })` is for previews only. The server honours `includeDrafts` only with `allowDraft`. A screen that previews must say so when `res.translation.draftsShown.length > 0`.
- **Translation writes** go through `SET_TRANSLATION_DRAFT(S)`, `APPROVE_TRANSLATION(S)`; AI or sample output is always stored with `origin` and never approved by code.
- **Email/SMS wording** lives in `project.channels` (`channelConfig`, `SET_CHANNELS`); renderers read the resolved `res.channelTexts`.
- **Top bar:** it is full. Do not add controls to it; check 1000, 1280, 1440 and 1920 px after any change.

## Assistant (v0.6) — rules for every screen

- **Engines are pure** and live in `packages/scenarios/src/assist/` (contracts in `types.ts`): they return proposals, flags or drafts and never apply anything. No network, clock, randomness or `Intl` in them.
- **Showing a proposal:** use `ProposalCard`, `SuggestionCompare`, `SourceChip`, `NeedsAi` from `apps/web/src/assist/common.tsx`, so every suggestion says who produced it (Built-in or AI), how risky it is and what it will change.
- **Applying:** only through `applyAssistCommands(commands, label, feature, source)` (one undoable step, toast, Activity record). Wording suggestions go into the field the person is editing, never straight into the model.
- **Model-backed features** go through `/api/v1/projects/:id/assist/*` (`apps/api/src/assistAi.ts`). The server validates model output before returning it; a screen must still handle `mode: 'unavailable'` as a normal state, not an error.
- **Never** let the assistant approve a translation, change a workflow state, export or publish.
- **Parallel browser tests:** run them on an isolated stack (`node scripts/dev-isolated.mjs <slot>`, then `E2E_API=… E2E_WEB=…`) so runs do not reset each other's data.

## Templates and project files (v0.7) — rules

- **Saved templates are frozen.** `Store.addTemplateVersion` only ever adds; nothing edits a stored version. Anything that changes a template is a new version.
- **A template is a project without identity.** Use `templateContentOf(project)` to make one and `projectFromSavedTemplate(...)` to start from one (`packages/model/src/templates.ts`). Do not copy projects by hand: these strip `derivedFrom`, `fromTemplate`, `importedFrom`, `lastSavedAt`.
- **Anything read from a file is untrusted.** `projectFileProblems(raw)` runs before `checkDraftProject`, and the import route resolves a document before storing. New project fields that hold a URL or an image must be added to those checks.
- **Provenance fields** (`fromTemplate`, `importedFrom`, `derivedFrom`) are ignored by the project diff and must stay out of change summaries.

## Three kinds of document, project-owned customers, setup (v0.9) — rules

- **Never write a two-way kind check.** `DocumentType` is `credit-statement | eob | custom`. Code that says `kind === 'eob' ? A : B` silently gives a `custom` project card behaviour. Use `projectFields(project)`, `DOCUMENT_TYPE_LABEL`, and deliberate branches for all three.
- **`custom` has no shared customers.** Its records always belong to the project (`record.projectId`), with ids `REC-6xxxx`. The API guarantees at least one. Never default to `CARD-0001`.
- **Lists** are custom fields of type `list` with `itemFields`; they are `array` field definitions with a derived `custom.<key>.count`. Anything that edits custom fields must preserve `itemFields`.
- **Customers are edited through `routes/records.ts`** (Data Explorer). Shared customers (samples, imported) are never changed; copy first. Bookkeeping fields are owned by the server.
- **A setup is data, not a project.** A model (or the built-in reader) produces a `SetupSpec`; `checkSetupSpec` cleans it and `projectFromSetupSpec` builds the project through ordinary commands. The server never trusts a client-sent project for creation.
- **Tests never use a live AI key** (vitest and the test servers force the built-in assistant). Live checks are run on purpose with `scripts/live-ai-check.mjs` against a `LIVE_AI=1` stack.


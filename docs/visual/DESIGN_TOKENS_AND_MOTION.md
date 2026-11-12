# Visual system — approved intent, placeholder brand tokens

**Status:** Design reference, not final InfoSlips brand. Official logos, fonts and colors remain pending. The application must implement overridable CSS variables.

## Workbench

- Desktop-first at 1440×900 reference, works at 1280×720; scroll/panel-collapse before hiding required controls.
- Dark charcoal/navy application shell, warm white document sheets, restrained accent cyan for selected element, violet for alternatives, amber warnings, coral destructive errors.
- Two dominant layers: shell (navigation, inspector, toolbars) and document plane (accurate content and printable page).
- Type: system sans for UI; print uses embedded/controlled document fonts. Body 14–16px, metadata 11–12px, H1 24–30px. Contrast target >=4.5:1 normal text, >=3:1 large text and icons where applicable.
- Minimum target size ~32 px desktop, 44 px touch target where touch controls used.

## Token contract (changeable brand file)

```css
:root {
  --iss-shell: #101926;
  --iss-surface: #182639;
  --iss-surface-raised: #243449;
  --iss-paper: #ffffff;
  --iss-paper-ink: #1b2736;
  --iss-accent: #32c5dd;
  --iss-variant: #9d86f6;
  --iss-warning: #f0ad4e;
  --iss-error: #ed7474;
  --iss-success: #57c6a5;
  --iss-border: #3d4b5b;
  --iss-radius-md: 12px;
  --iss-shadow-plane: 0 18px 45px rgba(0,0,0,.32);
  --iss-font-ui: system-ui, -apple-system, Segoe UI, sans-serif;
  --iss-motion-fast: 140ms;
  --iss-motion-depth: 360ms;
}
@media (prefers-reduced-motion: reduce) {
  :root { --iss-motion-fast: 0ms; --iss-motion-depth: 0ms; }
}
```

## Signature Exploded Document transition

1. Selected component shows cyan outline and `Explore variants` pull handle.
2. User pulls or clicks; source page remains fixed and legible; component peels forward into 2–5 labeled planes, each with variant ID, short content, active/matched/inactive state, rule provenance.
3. 180–450ms purposeful depth separation with consistent coordinate relationship and controlled perspective; not free camera orbit.
4. Clicking variant opens side-by-side comparison/rule inspector. Active variant underlined; keyboard alternative navigates list of variants with arrow keys.
5. Collapse reverses into page without mutating model. Change persona while exploded = updated active markers, not new cloned templates.

## Document Cube

- Three configurable axes with meaningful labels, grid selection, count badges, hovered card detail and `no matching scenario` state.
- Bound axis cardinalities (e.g. 6×4×3 max initial sampled cells), pagination/facets for more. Do not render fabricated cells.
- 2D table/matrix alternative; change axes retains valid selected scenario or declares empty selection.

## Scenario Landscape

- Group evaluated scenarios by deterministic outcome signature and diagnostic class. Size = evaluated population count; color/status = actual checks. Show legend, counts and exact sample universe.
- 2D sortable list alternative; semantic tooltips plus click through to scenario and source trace.

## Page Stack

- Display composer-created page image/preview and page count, not predicted geometry. Stack spacing/tilt serves comparison; overlay visual diff annotations and overflow provenance.
- Click a page to switch flat 100% preview, inspect exact node/page break and open corresponding editor node.

## Other UX states

- Every view needs loading, no-data, resolve/compose error, read-only/locked, selected-but-not-rendered, unsupported projection fallback.
- No essential information encoded only in color, depth, shape or animation. Accessible list/flat alternative and full keyboard selection.
- Use reference screenshots under `reference/screenshots/` as inspiration, not pixel-exact goals until official brand assets arrive. Capture *new* screenshots from actual built app.

# Visual review and screenshot evidence checklist

**Reference inputs:** `reference/screenshots/screen-01.png` … `screen-12.png`, plus `reference/UX_ATLAS.html`. These are the pre-build concept, not app acceptance artifacts.

For **every screen** capture a newly rendered screenshot from the running application at 1440×900. Capture Design, Exploded, Cube and Page Stack at 125% browser zoom too. Store in `reports/evidence/screens/`, never overwrite the reference folder.

## Visual quality checklist

- [ ] premium dark shell + credible white financial/EOB documents, professional typography and alignment
- [ ] color and elevation differentiate active view/selected node/variants/diagnostic severity without visual clutter
- [ ] paragraphs and table text are readable at 100% zoom; document page uses physical aspect ratio
- [ ] layout does not clip at 1280×720 and 125% zoom; inspector and left panels collapse gracefully
- [ ] content appears consistent across screens and selected node is clearly highlighted
- [ ] Exploded Document has purposeful perspective, named variant faces and contextual rule connection
- [ ] Cube axis change is visibly reflected in labels and content, not merely camera movement
- [ ] Landscape has numeric counts/legend plus 2D table; counts reconcile with evaluated records
- [ ] Page Stack displays actual composer pages and page detail, not generic rectangles
- [ ] rule validation errors clearly state which field/rule caused them and how to inspect
- [ ] reduced-motion view omits spatial flight and preserves function
- [ ] keyboard focus indicators and contrast checks visible across dark and light surfaces
- [ ] important data and legal/health sample disclaimers remain legible in real PDF and HTML output

## Capture checklist for showpiece animation

1. Before: selected `payment-guidance` with active source page.
2. Midtransition: depth separation with distinct variants, connectors and preserved page.
3. After: five named variants including active selection, with rule IDs.
4. Switch record CARD-0001 → CARD-0002 while still exploded and show changed active marker.
5. Collapse, inspect resulting layout, then select document output profile.
6. Capture plain list alternative and reduced-motion version.

All visual QA notes should refer to screenshot evidence and a specific issue, not adjectives alone. Automated pixel diff is useful but does not replace human review.

# Variants API

Status: **built and tested (wave 5, section 1).** Overview, the gallery, Design Studio, Before & after and Releases use it.
Design: `docs/design/WAVE5_REACH_AND_DEPTH.md`, section 1 (and its "As built" note). Decision: D118.
Code: `packages/model/src/variants.ts` (the comparison, the update, "use the base's again", making a variant),
`packages/model/src/variantLock.ts` (the lock, used by `applyCommand`), `apps/api/src/variants.ts` (the store side),
`apps/api/src/routes/variants.ts` (routes). Tests: `packages/model/test/variants.test.ts`, `apps/api/test/variants.test.ts`,
`e2e/variants.spec.ts`.

## What a variant is

A variant is an ordinary, complete `Project` with one extra field:

```json
"variantOf": {
  "projectId": "northwind-energy-demo",
  "modelVersion": 1,
  "contentDigest": "<projectContentDigest of that saved version>",
  "purpose": "region",
  "label": "Lakeshore region",
  "baseTitle": "Northwind Energy bill",
  "baseNodeIds": ["doc-root", "issuer-logo", "…"]
}
```

- `projectId`, `modelVersion`, `contentDigest`: the base document, the saved version followed (from its version history) and
  that version's content digest.
- `purpose` (`brand` | `region` | `other`) and `label`: what it is for.
- `baseTitle`: the base's title at that version, for messages.
- `baseNodeIds`: the base's components at that version, as the variant holds them. It is derived from the base version; it
  is stored so that `applyCommand` can keep the lock without fetching the base, and the server checks it on every save.

Nothing reads `variantOf` when a document is resolved, rendered, composed, released, packaged, proved or shown through a
review link: a variant's outputs come from its own content only. `variantOf` is left out of templates, of documents made
from templates, of a duplicate and of a package's `template.json` (`IDENTITY_KEYS` in `templates.ts`); a project file
exported from the studio keeps it (an imported variant whose base is not in the studio says so and behaves as an ordinary
document).

## What stays the base's (the lock)

In a variant, these stay exactly as in the base at the version followed: the data fields (`customFields`), the
calculations (`calculatedFields`), where the document's date comes from (`documentDate`), the page design
(`presentationProfiles`), the document's top component and kind, and, for each of the base's components the variant
holds, its kind, its layout (position and size), its container and its order among the base's components. Everything
else is the variant's: brand, wording and translations, lookup-table values, rules, which sections show (a base
component is hidden by removing it; a component of the variant's own can be added anywhere and moved, resized and removed
freely), email and SMS wording, pinned tests, wording rules, mappings, title.

`applyCommand` checks the locked parts before and after every command (like the library's read-only rule), so no command
can slip past it; a refused change has code `VARIANT_LOCKED`, the component's id when there is one, and a message such as
"The position and size of “Account summary” come from the base document “Northwind Energy bill”. Change them there, or
detach this variant." The three variant commands, a batch (each step is checked) and an undo are not checked.

## Commands (one undoable step each, in the working version)

| Command | What it does |
|---|---|
| `{ type: 'DETACH_VARIANT' }` | Removes `variantOf`. The content does not change. |
| `{ type: 'UPDATE_FROM_BASE', project, label? }` | Takes the update: `project` is the merged variant from `mergeVariantUpdate` (following the newer base version). |
| `{ type: 'USE_BASE_AGAIN', project, label }` | Drops one difference: `project` is the result of `useBaseAgain`. It must follow the same base version. |

None of them saves, approves or releases anything. Saving is the usual `PUT /api/v1/projects/:id`.

## Pure functions (`@iss/model`)

- `compareWithBase(baseAtFollowedVersion, variant, { customers? })` → `VariantDifference[]`: what differs, each with an id
  (an address such as `nodes[greeting].content`, `rules[R05]`, `brand.accent`), a group (`brand`, `wording`, `rules`,
  `sections`, `tables`, `other`), a label, the kind (`changed`, `added` = only in the variant, `removed` = only in the
  base) and short readable values.
- `diffProjects(baseThen, baseNow)` (existing): what the base has changed since.
- `mergeVariantUpdate({ ancestor, base, variant, customers? })` → `{ project, fromVersion, toVersion, comesIn, kept,
  needsLook, baseChanges }`. Deterministic; see "How the update decides" below.
- `useBaseAgain(variant, baseAtFollowedVersion, differenceId, { customers? })` → `{ project, label }` or `{ error }`.
- `makeVariant(base, { projectId, title, purpose, label, customers? })`, `variantStanding`, `variantRulesDiffer`,
  `variantReleaseRecord`.

`customers` maps the base's own customers to the variant's copies (base record id → variant record id), for documents with
their own data; a pinned test that uses the variant's copy of a customer is the same test, and a pinned test that comes
in with an update uses the copy.

Comparison and merge go by structure, not by a list of fields: a list of objects with a unique `id`, `key`, `eventId` or
`linkId` is merged item by item, any other object key by key, anything else as one value; a field added to the project
or to a component later is compared and merged like the rest. Three things are coarser on purpose: a rule is one value; a
component's rich text and its layout are one value each; a component's `children` follow the base's order with the
variant's own components kept after the component they followed. The `version` counters of rules and messages are not
differences.

### How the update decides

For each value, with A = the base at the followed version, B = the base now, V = the variant:

| A → B | A → V | Result | Group |
|---|---|---|---|
| unchanged | anything | V | (not part of the update) |
| changed | unchanged | B | comes in |
| changed | changed the same way | V | (nothing to report) |
| changed | changed differently | V | kept as yours (the base's new value is shown beside it) |
| changed | removed or hidden by the variant | stays removed | kept as yours |
| removed | unchanged | removed | comes in |
| removed | changed, or the variant put its own content in it, or one of the merged rules still shows it | V's, kept (now the variant's own) | needs a look |
| added | the variant added something with the same id | V's | needs a look |

Locked parts always take B (a variant's own change to one, which only an imported file could hold, is reported under
"needs a look"). Also under "needs a look": a translation the variant wrote for English the base has since rewritten; a
rule that comes in but no longer works in the variant (for example it shows a section the variant hid), which is then
not brought in; and a rule that will not work after the update for any other reason. When the variant rewrote a
message's English, the base's new translations of that message do not come in (kept as yours).

## Routes

| Route | Who | What |
|---|---|---|
| `POST /api/v1/projects/:projectId/variants` `{ title, purpose, label }` | edit | Makes a variant of this document from its latest saved version. `201 { project, variantOf, customers }`. A document with its own data: the variant gets copies of the base's customers (`sourceId` = the original's id) and its pinned tests use them. `400 VARIANT_ONE_LEVEL` when the document is itself a variant; `400 INVALID_TITLE`, `INVALID_PURPOSE`, `INVALID_LABEL`. |
| `GET /api/v1/projects/:projectId/family` | any | `{ baseId, base, variants }`: the base (this document, or the one it follows) and each variant with `purpose`, `label`, `follows`, `behind`, `baseMissing`, `rulesDiffer`, `differences` (a count), its review state and latest release. |
| `GET /api/v1/projects/:projectId/variant` | any | For a variant: `{ variantOf, base: { found, projectId, title, latestVersion, follows, behind }, customers, differences, counts, update }`; `update` (when behind) is `{ fromVersion, toVersion, baseChanges, comesIn, kept, needsLook }` for the saved variant. A base that cannot be found: `base: { found: false, reason, message }`. Not a variant: `{ variant: false, variants: [ids] }`. |

The studio's screens work out the differences and the update in the browser, from the working version and the base's
saved versions (`GET /projects/:id/versions/:v`), so unsaved edits show at once.

### Rules on other routes

- **Save** (`PUT /api/v1/projects/:projectId`): a variant whose locked parts differ from its base at the followed version
  is refused (`422 VARIANT_LOCKED`, with `nodeId` when there is one), as is a `baseNodeIds` list that does not match that
  version. An ordinary document cannot become a variant by saving (`422 VARIANT_FROM_SAVE`) and a variant cannot change
  which document it follows (`422 VARIANT_BASE_FIXED`). A save without `variantOf` detaches. When the base or the followed
  version is not in the studio, nothing is checked (it behaves as an ordinary document). Restoring an earlier version of a
  variant is checked the same way.
- **Delete** (`DELETE /api/v1/projects/:projectId`): a base with variants is refused (`409 HAS_VARIANTS`, `variants:
  [ids]`) until they are detached or deleted.
- **Duplicate**: the copy is an ordinary document.
- **Duplicate wording** (Library): variants are not scanned (they share their base's wording on purpose).

## Releases and packages (design rule 9)

A release of a variant records `variant: { baseId, baseTitle, baseVersion, baseDigest, purpose, label, differences: [{ id,
group, label, kind }], baseFound }` (frozen with the release; `baseFound` is false when the base was not in the studio).
`ReleaseInfo.variant` carries it. The package's `manifest.json` has the same under `variant` (an addition to format 1:
readers that do not know it ignore it), and its README has a section "A variant of another document". A document that is
not a variant gets no `variant` field anywhere, and its package files are byte for byte what they were before
(`apps/api/test/variants.test.ts`).

## Activity

`project.variant.create` `{ baseId, baseVersion, purpose, customers }`, `project.variant.update` `{ baseId, fromVersion,
toVersion }` (a save that takes an update), `project.variant.detach` `{ baseId, baseVersion }`. Ids, numbers and counts only.

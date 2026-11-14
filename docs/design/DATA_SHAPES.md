# Richer data shapes: design note

Status: **built** (wave 5, section 2 of `docs/design/WAVE5_REACH_AND_DEPTH.md`; decision D118). For documents with
their own data (`documentType: 'custom'`) only. The credit-card statement and the explanation of benefits do not
change.

## What a document can hold

| Shape | Model (`packages/model/src/types.ts`) | Paths |
|---|---|---|
| A group of fields at the top level | `CustomField { type: 'group', fields: CustomGroupMember[] }` | `custom.mailing.city` |
| A group in each item of a list | a column `{ type: 'group', fields }` of `itemFields` | `custom.accounts[].holder.name` |
| A list inside each item of a list | a column `{ type: 'list', itemFields }` of `itemFields` | `custom.accounts[].transactions`, `custom.accounts[].transactions[].amountCents` |
| A calculation for each item | `CalculatedField.list = 'custom.accounts'` | read as `calc.<key>` inside the item |
| A condition about items | `Predicate { op: 'items', path, match: 'any' \| 'every' \| 'none' \| 'atLeast', count?, where }` | `ANY(custom.accounts WHERE custom.accounts[].balanceCents < $0.00)` |
| A repeating section | `DocNode.repeat = { list, newPage?, keepHeading? }` on a container | ids `<id>` (first item), `<id>~2`, `<id>~3`… |

### Limits and why

- **One level of nesting** (D118): a list item may hold groups and lists; an inner list holds simple columns only (text,
  whole number, amount, date). A third level, a group in a group, a list in a group and a group in an inner list are
  refused by `validateCustomFields` with a plain sentence ("…cannot hold another list. Lists go at most two levels
  deep…"). The same check runs on imported records ("a list inside a list cannot hold another list").
- A group holds 1 to 12 simple fields (`CUSTOM_GROUP_MAX_FIELDS`); a list keeps 1 to 8 columns, groups and inner lists
  included; every list still holds at most 500 rows (`LIST_ROW_LIMIT`), inner lists too.
- A repeating section is a **container** (no sixteenth component type: the fifteen approved types stay), sits
  **directly on the page** (so its items can flow across pages), cannot have a fixed position and cannot sit inside
  another repeating section. Only the document's own lists can be repeated over.
- A calculation belongs to at most one list, and only a top-level list. A document-level calculation cannot read a
  calculation of the items (it can add up the items' own data instead).
- Rules that choose a message (`selectVariant`, `showSection`) are decided once for the document. Inside a section,
  per item, decide with a component's own condition (`visibleWhen`) or a conditional region's inline conditions.
- Renames: today a data field's key cannot be changed once used (a change of key is a removal and an addition, and a
  removal is refused while anything uses the path). That stays the same for groups, columns and inner lists: their
  paths count as "in use" (`customFieldUsage`), so a used one cannot be removed. Labels can be changed freely.

## How a path inside an item is written and shown

- Written with `[]` after the list: `custom.accounts[].number`. A path with `[]` is only read **inside an item**: inside
  a repeating section of that list, in a calculation that belongs to the list, or in the `where` of an items condition.
  Used anywhere else it is an unknown field ("“Account number” belongs to each item of “Accounts”, so it can only be
  shown inside a repeating section of that list").
- A person never sees the path: every picker shows the label ("Account number", "Holder: Name", "Mailing address:
  City"). In Technical view the path is shown as a code chip, as for every field.
- In a formula, `SUM(custom.accounts[].transactions.amountCents)` adds up the current account's transactions in a
  calculation that belongs to `custom.accounts`, and **every account's** transactions in a calculation of the whole
  document. The plain words say which ("… in “Transactions” of every item of “Accounts”").

### How the engine reads an item (`packages/model/src/shapes.ts`)

`scopeCtx(ctx, list, item, i)` is a shallow copy of the customer's context in which `custom['accounts[]']` is the item
and `calc` holds the item's calculated values. Every reader that already follows dotted paths (`getPath`, conditions,
wording tokens, bindings) therefore works inside an item unchanged; outside one, a `[]` path is simply empty.
`itemContexts(ctx, list)` gives the scopes of a list's items (for an inner list read outside an item: the rows of every
item, in order); `readList` gives the rows the same way. `decideItems` turns per-item answers into any / every / none /
at least N (every and none hold for an empty list).

## How a repeating section is resolved and composed

- **Resolver** (`buildNode` in `packages/resolver/src/resolve.ts`): the section's children are laid out once per item.
  The first item's components keep their own ids, so the canvas, the Inspector and explanations find them; later items
  are `<id>~<n>` with `instanceOf` and `repeatItem { section, index, count, first }`. With no items the section is
  hidden ("No items in “Accounts” for this customer.") and its components are laid out once, hidden, reporting nothing.
  The manifest lists every instance (money, table rows and totals by instance id), so parity checks each account.
- **PDF** (`pagedFlowNodes` in `packages/renderers/src/paged.ts`): a section is not one block. Each item's components
  flow as top-level blocks, so an inner table splits row by row with its heading repeated (`repeatHeader`), like any
  table. "Keep the heading with the first rows" groups an item's components before its first table into one block
  kept with the table's first rows (`keepWithNext`). "Start each item on a new page" puts a page break before each item
  after the first (`breakBefore: 'page'`, which uses the page-design composer). Nothing is clipped: the page checks
  report `BLOCK_OVERFLOW` as for any block.
- **Web page**: the section is in the "Details" part of the page; each item is its own `<section class="iss-repeat-item">`;
  inner tables keep their filter, sort and "show more" controls. The CSS for it is added only to documents that have
  a repeating section.
- **Email**: the section is summarised in one line ("Accounts: 3 items. The full list is not shown in this email…",
  the existing table summary wording); its items are in the full document. **SMS**: not shown.
- **Design Studio**: the first item is shown in full (it is where the layout is edited); each later item shows its first
  component and "repeated (+N more components)". Clicking any copy selects the component itself.

What was seen on real pages (household example, `apps/api/test/data-shapes-pdf.test.ts`): four accounts of 36 to 40
transactions compose to 6 US Letter pages; every inner table continues with "Transactions (continued)" and its header
row; each account heading stays with its first rows; the PDF and the web page carry the same money, rows and totals;
the studio's PDF accessibility checks pass for one, two and four accounts.

## Every place that walks the field tree or a customer's data

| Place | What it does with the new shapes |
|---|---|
| `fields.ts` `customFieldDefs` / `projectFields` | Group fields become ordinary fields (`custom.mailing.city`, label "Mailing address: City", `group`). A list's `itemFields` holds its simple columns and its groups' fields (`holder.name`); inner lists are in `innerLists`. No `[]` path is a top-level field. |
| `fields.ts` `itemFieldDefs`, `scopeFieldIndex`, `allFieldIndex`, `itemScopeIndex` | New: the fields of an item (and of an inner list's row), the fields at one place of the document, every path. |
| `fields.ts` `validateCustomFields` | Groups, inner lists and the depth limits, in plain words. |
| `validate.ts` `validatePredicate` | `items` conditions: the list must exist, `where` is checked in the item's scope. |
| `expressions.ts` (type check, dependencies, evaluation) | Item scope for calculations of a list; `[]` paths and item calculations refused outside; inner lists read for the item or across items; `items` in `predicateTri`. |
| `formula.ts` / `formulaWords.ts` | `[]` in paths; `ANY/EVERY/NONE/AT_LEAST(…)` parsed and printed; plain words for both. |
| `commands.ts` (`SET_CUSTOM_FIELDS`, node checks, `MOVE_NODE`, `customFieldUsage`, `referenceProblems`, variant conditions) | Repeating-section rules; conditions inside a section checked in its scope; an item's field cannot leave its section; used group fields, columns and inner lists cannot be removed. |
| `rich.ts`, `translations.ts`, `strings.ts` (tokens) | `{{custom.accounts[].number}}` is a token. |
| `importRecords.ts` (JSON and CSV import, Data Explorer checks, runnable package `recordProblems`) | Nested JSON checked with the path in the message (`custom.accounts[1].transactions[2].amountCents`); a CSV column for a list or an item field is refused, offering JSON. |
| `mapping.ts` `mappablePaths` / `entryProblem` | Target fields for `custom.accounts[].holder.name`, `custom.accounts[].transactions` and its columns. |
| `resolver` (`evaluatePredicate`, `predicatePaths`, `describePredicate`, bindings, tables, conditional regions, repeating sections) | As above; table columns of a group in a row are read by dotted key. |
| `renderers` (paged, responsive, email, SMS) | As above; documents without a repeating section render byte for byte as before. |
| `validation` `bindingAnalysis`, `staticRuleAnalysis` | Bindings inside a section checked in its scope; items conditions evaluated. |
| `scenarios` coverage (`dnf`, `plan`, `solveItems`) and `planTestData` | An items condition is solved by changing the list as a whole (empty for every/none, the first items made to match for any/at least); a component inside a section is reached when it shows for at least one item. Starting customers get groups as objects and inner lists with one, none and many rows. |
| `scenarios` `dataDictionary` / `fieldUsage` | `innerLists` per list and `itemFields` (only for documents that use the new shapes); item paths are known, not "unknown references". |
| `scenarios` rule words (`ruleDraft`, `writing`), `ruleReview` | Words for items conditions; the overlap review leaves them to the coverage check. |
| `runtime` `inputSchemaFromDictionary` | Groups in rows as objects, inner lists as arrays of rows. |
| `resolver` `dataFingerprintOf` (proofs) | Unchanged: the digest of the whole record already covers nested values. |
| Web: data fields editor, Inspector pickers, canvas, Data Explorer, rule editor, Calculations | Shown in the screens; see the As-built note in the wave 5 design. |
| "Ask about all customers" reader (`baseQuery.ts`) | Unchanged: it lists the project's top-level fields (group fields included by name, "Mailing address: City"); item fields are left out cleanly, as lists always were. |
| Setup from a file / Describe a template (`setupSpec.ts`) | Unchanged: they keep producing flat shapes; their proposals still validate. |

## Old documents

A document without groups, lists in lists, calculations per item or repeating sections produces byte-identical
resolutions, page sources, web pages, emails, SMS, data dictionaries, input contracts and test customers to before
(`packages/renderers/test/shapes-unchanged.test.ts`, fingerprints captured on the commit before the feature for the
seed projects, the two samples and the two examples). No stored document needs changing; `ENGINE_VERSION` and the
renderer versions are unchanged.

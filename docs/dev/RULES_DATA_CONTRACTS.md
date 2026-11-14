# Rules and data depth: contracts for the screens

Engine (phase 1) of `docs/design/RULES_AND_DATA_DEPTH.md`: calculated fields, lookup tables, the document's date and
effective periods. Everything below is exported from `@iss/model`, `@iss/resolver` or `@iss/scenarios` and is pure (no
clock, network or `Intl`). Screens never copy these into component state: they read the project from the store and
dispatch the commands below. Example documents for tests: `packages/model/test/helpers/depthProject.ts`.

## Model (`@iss/model`, `packages/model/src/types.ts`)

| Type | What it is |
|---|---|
| `CalculatedField` | `{ key, label, type: CalcType, description?, expr: Expr }`; read as `calc.<key>` wherever a data field can be used. |
| `CalcType` | `'number' \| 'money' \| 'date' \| 'text' \| 'bool'` (money = whole cents, date = ISO day). |
| `Expr` | The calculation tree (table below). Data, never code. |
| `LookupTable` | `{ id, title, description?, keys: LookupKeyColumn[], columns: LookupValueColumn[], rows: LookupRow[], defaultRow? }`. |
| `LookupKeyColumn` | `{ key, label, match: 'text' \| 'number-range' \| 'date-range', unit?: 'number' \| 'money' }`. |
| `LookupValueColumn` | `{ key, label, type: CalcType }`. |
| `LookupRow` | `{ keys: { [key]: string \| { from?, until? } }, values: { [column]: Scalar } }` (from included, until excluded). |
| `DocumentDateSource` | `{ source: 'run' }` or `{ source: 'field', path }`: where the document's date comes from. |
| `EffectivePeriod` | `{ from?, until? }` ISO days; `from` included, `until` the first day it no longer applies. |
| `Project.calculatedFields?`, `.lookupTables?`, `.documentDate?` | Absent on documents that do not use them. |
| `Rule.effective?` | The rule applies only in this period. |
| `DocNode.effective?` | A conditional section (conditional region, or a node with `visibleWhen` / `ruleDriven`) shown only in this period. |
| `DocNode.variantPeriods?` | `{ [variantId]: EffectivePeriod }`: an alternative can be chosen only in its period. |
| `DocNode.totalFrom?` | Repeating table: the footer shows this money field (e.g. `calc.spinTotal`) instead of the column sum. |
| `TestCase.issueDate?` | A pinned test runs "as issued on" this day. |
| `FieldDef.calculated?`, `.documentDate?`, `FieldType 'number'` | Calculated fields and `document.date` appear in `projectFields(project)` with `derived: true` (never inputs). |

`Expr` kinds (the formula form in brackets):

| `op` | Fields | Formula |
|---|---|---|
| `field` | `path` (data field, `calc.<key>`, `document.date`) | `card.dueDate` |
| `number`, `money`, `text`, `date`, `bool` | `value` / `cents` | `12.5`, `$12.50`, `"Spin"`, `DATE("2027-01-01")`, `TRUE` |
| `issueDate` | | `ISSUE_DATE()` |
| `add`, `sub`, `mul`, `div` | `a`, `b` | `a + b` … (an amount times or divided by a number must be inside `ROUND`, unless times a whole-number constant) |
| `round` | `arg`, `places` | `ROUND(x, 2)` (amount: 2 = to the cent, 0 = to the dollar; half away from zero) |
| `min`, `max` | `args` | `MIN(a, b, …)` |
| `abs` | `arg` | `ABS(x)` |
| `days` | `from`, `to` | `DAYS(from, to)` |
| `addDays` | `date`, `days` | `ADD_DAYS(d, -7)` |
| `earlier`, `later` | `a`, `b` | `EARLIER(a, b)` |
| `join` | `sep`, `parts` | `JOIN(" ", a, b)` (text, numbers and dates only; never amounts) |
| `count` | `list`, `where?` | `COUNT(custom.sessions WHERE className = "Spin")` |
| `sum`, `smallest`, `largest` | `list`, `column`, `where?` | `SUM(custom.sessions.priceCents WHERE className = "Spin")` |
| `if` | `when` (a rule condition), `then`, `else` | `IF(card.missedPayments >= 2 AND card.tier = "premium", $5.00, $0.00)` |
| `lookup` | `table`, `column`, `keys` | `LOOKUP("feeByTier", "lateFee", custom.tier)` |

Every node is addressed by a **slot path** from the root: `''`, `a`, `b`, `arg`, `args.1`, `from`, `to`, `date`, `days`,
`parts.0`, `then`, `else`, `keys.0` (joined with dots: `arg.a`). `exprChildren(e)` and `exprAt(e, path)` walk it.

## Commands (all through the bus, each one undoable step)

| Command | Example |
|---|---|
| `SET_DOCUMENT_DATE` | `{ type: 'SET_DOCUMENT_DATE', source: { source: 'field', path: 'card.issuedAt' } }`; `source: null` is refused while anything uses dates. |
| `UPSERT_CALCULATED_FIELD` | `{ type: 'UPSERT_CALCULATED_FIELD', field: { key: 'daysToDue', label: 'Days to due date', type: 'number', expr }, index?: 0 }` (add, or change the one with this key). |
| `DELETE_CALCULATED_FIELD` | `{ type: 'DELETE_CALCULATED_FIELD', key: 'daysToDue' }` (refused, naming the uses, while used). |
| `MOVE_CALCULATED_FIELD` | `{ type: 'MOVE_CALCULATED_FIELD', key: 'daysToDue', index: 0 }`. |
| `UPSERT_LOOKUP_TABLE` | `{ type: 'UPSERT_LOOKUP_TABLE', table, index? }` (add or replace, rows included; duplicates and overlaps refused). |
| `DELETE_LOOKUP_TABLE` / `MOVE_LOOKUP_TABLE` | `{ type: 'DELETE_LOOKUP_TABLE', tableId }` / `{ type: 'MOVE_LOOKUP_TABLE', tableId, index }`. |
| `SET_RULE_PERIOD` | `{ type: 'SET_RULE_PERIOD', ruleId: 'R04', period: { from: '2027-01-01' } }` (`null` = always). |
| `SET_VARIANT_PERIOD` | `{ type: 'SET_VARIANT_PERIOD', nodeId: 'payment-guidance', variantId: 'winter', period: { from, until } }`. |
| `SET_SECTION_PERIOD` | `{ type: 'SET_SECTION_PERIOD', nodeId: 'promo-box', period: { until: '2027-06-01' } }`. |

`UPSERT_RULE` (with `effective`), `UPDATE_NODE` (with `effective`, `variantPeriods`, `totalFrom`) and
`UPSERT_TEST_CASE` (with `issueDate`) are checked the same way. Every refusal is plain words in `message`.

## Formula view (`@iss/model`)

| Function | What it does | Example |
|---|---|---|
| `parseFormula(text)` | `{ ok: true, expr, spans }` or `{ ok: false, error: { message, start, end } }`; `spans[slotPath] = [start, end]`. | `parseFormula('=DAYS(card.dueDate, ISSUE_DATE())')` |
| `checkFormula(text, scope)` | Parse and type-check against the project: `{ ok: true, expr, type, spans }` or `{ ok: false, errors: FormulaError[] }` (each error has offsets). | `checkFormula(text, exprScopeOf(project))` |
| `printFormula(expr, fields?)` | The formula line (`=` first). `parse(print(x))` is `x`. `fields` (`projectFieldIndex(project)`) only prints amounts in conditions as `$…` and dates as `DATE("…")`. | `printFormula(expr, projectFieldIndex(project))` |
| `printCondition(p, fields?)` | A rule condition in the formula language. | `custom.tier = "pro" AND custom.visits IS PRESENT` |
| `FORMULA_FUNCTIONS` | `{ name, signature, gives, words, example }[]` for auto-complete. | `ROUND(value, places)` |
| `FORMULA_CONDITION_WORDS`, `FORMULA_COMPARISONS` | `AND`, `OR`, `NOT`, `IN`, `IS EMPTY`, `IS PRESENT`, `WHERE`, …; `=`, `<>`, `>`, `>=`, `<`, `<=`. | |
| `formulaInWords(expr, wordsScopeOf(project, projectFieldIndex(project)))` | Plain words (fixed studio English, never document text). | "The number of days from “Payment due date” to the document’s date." |
| `exprWords`, `conditionInWords`, `periodInWords`, `moneyWords` | The parts of the same reader. | `periodInWords({ from: '2027-01-01' })` → "from 1 Jan 2027" |
| `checkExpr(expr, scope)` | `{ type, problems: [{ at: slotPath, message }] }`. | |
| `exprScopeOf(project)` | What the type check needs (fields incl. `calc.*`, calc types, tables, whether there is a date). | |
| `validateCalculatedFields(project, calcs)` | Every problem of a list (keys, names, types, expressions, cycles) in plain words. | |
| `exprDependencies(expr)` | `{ fields, calcs, lists, tables, usesIssueDate }`. | |
| `calcOrder(calcs)` | `{ order, cycle }`: the order they are worked out in, or the keys in a circle. | |
| `calculationUsage(project)` | `[{ key, where[] }]`: where each calculation is used (to say why a delete is refused). | |

## Evaluating for the current customer (`@iss/model`)

| Function | What it does |
|---|---|
| `evaluateCalculations(project, ctx, issueDate)` | Every calculation once, in order: `{ values, missing, order }`; writes `ctx.calc`. `ctx = buildContext(record)`. |
| `evaluateSteps(project, expr, ctx, issueDate, missing)` | Step by step for one calculation: `{ result, steps: [{ at, value, missing? }] }` (post-order, by slot path; pair with `spans` to show values beside the formula). Call `evaluateCalculations` first so other calculations are known. |
| `evaluateExpr(expr, env)` | One expression with an explicit environment. |
| `Missing` | `{ code, message, path?, via? }`; `code`: `input-missing`, `division-by-zero`, `no-lookup-row`, `no-lookup-value`, `no-date`, `not-whole-days`, `out-of-range`, `invalid`. |
| `roundHalfUp(x, places)`, `valueFits(type, v)`, `calcTypeOfField(f)`, `CALC_TYPE_WORDS` | Helpers. |

## Lookup tables (`@iss/model`)

| Function | What it does |
|---|---|
| `validateLookupTable(t)` | Problems that make it unusable (refused on save). |
| `lookupTableProblems(t)` | `[{ kind: 'duplicate' \| 'overlap' \| 'gap', severity: 'error' \| 'warning', rows: [1-based], message }]` for the grid. |
| `parseLookupPaste(table, text)` | TSV or CSV paste → `{ rows, problems: [{ row, column, message }], headerSkipped }` (amounts in dollars, dates YYYY-MM-DD, yes/no). |
| `lookupRowFor(table, keys)` | The row a key matches (or null). |
| `keyCellWords(col, cell)` | "from 100 until 500". |
| Limits | `LOOKUP_TABLE_MAX_ROWS` 5,000, `LOOKUP_TABLE_MAX_KEYS` 3, `LOOKUP_TABLE_MAX_COLUMNS` 12, `LOOKUP_TABLES_MAX` 50, `CALC_MAX` 100. |

## Dates (`@iss/model`)

`isIsoDay`, `addDaysToIso`, `daysBetweenIso`, `dayNumber`, `dayFromNumber`, `dayWords` ("1 Jan 2027", studio English);
`periodProblem(p)`, `inEffect(p, day)`, `notInEffectWords(p, day)` ("Not in effect on 12 Dec 2026: starts 1 Jan 2027.");
`isConditionalSection(node)`; `documentDateUse(project)` (`{ periods, calcs, referenced, uses }`);
`dateBoundaries(project)` (`[{ date, items: [{ kind, id, nodeId?, change }] }]`); `DOCUMENT_DATE_PATH` (`document.date`).

## Resolver (`@iss/resolver`)

| Addition | What it is |
|---|---|
| `ResolveInput.issueDate?` | "As issued on" for a run or preview. Used only when the project has `documentDate`; then it wins over the date field and joins the run ID. |
| `Resolution.documentDate?` | `{ date, source, given }` (only for documents with a date source). |
| `Resolution.calculated?` | `{ [key]: { label, type, value, missing?, inputs, inputNames } }` (values for the studio; never in proof records). |
| `TraceEntry.period?` | `{ period, issueDate }` when a period decided it; out-of-period items have outcome `out-of-scope` and a plain `note`. |
| `TraceEntry.undecided?` | `{ path, reason }` when a condition could not be decided because a calculated value (or the date) is missing. |
| `explainNode(res, id)` | Adds "“Renews soon” is true, worked out from “Days to renewal”." and period notes. `calculatedWords(res, key)`. |
| `formatNumber`, formatter `'number'` | Calculated numbers in the document language. |
| `ProofRecord.issueDate?`, `givenDate(res)`, `ProofDifferenceKind 'date'` | See `docs/api/PROOFS.md`. |

## Finding codes

| Code | Severity | Blockers kind | When |
|---|---|---|---|
| `CALCULATION_MISSING` | blocking where the document needs the value (a rule or condition must decide, a required part shows it); warning where it is only shown | this customer's data | A calculated value cannot be worked out. `details: { path: 'calc.<key>', reason, input?, via?, usedBy }`. |
| `LOOKUP_NO_MATCH` | as above | data fields | No row (or no value) in a lookup table, and no default row. |
| `DOCUMENT_DATE_MISSING` | blocking when anything has a period or a deciding use; warning when only shown | this customer's data | The document depends on its date and there is none. `details: { path: 'document.date', input?, usedBy }`. |
| `ISSUE_DATE_INVALID` | blocking | this customer's data | The date given for the run is not a day. |

## Checks (`@iss/scenarios`)

| Function | What it does | Example |
|---|---|---|
| `dateChecks(project)` | Gaps (a message with no alternative in effect) and overlaps (rules that tie only during a period) with the days. | `[{ kind: 'gap', from: null, until: '2026-06-01', message }]` |
| `documentDateBoundaries(project)` | Each day something changes, with `changes[].words`. | "Rule “New year offer” starts to apply" |
| `documentTimeline(project, records)` | Per boundary: `{ date, dayBefore, changes, reached: recordIds, evaluated, examples }`. | |
| `coverageGaps(p, r, { issueDate })` | "As issued on"; a dated item not in effect says so. | |
| `documentBlockers` / `documentBlockerStatus` / `customerBlockers` (`{ issueDate }`) | Blockers as issued on a day. | |
| `compareVersions(a, b, r, { issueDate })` | Before & after on a day. | |
| `planTestData(p, r, { issueDate })` | Reaches outcomes through calculations and dates; `GeneratedCustomer.issueDate` when a run date is needed. | |
| `captureExpectation(p, r, o, cursor, issueDate)`, `runTestCase` | Pinned tests "as issued on" their `issueDate`. | |

## Richer data shapes (wave 5, section 2)

Design note: `docs/design/DATA_SHAPES.md`. Documents with their own data only; documents without these shapes behave
byte for byte as before.

| Addition | What it is |
|---|---|
| `CustomField.type 'group'`, `.fields: CustomGroupMember[]` | A named group of 1–12 simple fields; paths `custom.<group>.<field>`, named "Group: Field". |
| `CustomListColumn.type 'group' \| 'list'`, `.fields`, `.itemFields` | A group in each item (`custom.accounts[].holder.name`) or a list inside each item (`custom.accounts[].transactions`, its rows `custom.accounts[].transactions[].amountCents`). One level: deeper is refused. |
| `CalculatedField.list` | The calculation is worked out for each item of that list (`custom.<key>`), in the item's scope; read as `calc.<key>` inside the item. |
| `Predicate { op: 'items', path, match, count?, where }` | How many items of a list meet `where` (written with the item's paths): `any`, `every`, `none`, `atLeast` (`count` 1–1000). Every and none hold for an empty list. The input recorded in a trace is the number of items that match. |
| `DocNode.repeat { list, newPage?, keepHeading? }` | A container repeated for each item (see the design note). |
| `FieldDef.group`, `.item`, `.innerLists` | A group field's group name; the list whose items have this field; a list's inner lists with their columns. |

Formula (in `printCondition` / `parseFormula`):

| Kind | Formula |
|---|---|
| Field of the current item | `custom.accounts[].balanceCents` |
| Total of the current item's inner list (in a calculation that belongs to `custom.accounts`) | `SUM(custom.accounts[].transactions.amountCents)` |
| The same across every item (in a calculation of the whole document) | `SUM(custom.accounts[].transactions.amountCents)`; also `COUNT(…)`, `LARGEST(…)`, `SMALLEST(…)` |
| Items conditions | `ANY(custom.accounts WHERE custom.accounts[].balanceCents < $0.00)`, `EVERY(…)`, `NONE(…)`, `AT_LEAST(2, custom.accounts WHERE …)` |

Words (`conditionInWords`, `formulaInWords`): "for any item of “Accounts”, “Closing balance” is less than $0.00";
"The total of “Amount” in “Transactions” of every item of “Accounts”."

| Function (`@iss/model`) | What it does |
|---|---|
| `itemFieldDefs(customFields, calcs)` | Every field of an item of every list (and of an inner list's row), with `item`. |
| `scopeFieldIndex(project, list?)` | The fields at one place: the project's, plus one item's of `list`. |
| `allFieldIndex(project)` | Every path, item paths included (contract, mapping, names). |
| `itemScopeIndex(index, list)`, `itemDefsOf(index)` | The same from a field index made by `projectFieldIndex`. |
| `isItemPath`, `listOfItemPath`, `itemPrefix` | Path helpers (`custom.accounts[].x` → `custom.accounts`). |
| `scopeCtx`, `itemContexts`, `readList`, `inItemScope` | Read one item, the items of a list, the rows of a list (across items outside an item). |
| `itemCalculations(ctx, list)`, `itemCalculationMissing(scope, key)` | The values per item worked out by `evaluateCalculations` (not in its `values`, which stay the document's). |
| `decideItems(match, count, results)`, `itemsLead(match, count, label)` | Any/every/none/at least from per-item answers; the words "for any item of “Accounts”,". |
| `repeatListAt(project, nodeId)` | The list of the repeating section a component sits in (null when none). |
| `usesRicherShapes(project)` | Whether a document uses any of the new shapes. |

Checks and refusals (plain words): a third level of list, a group in a group, a list in a group, a group in an inner
list; an item's field used outside its section ("… belongs to each item of “Accounts” …"); a calculation of the
whole document reading a calculation of the items; a repeating section inside another section, fixed, or over a list
the document does not have; moving a component that shows an item's field out of its section. Resolver finding
`INVALID_BINDING` for an item's field outside a section. Coverage and test customers reach items conditions and
components inside a section (shown for at least one item).

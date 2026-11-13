# Rules and data depth: calculated fields, effective dates, lookup tables

Status: **design for roadmap wave 2, first half (`docs/ROADMAP.md`). Not built yet.**
Decisions by the product owner on 2026-11-13: calculations are written in a **guided builder with a formula view**; effective dates follow **the document's own date**.

## What stays true

- One model, one engine. Everything here is data in the project and is worked out by the same pure resolver in the browser, on the server and in the runnable package. No free-form code, no clock, no network, no `Intl` in the engine.
- The same data and the same release always give the same document, the same run number and the same proof.
- Every edit goes through the command bus and is one undoable step. Anything the assistant proposes follows D65.
- Existing documents are unchanged: a project with none of these features resolves byte for byte as before (the golden tests prove it).

## 1. Calculated fields

**What it is.** A named value worked out from the customer's data, usable wherever a data field is: in rules, in wording (`{{calc.daysToDue}}`), in table footers, in email and SMS wording, and in other calculations.

**In the model.** `project.calculatedFields?: CalculatedField[]`; each has a `key` (path `calc.<key>`), a label, a result type (number, money, date, text, yes/no), an optional description, and an expression. They appear in `projectFields(project)` marked as calculated, never as an input.

**The expression** is a small tree of data, not code:

| Kind | Operations |
|---|---|
| Values | a data field, another calculated field, a constant, the document's date |
| Numbers and money | add, subtract, multiply, divide, round (half up, to a stated number of places), smallest, largest, absolute |
| Dates | days between two dates, a date plus or minus days, the earlier or later of two dates |
| Text | join, with fixed text between |
| Rows of a list | count, sum, smallest, largest, with an optional condition on the row |
| Choice | if a condition holds then one value, otherwise another (conditions are the rule conditions the studio already has) |
| Lookup | a value from a lookup table (section 3) |

Money is whole cents throughout; a division or percentage says how it rounds. A calculation that refers to itself, directly or through others, is refused when it is saved.

**Three views of the same expression, always in step:**

1. **Builder:** pick a field or operation from lists; each step shows its value for the current customer.
2. **Formula:** a spreadsheet-style line such as `=DAYS(card.dueDate, ISSUE_DATE())` or `=SUM(custom.sessions.priceCents WHERE className = "Spin")`, which can be typed; a mistake is pointed at where it is, in plain words.
3. **Plain words:** "The number of days from the due date to the document's date."

The formula text is parsed to the same tree and printed back from it, so the three never disagree. The formula language has no functions beyond the table above.

**When a value cannot be worked out** (an input is missing, a division by zero, no lookup row): the calculated field is "missing" for that customer, exactly like a missing data field, with a finding that says why. Where the document needs it (a rule that must decide, a required text), that is a blocker, and it appears on the Blockers screen under "data fields" or "this customer's data" as fits.

**Testing.** The calculated field shows its value for every test customer (smallest, largest, spread, and who is missing). "Generate test customers" tries to reach every outcome of a rule that uses a calculated field by varying its inputs, and says so plainly when it cannot.

**Out of scope here:** a calculation per row of a table (a computed column). It belongs with "richer data shapes" in wave 5.

## 2. Effective dates

**The document's date.** Each document says where its date comes from: a date field in the customer's data (for example the statement date), or a date given for the whole run. In the studio it can also be set for a preview: **"As issued on"**. It is available as a value (`ISSUE_DATE()` in formulas, "the document's date" in conditions and wording).

**Dated rules and content.** A rule, an alternative of a message, and a conditional section can each carry "from" and "until" dates. Outside its period the item is treated as absent: a rule does not apply, an alternative cannot be chosen, a section is not shown. "From" is included; "until" is the first day it no longer applies. The explanation for a customer says so ("not in effect on 12 Dec 2026: starts 1 Jan 2027").

**What follows.**

- If a document uses dates and a customer's document date cannot be found, that is a blocker ("this document's wording depends on its date, and this customer has none").
- The run number and the proof record include the document's date when it was given for the run (when it comes from the customer's data it is already part of the data fingerprint). Re-creating a document later uses the same date, so it gives the same result.
- A release states its date boundaries. The release package lists them and includes reference outputs on each side of every boundary; the runnable package takes the run date as `--issue-date` or per customer.
- Checks: a gap (no alternative in effect between two dates where one is needed) and an overlap (two rules that would tie only during a period) are reported with the dates. Coverage, Blockers and Before & after work "as issued on" a chosen date, and a **timeline** shows what changes on which day and how many test customers it reaches.
- Approval is not affected by the calendar: what was approved is the whole dated behaviour.

**Limit.** The studio does not move releases between stages on a date; that stays a person's action.

**As built (screens, wave 2).**

- **Dates (S24)** chooses where the date comes from (none, a date field of the customer's data, or given for each run) as one undoable command, with the engine's refusals in its own words; sets **"As issued on"** (a date picker that says today is not used, quick picks for each boundary and the day before, clear); shows the **timeline** from `documentTimeline` (a keyboard-operable list of days with what starts and ends and how many synthetic customers each reaches, with their names; a strip above it repeats the days and carries nothing more); and **problems in time** from `dateChecks`, each with a link to the rule or the message to fix. A document without a date source shows an explanation and the source choice only.
- **"As issued on" is a scenario setting** (`ctx.issueDate` in the store, kept per document in session storage, never in local storage and never in the model): it does not mark the document unsaved and is ignored for a document without a date source. It reaches `useResolution`, `useScenarioRequest` (so every preview, export, validation, email and SMS request), the Cube and the Landscape (a dated scenario engine), journeys, Data Explorer's checks and saves, Blockers and their fixes, coverage, generate test customers, pinned tests (a test pinned with a date keeps it), Before & after (both versions on the same day), batches, produce from a release, and the assistant's context. The status bar says "As issued on 1 Jan 2027" with a clear button; the top bar is unchanged. Overview gains one line under "At a glance" (the source, the preview date and the next change after it).
- **In effect from / until** is in the rule editor, the alternatives editor of a message and on conditional sections (Design inspector), shown only when the document has a date source. Rules and alternatives carry a "from … / until …" chip, and an item outside its period on the document's date is marked "Not in effect on <day>", never hidden; the decision trace and Exploded's explanation give the engine's dated note.
- **Server**: every route that resolves accepts `issueDate`, refuses one that is not a day (400 `INVALID_ISSUE_DATE`, in plain words) and passes it to the engine; batches record it in the job and the manifest.
- **Differences from the design.** "As issued on" sits on the Dates screen (with quick picks inside coverage, generate test customers and Before & after) and in the status bar, not beside the customer controls on Rules & data: the customer controls are in the full top bar. Dates in the studio's own words use the engine's `dayWords` ("1 Jan 2027"); the date inputs themselves are the browser's date pickers, so the chosen day is always repeated in those words beside them. The journey replay computed in the browser (`replayJourney`) and the change summary's customer impact (`summarizeChanges`) are engine functions without a date yet, so they still work undated (see the engine requests in the build report).

## 3. Lookup tables

**What it is.** A small table kept with the document, such as "fee by tier" or "notice by state", read by a calculation.

**In the model.** `project.lookupTables?: LookupTable[]`: an id and title; one or more key columns (exact text, or a number range, or a date range); one or more value columns with types; rows; and what to do when nothing matches (a default row, or "missing").

**Use.** `=LOOKUP("feeByTier", "monthlyFee", card.accountTier)`; a date-range key can use the document's date, so a rate table can change on a date.

**Checks.** Duplicate keys, overlapping ranges and gaps are reported when the table is edited; a customer no row matches, with no default, makes the calculation "missing" (section 1). Tables are edited in a grid, can be pasted from a spreadsheet, and are limited in size (5,000 rows) so the browser stays fast. They are versioned with the document, frozen in a release, and listed in the release package's data dictionary.

## Where it shows in the studio

- **Rules & data** gains two tabs beside Rules, Customers and Journeys: **Calculations** and **Lookup tables**.
- The rule editor, the alternatives editor and conditional sections gain "In effect from / until".
- "As issued on" sits with the customer and scenario controls on Rules & data and Overview (the top bar is full), and the status bar says when a preview date is set.
- The data dictionary, Exploded Document's explanation, Data Explorer's "what this customer gets", Blockers, coverage and Before & after all understand calculated fields and dates.

## Phases

1. **Engine:** model, commands, expression evaluator, formula parser and printer, plain-words reader, the document's date, dated rules and content, lookup tables, findings, run number and proof record, release package and runnable package, tests.
2. **Screens:** Calculations, Lookup tables, effective periods, "As issued on", the timeline; help and tour text.
3. **Verification:** full gate, evidence, report.

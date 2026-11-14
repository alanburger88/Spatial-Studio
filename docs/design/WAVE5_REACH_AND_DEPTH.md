# Wave 5: reach and depth

Status: **design for roadmap wave 5 (`docs/ROADMAP.md`). Not built yet.** Written on 2026-11-14 after the check-in
(decision D118).

## Check-in decisions (D118)

| Question | Decision |
|---|---|
| Which wave 5 items now? | **The three that need no outside party:** variants by brand or region, richer data shapes, message experiments. Print production, right-to-left and East Asian languages, and a native AFP writer stay recorded until a print partner or native-language reviewers are named. |
| How does a variant relate to its base? | **Its own document that inherits.** It follows a base document at a chosen version and holds only what differs. A change in the base is offered as "update available" with a before-and-after, and a person applies it. Each variant is reviewed, approved and released on its own. |
| What may a variant change? | **Brand, wording, which sections show, lookup-table values, and also its own rules.** Data fields and page layout stay those of the base. (The recommendation was to leave rules with the base; the product owner chose to allow them.) |
| How does a customer get the right variant? | **One release package per variant.** The producing system picks the package for the brand or region. A family view shows the base, its variants, their versions and which are behind. |
| How far do data shapes go? | **Groups of fields, and a list inside a list, one level deep.** |
| How is a customer put in version A or B of an experiment? | **Either, chosen per experiment:** the studio splits by a fixed share, or a field in the customer's data decides. |
| How far does the studio go with experiment results? | **Design, assign and import results.** A results file can be imported to compare the versions. No live connection to another system. |

## Items and order

| # | Item | Built with |
|---|---|---|
| 1 | Variants by brand or region | first pair |
| 2 | Richer data shapes | first pair |
| 3 | Message experiments | after the first pair |

---

## 1. Variants by brand or region

### The idea

A **variant** is an ordinary, complete document. Everything that already works on a document (previews, checks,
blockers, review, releases, packages, proof, review links) works on a variant with no change. What makes it a variant
is one extra fact: **it remembers which base document and which saved version of it it came from.** From that the
studio works out, at any time:

- **what differs** (the variant compared with the base at the version it follows), and
- **what the base has changed since** (the base at that version compared with the base now).

Nothing is "inherited" at the moment a document is produced. A variant's release package is self-contained, like any
other.

### Rules

1. **Making a variant.** From a document's menu: "New variant". It needs a name and what it is for (a brand, a
   region, or other). The variant starts as an exact copy of the base's current saved version and follows that
   version. A variant cannot be the base of another variant (one level only).
2. **What a variant may change:** its brand (logo, colours, font); any wording, label and translation; lookup-table
   values; rules (change, switch off, add); which sections show (hide a base section, add its own section, message or
   alternative); email and text-message wording; pinned tests; wording rules; mappings; its title.
3. **What stays the base's:** data fields, calculations' formulas, the page design, and the position, size and order
   of base components. The studio refuses these changes in a variant and says where to make them ("This comes from
   the base document. Change it there, or detach this variant."). A component the variant added itself can be moved
   and removed freely.
4. **What differs** is always visible: a "Differences from the base" list on the variant's Overview (grouped: brand,
   wording, rules, sections, tables, other), each entry showing the base's value and the variant's, with "Use the
   base's again" to drop that one difference. Components that differ carry a small mark in Design Studio.
5. **When the base changes.** A variant whose base has a newer saved version shows "Update available" (Overview, the
   family view, the gallery card). Opening it shows what the base changed, split into:
   - **comes in**: the base changed something the variant had not touched;
   - **kept as yours**: both changed the same thing, so the variant's own value stays, and the entry shows the base's
     new value beside it so a person can decide;
   - **needs a look**: the base removed or restructured something the variant had changed or added to.
   Before applying, "See what customers will see differently" opens Before & after for the variant with and without
   the update. Applying is one undoable step in the variant's working version; nothing is saved, approved or released
   by it. A variant can also stay behind on purpose.
6. **Rules in a variant.** Because a variant may change rules, the base's tests do not prove a variant. A variant
   carries its own pinned tests (copied when it is made) and its own customers, coverage and blockers. The family view
   says, for each variant, whether its rules differ from the base.
7. **Detaching.** "Detach from the base" turns a variant into an ordinary document for good (with a confirmation). Its
   content does not change.
8. **Deleting or renaming the base.** A base with variants cannot be deleted until they are detached or deleted. If a
   variant's base cannot be found (an imported variant, for example), it says so and behaves as an ordinary document
   until it is detached or the base is imported.
9. **Releases.** Each variant has its own releases and packages. A release records the base document, the base
   version followed and the list of differences, and the package's manifest and README carry them.
10. **Family view.** On the base's Overview and on Releases: the base, each variant with what it is for, the base
    version it follows, whether it is behind, its review state and latest release, and whether its rules differ.
    The gallery groups variants under their base.

### Customers

A variant made from a built-in example keeps using that example's synthetic customers, as a duplicate does today.
A variant of a document with its own data starts with a copy of the base's customers (as *Duplicate* does).

---

## 2. Richer data shapes

For documents with their own data. The built-in kinds (card statement, explanation of benefits) do not change.

### What is added

1. **Groups.** A named group of fields, such as "Service address" with street, city and postcode. A group may sit at
   the top level or inside a list item. A group cannot hold another group or a list.
2. **A list inside a list, one level deep.** A list item may hold one or more lists of its own: accounts, each with
   its transactions; meters, each with its readings. The studio refuses a third level and says why.
3. **Paths** follow the pattern already used: `custom.address.city`, `custom.accounts[].number`,
   `custom.accounts[].transactions[].amount`.

### In the document

4. **A repeating section**: a container bound to a list. Its content is laid out once and repeated for each item;
   components inside read the item's own fields. A table inside it can be bound to the item's inner list, so each
   account gets its heading, its own transactions table and its own subtotal. A repeating section can be told to
   start each item on a new page, or to keep an item's heading with its first rows.
5. **Calculations inside an item**: a calculated field that belongs to a list (for example "account subtotal" = the
   sum of that account's transaction amounts), usable in the repeating section and as a column. Existing calculations
   can also sum or count across the inner lists of all items ("total of all transactions on all accounts").
6. **Rules** can ask about items: "any account is overdrawn", "every meter was read", "at least 2 accounts", and can
   show or hide content inside a repeating section per item ("this account is overdrawn").
7. **Pages.** Inner tables continue across pages with their headings repeated, like tables today. The page checks,
   the PDF and web page comparison and the PDF accessibility checks apply.

### Around the document

8. **Data fields editor**: add a group; add a list inside a list item; the tree shows the shape.
9. **Data Explorer** shows and edits the nested values; **test-customer generation** makes customers with realistic
   inner lists (including none, one and many) and reaches every outcome; **import** accepts nested JSON (a flat CSV
   cannot hold a list inside a list, and the import says so); **Import fields** accepts the new shapes.
10. **Data dictionary, mapping and the release package** list the new paths; the runnable package accepts the nested
    input and its contract describes it.
11. **Old documents** open and behave exactly as before. No stored document needs changing.

### As built (wave 5, section 2)

Built as designed; the design note is `docs/design/DATA_SHAPES.md` (paths, limits, how a repeating section is resolved
and paginated, every place that walks the field tree) and the contracts are in `docs/dev/RULES_DATA_CONTRACTS.md`.

- **Shapes and paths.** Groups at the top level and in list items; a list inside a list item, one level (deeper is
  refused in plain words). Paths `custom.address.city`, `custom.accounts[].number`, `custom.accounts[].transactions[].amountCents`.
  A person sees names ("Account number", "Mailing address: City"), never paths.
- **Repeating section** = a container with "Repeat for each item of" (Inspector), sitting on the page; options "start
  each item on a new page" and "keep each item's heading with its first rows". Inside, components use the item's
  fields, a table of the item's inner list and calculations per item. PDF: each item's parts flow as blocks of their
  own, so inner tables continue with headings repeated; web page: one part per item; email: one summary line; SMS:
  not shown. Design Studio shows the first item in full and each later item compactly; clicking a copy selects the
  component.
- **Calculations per item** ("Worked out: for each item of …" when adding one) and across items
  (`SUM(custom.accounts[].transactions.amountCents)` in a calculation of the whole document).
- **Rules over items**: any / every / none / at least N, in the rule editor ("Add a condition about items") and the
  formula language (`ANY(…)`, `AT_LEAST(2, …)`); conditions on components inside a section are decided per item.
- **Around the document**: data fields editor (groups, lists inside list items, a tree of the shape); Data Explorer
  (group fields of a row and the lists inside each row, edited in place); test customers (inner lists with none, one
  and many rows; items conditions reached); nested JSON import with path-named errors; CSV refused for lists with
  JSON offered; data dictionary (`innerLists`, `itemFields`), mapping paths, the runnable package's input schema.
- **Not changed**: "Rebuild from a file" and "Describe a template" keep producing flat shapes (their proposals still
  validate); rules that choose a message are decided once per document (per item: use a component's condition).
- **Example**: "Household accounts statement" (`packages/model/src/samples/household.ts`, 20 synthetic customers) is
  used by tests only. It is not a seeded sample (that would change sample counts everywhere) and not offered under
  "New project", because that list is built from the gallery's samples.

---

## 3. Message experiments

### The idea

An experiment tries a different version of **one message** on some customers. It is designed in the document, so both
versions go through the same wording rules, translations, review and release as any other wording.

### Rules

1. **An experiment belongs to one message** (a component with alternatives). It has a name, a question it is meant to
   answer, and two to four versions: **A** is what customers get today (whatever the rules choose), and each other
   version is wording written for the experiment.
2. **Who is in it.** By default every customer who would get the message. Optionally only those who would get a
   named alternative (for example only "payment reminder"), or those matching a condition.
3. **Assignment, chosen per experiment:**
   - **The studio splits.** Shares are set per version (they add up to 100). A customer is placed by a calculation
     on the experiment's id and the customer's id, so the same customer always gets the same version, on every run
     and in every output, and the split can be reproduced by anyone with the release package.
   - **A data field decides.** A field in the customer's data names the version. A customer whose field is empty or
     names no version gets version A, and the studio counts those.
4. **Running.** An experiment is a draft until the document version containing it is approved and released. It can
   have a start and an end date (using the document's date). After its end date every customer gets version A again
   without a new release.
5. **Everything shows it.** The explanation of why a customer got a message names the experiment and the version.
   The proof record, the release manifest and the package record it. Coverage and test-customer generation treat each
   version as an outcome that needs a customer. A version with a missing required translation or a broken "must"
   wording rule is a blocker like any other wording.
6. **One experiment per message at a time,** and a customer can be in experiments on different messages
   independently.
7. **Results.** The studio never sees what customers did. A results file can be imported: one row per customer with
   the customer's id and an outcome (yes/no, or a number), and, for a data-field experiment, the version.
   - The studio works out each customer's version (by the same calculation), counts, and shows for each version: how
     many customers, the rate or average, the difference from A, and a plain statement of whether the difference is
     large enough to trust or whether more customers are needed. It states the method it used.
   - **Only the totals are kept.** The file's rows are read, counted and discarded: no customer id or outcome from
     the file is stored, logged or sent anywhere, because a results file comes from real customers.
8. **Ending.** "Keep version B" makes B the message's wording for everyone (one undoable step), "Keep version A"
   drops the other versions; either way the experiment and its imported totals stay in the document's history.

### What it is not

The studio does not send anything, does not track opens or clicks, and does not connect to another system. It designs,
assigns, records, and counts a file it is given.

---

## Build plan

| Step | Builder | Scope |
|---|---|---|
| First pair | A | Variants by brand or region |
| First pair | B | Richer data shapes |
| Then | C | Message experiments |

## Not in this wave

Print production features, right-to-left and East Asian languages, a native AFP writer (each waits for an outside
party); a family package that picks a variant by a data field; variants of variants; lists more than two levels deep;
fetching experiment results from another system.

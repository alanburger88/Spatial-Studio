# The release package

Status: **format version 1, final for phase 2. Built and tested on the server.**
One ZIP per release. It is the contract between the studio, which designs and approves a document, and whatever produces it. An adapter for one CCM reads this package and writes what that CCM needs; nothing else crosses the boundary.

Builder: `apps/api/src/releasePackage.ts`. Routes: `docs/api/RELEASES.md`. Design background: `docs/design/TEMPLATES_AND_CCM.md`.

## Layout

```
<document-id>-r<release>.zip
  manifest.json                     what this is, who approved it, versions, and the SHA-256 of every other file
  README.html                       plain-language guide: what is inside, how to verify a build, what "matching" means
  template.json                     the approved template (a studio project file)
  wording/en-US.csv                 every customer-visible text, English source
  wording/<locale>.xlf              the same texts with their approved translations, XLIFF 2.0   (one per target language)
  wording/<locale>.csv              the same rows as a spreadsheet                                (one per target language)
  data/dictionary.json              every data field: type, format, required, example, where it is used
  assets/<sha256>.<ext>             each image as a file, named by the SHA-256 of its bytes
  assets/index.json                 which image is which, and where the template uses it
  assets/fonts.json                 the fonts required (font files are not included)
  tests/scenarios.json              synthetic customers and what the engine works out for each
  reference/<scenario>/document.pdf     the studio's own outputs for some of the scenarios
  reference/<scenario>/document.html
  reference/<scenario>/email.html
  reference/<scenario>/email.txt
  reference/<scenario>/sms.txt
  reference/<scenario>/facts.json       the facts those outputs carry, and the studio's parity checks on them
```

Entries are stored with `manifest.json` first and the rest in path order. Text files are UTF-8. JSON files are pretty-printed with two spaces and end with a newline.

Not in the package, by decision: customer data; draft wording and unapproved translations; the release's stage and handover record (the studio keeps those, because they change and the release does not); `library/` (phase 4); `data/mapping-<ccm>.json` (phase 3); font files; an AFP print stream; the engine (phase 7).

## Rules the package keeps

1. **A function of the release alone.** It is built from the frozen project and what was recorded when the release was created. It reads nothing else from the studio. Stage moves, handover entries, later edits to the document or its customers, and the passing of time do not change it.
2. **Synthetic customers only.** A customer in a package is either a built-in sample customer or one the engine generates, from the sample customers or from the document's own field definitions. Imported customers, customers supplied for a document and customers a person edited never appear.
3. **Approved wording only.** A text without an approved translation is left untranslated and listed as missing.
4. **No file states when it was built.** The only moments in a package are the release's own: when it was approved and when it was created.
5. **Once built, never replaced.** The studio keeps the first ZIP it builds for a release. Building again only checks the result against it (see "Determinism").

## Determinism

**What holds:** the same release, built twice on the same studio installation, gives a byte-identical ZIP. This is tested: with real PDFs (two builds more than a second apart) and with stubbed composition.

How:

- ZIP entries carry a fixed timestamp (1 January 1980, 00:00) and a fixed order.
- JSON is written in a fixed key order; lists are in document order or sorted.
- **PDF is the one output that is not naturally repeatable.** Two compositions of the same page differ in two places: the creation and modification dates, and the ids the browser gives the accessibility-structure elements. The builder normalises both without changing what the PDF shows: the dates are set to the release's approval time, and the structure ids are renumbered in their existing order. Both replacements keep every byte offset, so the file stays valid.

**What does not hold, and why:**

- **Across machines, `document.pdf` may differ.** Its bytes depend on the browser build that composed it and on the fonts installed there (the studio's composer falls back to Liberation Sans where Arial is not installed). `manifest.json` → `versions.pdfProducer` and `assets/fonts.json` → `referencePdfFonts` say what produced the reference PDFs. Every other file is the same on any machine.
- **The compressed bytes of the ZIP depend on the zlib in the Node.js that wrote it.** The files inside do not. Compare packages by the SHA-256 values in `manifest.json`, not by the ZIP's own hash, when they come from different installations.
- **A different engine, renderer or package format version is refused, not tolerated.** A package states the versions that produced it, so a studio that has been upgraded since the release was made does not build that release's package.

Not verified: repeatability across different machines, browser versions or Node.js versions (only one environment was available); a release with more than a few pages of reference output.

## manifest.json

```jsonc
{
  "format": "iss-release-package",
  "formatVersion": 1,
  "release":  { "id": "aster-card-demo-r3", "number": 3, "origin": "approval", "createdAt": "2026-11-13T14:58:03.176Z" },
  "document": { "id": "aster-card-demo", "title": "Aster Card – credit-card statement", "kind": "credit-statement", "kindLabel": "Credit-card statement", "modelVersion": 7, "issuer": "Aster Card" },
  "approvedBy": { "name": "Ada Approver" },
  "approvedAt": "2026-11-13T14:58:03.175Z",
  "contentDigest": "…",          // the studio's digest of the approved version (what its version history shows)
  "templateDigest": "…",         // the engine's digest of template.json; every facts.json repeats it as projectDigest
  "versions": { "schema": "1.0.0", "engine": "iss-resolver/1.0.0", "pagedRenderer": "iss-paged-renderer/1.0.0", "htmlRenderer": "iss-html-renderer/1.0.0", "emailRenderer": "email-renderer/1", "smsRenderer": "sms-renderer/1", "pdfProducer": "Skia/PDF m153" },
  "languages": { "source": "en-US", "targets": [{ "locale": "es-US", "name": "Spanish (United States)", "texts": 121, "approved": 5, "missing": ["<text id>", "…"] }] },
  "tests":     { "cap": 24, "scenarios": 11, "pinnedTests": 3, "generated": 8, "omittedByCap": [], "pinnedTestsExcluded": [{ "test": "<test name>", "reason": "…" }], "outcomes": { "total": 25, "reached": 25 } },
  "reference": { "cap": 8, "scenarios": ["s01-…", "s04-…"], "outcomesShown": 30, "outcomesSeen": 33, "files": ["document.pdf", "document.html", "email.html", "email.txt", "sms.txt", "facts.json"] },
  "knownDataProblems": [          // an addition to format 1 (see below); absent on releases made before it existed
    { "blockerId": "inconsistent-payment-state~payment-guidance", "blocker": "The account is “up to date” but lists missed payments",
      "customer": { "kind": "sample", "id": "CARD-0003" }, "reason": "…", "markedBy": "Ada Approver", "markedAt": "2026-11-13T14:51:40.002Z" },
    { "blockerId": "inconsistent-payment-state~payment-guidance", "blocker": "The account is “up to date” but lists missed payments",
      "customer": { "kind": "imported" }, "reason": "the customer's file is corrected upstream", "markedBy": "Ada Approver", "markedAt": "…" }
  ],
  "syntheticOnly": true,
  "notIncluded": ["customer data", "…"],
  "contents": [{ "path": "README.html", "sha256": "…", "bytes": 7472, "role": "readme" }]
}
```

- `contents` lists **every file except `manifest.json` itself**, with its SHA-256 and size.
- `origin`: `approval` (created when the document was approved) or `manual` (created later from the approved version).
- `contentDigest` and `templateDigest` differ when the approved project carried unapproved drafts or provenance bookkeeping, which `template.json` leaves out. `contentDigest` links the package to the studio; `templateDigest` can be recomputed from the package.
- `languages.targets[].missing` is the list of text ids with no approved translation in that language.
- `versions.pdfProducer` is read from the reference PDFs (null when there are none).
- The stage (Test or Production) is not here on purpose.
- `knownDataProblems` (added after format 1 was published; an addition, so `formatVersion` stays 1 and a reader that does not know it ignores it): the customers' data problems an approver set aside when the release was made, each for one customer and one problem in that customer's own data, with the reason (see `docs/api/KNOWN_DATA_PROBLEMS.md`). **No customer data:** a built-in sample customer or one the engine generated is named by `id` (`kind` `sample` or `generated`); any other customer (`kind` `imported` or `supplied`, which includes an edited generated customer) has no id and no name, only that one such customer was set aside, and that customer's name and id are replaced by “the customer” in the reason. The list is frozen with the release, so `markedAt` (when it was set aside) is one of the release's own moments, like `approvedAt`. An empty list means none were set aside; the field is absent on releases made before it was recorded. When the list is not empty, `README.html` has a "Known data problems" section with the same rows.

`role` values: `readme`, `template`, `wording-source`, `wording`, `data-dictionary`, `asset`, `asset-index`, `fonts`, `tests`, `reference-pdf`, `reference-html`, `reference-email-html`, `reference-email-text`, `reference-sms`, `reference-facts`.

## template.json

The approved version as a **studio project file**, project format `schemaVersion` `1.0.0` (the same value as `versions.schema`; the type is `Project` in `packages/model/src/types.ts`). It is what "Export project file" downloads, with two things left out:

- the bookkeeping of the one document it was: `lastSavedAt`, `derivedFrom`, `fromTemplate`, `importedFrom`;
- every unapproved translation draft: `contentParts[].draftLocales`, `strings[<id>].draft`, and `translationOrigins`. Drafts never change what the engine produces.

It keeps the document's `projectId`, `title` and `modelVersion`, and everything else: layout, components, rules, messages and notices with their approved translations, email and SMS wording, styles, brand, data fields, journey, and pinned tests.

It passes the studio's project-file checks and can be imported into a studio as a new draft document (`POST /api/v1/projects/import`). Both are tested.

**Images** stay inside `template.json` (see Assets), so the file is self-sufficient.

## wording/

Every text a customer can read, in the order the studio lists them: messages and notices the document uses, labels and other text on components, email and SMS wording, and the fixed wording the outputs add (page numbers, web page controls, email footer).

Each text has an **id**. A message or notice has its content-part id (`payment-reminder`). Everything else starts with `@`: `@<component id>/<field>`, `@title/<part id>`, `@email/<field>`, `@sms/text`, `@sys/<key>`.

Data tokens such as `{{card.dueDate}}` and placeholders such as `{page}` appear literally and must stay exactly as they are.

**`wording/en-US.csv`** — columns `id, kind, title, mandatory, en-US`. `kind` is `message`, `label`, `email-sms` or `fixed`. `mandatory` is `yes` when a document that needs the text cannot be produced without it in the customer's language.

**`wording/<locale>.csv`** — columns `id, kind, title, mandatory, status, sourceChanged, en-US, <locale>`. `status` is `approved` or `missing`; the last column is empty when missing. `sourceChanged` is `yes` when the English changed after the translation was approved (the approved translation is still what the document shows).

CSV files use CRLF row ends and quote cells that contain a comma, a quote or a line break.

**`wording/<locale>.xlf`** — XLIFF 2.0 (`urn:oasis:names:tc:xliff:document:2.0`), `srcLang="en-US"`, `trgLang="<locale>"`, one `<file id="wording" original="template.json">` with `xml:space="preserve"`.

```xml
<unit id="u12" name="@billing-summary/label">
  <notes>
    <note category="title">New balance · label</note>
    <note category="kind">label</note>
  </notes>
  <segment state="final">
    <source>New balance</source>
    <target>Saldo nuevo</target>
  </segment>
</unit>
```

- `unit/@id` is `u<n>`; **`unit/@name` is the studio's text id** (ids contain characters an XLIFF id may not).
- An approved translation: `state="final"` and a `<target>`. No approved translation: `state="initial"` and **no `<target>`**.
- Extra notes: `mandatory`, and `warning` when the English changed after approval.
- Characters XML 1.0 cannot carry are dropped.
- The files are tested to be well-formed XML with this structure. They have **not** been validated against the OASIS XLIFF 2.0 schema or opened in a translation tool.

A document in English only has `wording/en-US.csv` and nothing else in this folder.

## data/dictionary.json

```jsonc
{
  "formatVersion": 1,
  "documentKind": "credit-statement",
  "calculatedFieldsVersion": "derived-v1",
  "note": "…",
  "fields": [{
    "path": "card.newBalanceCents",
    "label": "New balance",
    "type": "cents",                 // string | cents | date | int | bool | enum | array | points
    "format": "Whole number of cents (integer, never a decimal amount)",
    "formatter": "usd-cents",        // how the studio shows it by default
    "required": true,                // the data contract requires it
    "calculated": false,             // true = worked out by the engine, never supplied
    "calculatedFrom": ["…"],         // calculated fields only
    "allowedValues": ["…"],          // enum only
    "columns": [{ "key": "amountCents", "label": "Amount", "type": "cents", "format": "…", "used": true }],   // lists only
    "example": 124800,               // synthetic; for a list, its first row
    "needed": true,                  // the template reads it, or the contract requires it, or a calculated field the template reads comes from it
    "usedIn": {
      "rules":      [{ "id": "R04", "title": "Customer asked for payment assistance" }],
      "conditions": ["<component name>"],     // a condition on a component (show when…, message when…)
      "bindings":   ["<component name>"],
      "tokens":     ["<component, message or wording name>"],
      "journey":    ["<journey step>"],
      "calculatedFields": ["card.transactions.count"]   // present when a calculated field the template reads comes from this field
    }
  }],
  "unknownReferences": []            // tokens that are not data fields of this document; empty for a document that passed the studio's checks
}
```

It lists **every field a customer record of this document may carry**, in contract order, so the input contract is complete; `needed` marks the ones this template depends on. Amounts are integer cents. Dates are ISO 8601. For an explanation of benefits, fields that start with `claim.` describe the claim the document is about: the first row of `claims`.

Only wording the document actually uses counts as usage (a project may carry messages it never shows).

## assets/

**Decision: images stay inline in `template.json` and are also provided as files.**

- `template.json` holds every uploaded image as a `data:` URI (PNG, JPEG or WebP), in `nodes[].image.src` and `brand.logoDataUri`. It needs nothing else to be complete and importable.
- The same images are in `assets/`, each named `<sha256 of its bytes>.<ext>`, ready for an asset store. The link between the two is the hash: decode the data URI, hash it, and that is the file name.
- A built-in mark is referenced from `template.json` by name (`"asset:aster-mark"`) and drawn by the engine in the issuer colour. It is provided in `assets/` as the SVG the engine draws, with `builtIn` and `referencedAs` in the index.

`assets/index.json`: `{ formatVersion, convention, assets: [{ path, sha256, bytes, mime, builtIn?, referencedAs?, usedBy: [{ what: "component" | "brand logo", name }] }] }`.

`assets/fonts.json`: `{ formatVersion, note, fonts: [{ use, family, stack, chosenBy: "brand kit" | "default" }], referencePdfFonts: [...] }`. `fonts` names the family to install for the printed document, the web page and email, with the fallback stack the studio uses. `referencePdfFonts` lists the fonts actually embedded in this package's reference PDFs. Font files are never included.

## tests/scenarios.json

```jsonc
{
  "formatVersion": 1,
  "release": { "id": "…", "number": 3, "title": "…" },
  "syntheticOnly": true,
  "note": "…",
  "cap": 24,
  "counts": { "scenarios": 11, "pinnedTests": 3, "generated": 8, "omittedByCap": 0, "pinnedTestsExcluded": 3, "withReference": 6 },
  "outcomes": { "total": 25, "reached": 25, "notReached": [{ "outcome": "…", "reason": "…" }] },
  "omittedByCap": ["<scenario name>"],
  "pinnedTestsExcluded": [{ "test": "<test name>", "reason": "It uses an imported customer. Imported customers never leave the studio." }],
  "customers": [{ "id": "CARD-0001", "name": "Jordan Mercer", "kind": "sample", "record": { /* the full synthetic record */ } },
                { "id": "CARD-90001", "name": "Avery Abbott", "kind": "generated", "generatedTo": "Reaches “Assistance requested”", "record": { } }],
  "scenarios": [{
    "id": "s01-everyday-customer-gets-payment-instructions",     // also the folder name under reference/
    "name": "Everyday customer gets payment instructions",
    "source": "pinned-test",                                      // pinned-test | generated
    "pinnedTest": { "id": "T01", "name": "…" },                   // pinned tests only
    "covers": ["Rule “…” applies", "Message “…” is chosen in “…”"], // generated only: the outcomes it was generated for
    "customerId": "CARD-0001", "customerName": "Jordan Mercer",
    "overrides": {},                                              // what-if values of a pinned test
    "journeyCursor": null, "journeyStep": null,                   // a pinned test may sit at a journey step
    "data": { /* the customer data the document is produced from, after the overrides and the journey step */ },
    "expected": {
      "produced": true,                                           // false = a blocking issue; no document is produced
      "language": "en-US",
      "messages":  [{ "sectionId": "payment-guidance", "section": "Payment guidance", "chosenId": "payment-instructions", "chosen": "Payment instructions" }],
      "sections":  [{ "id": "rewards-summary", "name": "Rewards summary", "shown": false }],
      "rulesApplied": [{ "id": "R01", "title": "Customer is up to date" }],
      "requiredNotices": [{ "id": "…", "name": "…", "contentPartId": "…", "version": 1, "contentHash": "…" }],
      "amounts":   [{ "id": "billing-summary", "name": "New balance", "cents": 124800 }],
      "amountsNotDetermined": [{ "id": "…", "name": "…" }],
      "tables":    [{ "id": "transactions-table", "name": "Transactions", "rows": 12, "totalCents": 48210 }],
      "links":     [{ "id": "payment-action", "name": "Pay online action", "url": "https://…" }],
      "identity":  { "name": "Jordan Mercer", "account": "•••• 1842" },
      "facts":     { },
      "blocking":  [{ "code": "REQUIRED_TRANSLATION_MISSING", "where": "<component name>", "message": "…" }],
      "runId": "run-…", "contentDigest": "…"
    },
    "pinnedExpectation": { "selectedVariants": { }, "visibleNodeIds": [], "hiddenNodeIds": [], "approvedLocale": null, "noBlocking": true, "holds": true },   // pinned tests only
    "reference": "reference/s01-everyday-customer-gets-payment-instructions/"   // or null
  }]
}
```

**How scenarios are chosen**

1. **The document's pinned tests, in their order**, when their customer is synthetic:
   - a built-in sample customer: kept;
   - a customer generated for the document: kept only when the engine, starting from synthetic data alone, generates that very customer again (compared by a digest of the customer's data that was recorded when the release was created). The customer in the package is the regenerated one;
   - an imported customer, a customer supplied for the document, or a generated customer a person edited: **left out**, listed under `pinnedTestsExcluded` with the reason and without the customer.
2. **Then one generated customer per outcome**: the engine's test-data planner, started from the built-in sample customers only (or, for a document with its own data, from its field definitions), covering every rule, every message version, every optional section shown and hidden, and every document language once. `outcomes.notReached` says which outcomes no customer can reach, and why.
3. **Up to 24 scenarios** (`cap`). What did not fit is named in `omittedByCap`.

`expected` is computed by resolving `template.json` at build time. `data` alone is enough to reproduce it: resolving `template.json` for `data` with no what-if on top gives the same `contentDigest` (tested for what-ifs and for a journey step).

Sections in `expected.sections` are the ones a customer may or may not get: conditional regions, rule-driven sections and components with their own condition.

## reference/

For **up to 8** scenarios (`reference.cap`), the outputs the studio produced. Only scenarios whose document is produced are candidates. They are picked one at a time: each pick is the scenario that shows the most outcomes not shown yet (an outcome is a message chosen, an optional section shown or hidden, a rule applied, or a language); picking stops at the cap or when no scenario adds anything. `manifest.reference` says how many of the outcomes seen across all scenarios the picked ones show.

| File | What it is |
|---|---|
| `document.pdf` | The print document, composed by the studio's page composer, normalised as described under Determinism. |
| `document.html` | The interactive web page, exactly as the studio exports it. |
| `email.html`, `email.txt` | The email, HTML and plain text. Subject and preheader are in `facts.json`. |
| `sms.txt` | The SMS text, with no trailing newline. |
| `facts.json` | What all of the above must carry. |

`facts.json`:

```jsonc
{
  "formatVersion": 1,
  "scenario": { "id": "…", "name": "…" }, "customer": { "id": "…", "name": "…" },
  "runId": "run-…", "contentDigest": "…", "projectDigest": "…", "engine": "iss-resolver/1.0.0", "language": "en-US",
  "expected": { /* the engine's semantic manifest: selectedVariants, money (cents by component), guardedLiabilityNodeIds, disclosures, requiredNodeIds, visibleNodeIds, tableRows, tableTotalsCents, actions, identity, facts */ },
  "outputs": {
    "document.pdf":  { "sha256": "…", "bytes": 91622, "pages": 2, "facts": { /* read back from the composed pages */ } },
    "document.html": { "sha256": "…", "bytes": 47538, "facts": { /* read back from the page in a browser */ } },
    "email.html":    { "sha256": "…", "bytes": 11531, "subject": "…", "preheader": "…" },
    "email.txt":     { "sha256": "…", "bytes": 1196 },
    "sms.txt":       { "sha256": "…", "bytes": 148, "encoding": "GSM-7", "characters": 148, "segments": 1 }
  },
  "parity": {
    "documents": { "ok": true, "checks": [ /* PDF and web page against expected */ ], "allowedDifferences": [ ] },
    "channels":  { "ok": true, "checks": [ /* email and SMS against expected */ ] }
  }
}
```

## Verifying a build against a package

1. **Check the package.** Hash every file and compare with `manifest.contents`.
2. **Build** from `template.json`, `wording/`, `data/dictionary.json` and `assets/`.
3. **Run every scenario.** Give the build `data`, compare what it decides with `expected`: messages, sections shown and hidden, language, amounts in cents, required notices, and blocking issues. A scenario with `produced: false` must not produce a document.
4. **Compare outputs** with `reference/<scenario>/`, using `facts.json`.

**"Matching" means carrying the same facts, not looking identical.** These are the studio's own parity checks (`compareManifests` and `checkChannelParity` in `packages/renderers`); `facts.json` → `parity` records their result for the studio's outputs:

- the message chosen for each message section;
- every amount, in whole cents, per component;
- amounts not determined yet (a member's liability under review) are shown as not determined, never as a figure;
- every required notice: same notice, same version, same content hash;
- every required section is present;
- row counts and totals of each table;
- who the document is for (name, account or member number where shown);
- where each link leads (this one is not blocking: a PDF prints the address or a QR code where the web page has a button).

Layout, page count, fonts and interactivity may differ. Email and SMS are checked for the amounts, dates, chosen messages, notices and links they contain.

The package does not come with a tool that runs these checks on someone else's output. That is the adapter's job (phase 6) or the runnable package's `verify` (phase 7).

## Versioning

- `formatVersion` is an integer. **It is raised only when a reader of the previous version could misread the package**: a file moved or removed, a field renamed, or a meaning changed.
- **Additions do not raise it.** New files appear in `contents` with a new `role`; new fields appear in existing files. A reader must ignore paths, roles and fields it does not know. This is how `library/`, `data/mapping-<ccm>.json` and the runnable package's files will arrive.
- Each JSON file inside carries its own `formatVersion`, raised under the same rule for that file alone.
- `template.json` is versioned by `schemaVersion` (the studio's project format).
- A format change is announced in this document, with what a reader has to change.
- The studio records the format version a release was created under, and does not build that release's package under another.

### Additions for calculated fields, lookup tables and dates (rules and data depth, wave 2)

No reader of format 1 can misread a package because of these, so `formatVersion` stays **1**. Every addition below is
absent from the package of a template that does not use the feature, so such packages are unchanged.

- `template.json` may carry `calculatedFields`, `lookupTables`, `documentDate`, `effective` on rules and conditional
  sections, `variantPeriods` on messages and `totalFrom` on tables (`schemaVersion` stays `1.0.0`: older studios ignore
  unknown fields, and the engine of the release is the one that knows them).
- `manifest.json`: `documentDate` (`{ "source": "run" }` or `{ "source": "field", "path": … }`) and `dateBoundaries`:
  every day on which what the document says changes, each with `changes` (`kind` rule / variant / section / lookup-row,
  `id`, `nodeId`, `change` starts / ends, `words`) and `scenarios: { dayBefore, onTheDay }` (scenario ids).
- `data/dictionary.json`: a calculated field has `calculated: true`, `calculatedFrom` (data fields, lists, other
  calculations as `calc.<key>`, and `document.date`), and `calculation: { gives, formula, inWords, description? }`; the
  document's date is the field `document.date` with `documentDate` saying where it comes from; top-level `documentDate`
  and `lookupTables` (id, title, keys, columns, rows, `whenNoRowMatches`, `problems`, `usedBy`). `inWords` is fixed
  studio English, not customer-visible text. A field's `type` can be `number` (a calculated number, may have decimals).
- `tests/scenarios.json`: a scenario may have `issueDate` (the document's date it is produced as issued on) and
  `dateBoundary: { date, side: "before" | "on" }`. Its `expected` adds `issueDate`, `issueDateGiven` and `calculated`
  (each calculated value of that synthetic customer, by path). For every date boundary there is one scenario for the day
  before and one for the day itself, placed after the pinned tests and within the scenario cap.
- `reference/`: both sides of every boundary come first among the reference outputs (within the reference cap of 8),
  then the greedy cover of the remaining outcomes as before.
- `README.html` gains a "Dates" section (what changes on which day, and the scenarios on each side) when the template
  uses dates.

## Limits

- **Caps.** 24 scenarios and 8 sets of reference outputs. A document with many rules will have outcomes that are in `scenarios.json` but have no reference output, and may have scenarios named in `omittedByCap`.
- **Blocked scenarios have no reference output.** The scenario says why the document is not produced.
- **A pinned test on a non-synthetic customer is left out**, even though the document was approved with it passing. This is deliberate.
- **The reference PDF's bytes are specific to the studio machine** (browser build and fonts). Compare PDFs by facts.
- **`data/dictionary.json` describes the studio's field names.** Mapping them to a CCM's names is phase 3.
- **No signature.** The manifest's checksums detect damage, not tampering by someone who can rewrite the manifest. The studio keeps the ZIP's SHA-256 and returns it with every download (`X-Sha256`).
- **The planner's search is bounded**, so for a very large document an outcome can be reported as not reached within the limit.

# Templates and working with an existing CCM

Status: **design agreed in a workshop with the product owner; nothing in this document is built yet.**
Build starts after the AI assistant work is finished and verified, in the phases below, with a check-in at the start of each phase.

## Where we start from

- Three starter templates are built into the code. A new project is a copy of one. Users cannot save their own.
- A project is one JSON document in the studio's database, with version history, compare, restore and a draft → review → approved workflow.
- A project exports as a single JSON file. Outputs (PDF, HTML, email, SMS) export separately. AFP is a simulation.
- Customers can be imported (CSV or JSON). A project or template cannot be imported.
- Nothing connects to another system: no package format, no mapping to an external data dictionary, no sync.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Which CCM? | **Several; stay neutral.** One documented template package, with a thin adapter per CCM added over time. No vendor format is built until a target CCM and sample files exist. |
| 2 | The studio's role | **The studio designs, the CCM produces.** Templates are authored, tested, translated and approved in the studio. The CCM receives approved releases and runs production. The studio is the master copy for design. Import is for onboarding existing templates, not for round-tripping. *Added 2026-11-13 (decision 9):* the CCM still runs production, but it may compose documents by calling the studio's own engine from a runnable package instead of rebuilding the template in its internal format. |
| 3 | How templates are organised | **Templates plus a shared library.** One template per document type, and a library of shared building blocks (brand, header and footer, required notices, common messages, rules, glossary). A document links to a library item; one approved change reaches every document that uses it, after showing what will be affected. Any saved document can be published as a starter template. |
| 4 | Where the master copy lives | **The studio's database, with releases.** Approving a template creates a numbered, frozen release. A release moves through named stages (for example Test, then Production); each move is recorded with who and when. The CCM only ever receives a release. *Later option, to be designed in from the start:* also write each release to a Git repository. |
| 5 | What the CCM receives | **A full release package** (one ZIP per release): manifest with checksums; template definition in a documented, versioned JSON format; wording per language as XLIFF and plain files; the data dictionary; brand assets and a font list; test scenarios with expected results; reference outputs (PDF, HTML, email, SMS) for sample customers; approver and date. |
| 6 | Bringing existing templates in | **Assisted rebuild now, native importers later.** Import what any CCM can export in a standard form (wording tables as CSV/XLIFF/Word, the data dictionary as CSV/JSON/XSD, a sample PDF). The studio builds a draft and lists what it could not bring across for a person to rebuild. A native importer is added only when a customer and sample files justify it. |
| 7 | Data | **A data dictionary per template, with a mapping per CCM.** Every field the template needs (type, format, required, example), and per target CCM a mapping to that CCM's field names and formats. A release cannot be approved while a required field is unmapped. Customer sample files are validated against the dictionary. |
| 8 | The handover | **Download now, API ready for later.** A Releases page shows, per target CCM and stage, what was handed over, when and by whom, and lets the CCM team mark it received or live. The same releases are available through a documented, authenticated API. The studio makes no outbound connection. |
| 9 | Producing at scale without rebuilding the template | **A runnable package per release, as an extra export option** (added 2026-11-13). It holds everything needed to run: the released template as data, a pinned version of the one shared engine, a generated data contract and entry point, and a proof pack. The external system feeds it JSON and gets PDF, interactive HTML, email and SMS. One shared engine, not generated code per template. PDF is composed by a headless browser for now; AFP stays a simulation. Built as phase 7. |

## What follows from these

- **A release is immutable and self-describing.** Its number, content hash, approver and the engine and renderer versions go into the manifest, so "what is live" can always be answered and reproduced.
- **Reference outputs are the acceptance test for a CCM build.** The CCM team proves their build by matching the reference outputs for the packaged test scenarios. The studio's existing parity checks (same amounts, messages, notices and links across outputs) define what "matching" means.
- **Library items are versioned like templates.** A template pins the library version it was approved with; updating to a newer library version is an explicit, reviewed change with an impact list, never silent.
- **Adapters live outside the core.** An adapter reads a release package and writes whatever one CCM needs. The package format is the contract; a format change is versioned and announced.
- **Git later:** releases are already frozen, file-shaped and hash-addressed, so writing them to a repository adds a destination, not a redesign.

## The release package (sketch, to be finalised in phase 2)

```
<template-id>-r<release>.zip
  manifest.json            package format version, release number, stage, approver, date, engine and renderer versions, file list with SHA-256
  template.json            layout, components, rules, channel settings (documented schema, versioned)
  library/                 the pinned versions of the shared items this template uses
  wording/<locale>.xlf     every customer-visible text per language (XLIFF 2.x), plus wording/<locale>.csv
  data/dictionary.json     fields the template needs: path, label, type, format, required, example
  data/mapping-<ccm>.json  field names and formats in the target CCM (one per configured target)
  assets/                  images; fonts.json lists the fonts required (font files are not redistributed)
  tests/scenarios.json     named customers and what-ifs with expected messages, sections and amounts
  reference/<scenario>/    document.pdf, document.html, email.html, email.txt, sms.txt, facts.json
  README.html              what this is, how to verify a build against it
```

## Phases

1. **Save as template and project import/export.** Publish a document as a starter template; import a studio project file (validated, as a new draft). Small, useful on its own, and the base for everything else.
2. **Releases and the package.** Frozen numbered releases on approval, stages, the Releases page, the package format with manifest, XLIFF, tests and reference outputs, and the read-only API.
3. **Data dictionary and mappings.** Dictionary per template, mapping per target CCM, the "every required field is mapped" gate, validation of sample files.
4. **Shared library.** Library items, linking, pinned versions, impact list on update.
5. **Assisted import.** Draft a template from wording tables, a data dictionary and a sample PDF, with the list of what was not brought across.
6. **First adapter**, for whichever CCM is named first; and optionally Git as a release destination.
7. **Runnable package.** An extra export per release that an external system runs to produce documents itself, with no rebuild of the template (see below).

Each phase ends with tests, documentation and a demo path, and is verified before the next starts.

## The runnable package (phase 7, agreed 2026-11-13, not built)

**Why.** The only way to guarantee that what an external system produces equals what was approved in the studio is to run the same engine on the same release. Rebuilding a template in a CCM's internal format is where precision is lost. The release package (phases 2–6) stays for CCMs that prefer to rebuild; this is in addition.

**What it is.** One self-contained package per release, with all that is required to run it:

```
<template-id>-r<release>-runtime/
  release/                 the frozen release exactly as in the release package (template, library, wording, assets, manifest)
  engine/                  one pinned version of the shared engine: resolver, renderers, page composer, headless browser
  contract/                input.schema.json (generated from the data dictionary), sample-input.json, entry point
  proof/                   synthetic inputs with expected outputs and digests; `verify` runs them and reports any difference
  run                      command line:  run --data customers.jsonl --outputs pdf,html,email,sms --out <dir>
  serve                    the same over local HTTP:  POST /render
  image/                   container definition (and, where it can be built, a ready image) so nothing has to be installed
  README.html              how to run, verify and upgrade
```

**Rules it follows.**

- **One shared engine, pinned per release.** Not generated code per template: working out what a customer gets already takes under a millisecond, so compiling templates buys no speed and would turn every template into its own codebase. A fix to the engine is one new engine version, and a release moves to it only through a new, verified release.
- **Approved content only.** It runs frozen releases; draft wording and unapproved translations cannot be produced.
- **Same answer as the studio.** Email, SMS and HTML are byte-identical for the same input; every document carries the same run ID the studio would give it. `verify` proves this on the operator's own machine before go-live and after any upgrade.
- **A document with a blocking issue is not produced.** It is listed in the results file with the reason, the same way the studio blocks it.
- **Customer data stays with the operator.** The package makes no outbound connection, writes no customer values to its logs, and the studio never sees production data. The proof pack uses synthetic customers only.
- **Fonts.** A runnable package needs its fonts. They are included when the right to redistribute is confirmed; otherwise the package names the fonts the operator must install and `verify` fails clearly until they are present.

**What each output can promise in the first version.**

| Output | First version | Measured in the studio, one document |
|---|---|---|
| Email, SMS, interactive HTML | Produced by the same pure functions as the studio | about 1.5 ms for all three |
| PDF | Composed by a headless browser, as in the studio. Precise; suited to moderate volumes run in parallel | about 300 ms (about 12,000 per core-hour) |
| AFP | Simulation only, clearly labelled. Not for production | n/a |

These timings are single-document measurements in the development environment, not a load test. Phase 7 includes a measured throughput test.

**Path to production AFP (ideas recorded, not approved work).**

1. **Now, no build:** hand print-ready PDF to the print side and use the PDF-to-AFP transform most print operations already run. The PDF is the proof of what was approved.
2. **A browser-free page description.** Lay out pages without a browser into one neutral description (positioned text, images, lines per page). This is the prerequisite for both a fast PDF writer and a native AFP writer, so one investment serves both.
3. **A native AFP writer** on top of that description, in two steps: pages as images first (simple and visually exact, but large and not searchable), then real text with outline fonts, vector graphics, overlays for static content, and index tags for inserters and archives.
4. **Proof against a real print environment.** AFP cannot be called production-ready from the studio alone: it needs a named print partner, their resolution, fonts, barcode and finishing requirements, and their preflight of sample jobs.

**Costs to keep in view.** The studio's engine would run in other people's environments, which brings versioning, security patching, licensing and a support matrix. The engine is TypeScript; a container or command line avoids a port to Java or .NET, which would be a second implementation and weaken the guarantee.

## Needed from the product owner

- The name of the first target CCM when there is one, and from it: a sample template export, its data definition, and a sample output.
- The stage names you want (default: Test, Production).
- Who may create a release and who may move it between stages (default: approvers create; admins move to Production).

## Risks and limits to keep in view

- **Fidelity is one-way by design.** The studio hands a complete, verifiable description to the CCM; it does not promise that a CCM can reproduce every layout feature. The reference outputs make differences visible instead of hiding them. A CCM that needs exact reproduction uses the runnable package (phase 7) instead of rebuilding.
- **Assisted import is a starting point, not a conversion.** Scripted logic and vendor-specific features have to be rebuilt as rules by a person. The import report says exactly what.
- **Fonts and licensed assets** are listed, not shipped, unless the customer confirms the right to redistribute them.
- **AFP and other print streams** stay the CCM's responsibility; the studio's AFP output remains a simulation, in the runnable package too. The path to production AFP is recorded above and is not approved work.
- **No customer data** is ever placed in a release package: test scenarios and reference outputs use synthetic customers only.

# The runnable package

Status: **format version 1, built and tested (phase 7 of the template work).** Design and rules: [`TEMPLATES_AND_CCM.md`](TEMPLATES_AND_CCM.md), section "The runnable package". Routes: [`docs/api/RELEASES.md`](../api/RELEASES.md).

One ZIP per release that another system runs to produce the documents itself, with the studio's own engine, instead of rebuilding the template. Builder: `apps/api/src/runnablePackage.ts`. Engine and command line: `packages/runtime` (`@iss/runtime`). Screen: the "Runnable package" section of a release on the Releases screen.

## Layout

```
<document-id>-r<release>-runtime/          (the ZIP unpacks into this folder)
  runtime.json            format, release, engine (version, SHA-256), proof counts, and every other file with its SHA-256 and size
  README.html             how to run, verify and upgrade, in plain words
  run  serve  verify      the three commands: small Node.js scripts that start the engine (node run …)
  package.json            pins the folder to CommonJS so the scripts run wherever it is unpacked
  release/                the release package of this release, file for file (manifest.json, template.json, wording/, data/, assets/, tests/, reference/)
  engine/iss-engine.mjs   the engine: resolver, renderers, data contract and command line, bundled by esbuild into one file that runs with Node alone
  engine/engine.json      engine and renderer versions, the SHA-256 of iss-engine.mjs, how it was bundled, what PDF needs
  engine/node_modules/playwright-core/   the page composer for PDF (Apache-2.0, as published, with LICENSE and NOTICE), loaded only for PDF
  contract/input.schema.json   JSON Schema of one customer, generated from release/data/dictionary.json
  contract/sample-input.json   one synthetic input line
  contract/entry-point.json    the commands, the input line, the HTTP routes, results and exit codes, for the operator's tools
  proof/inputs.jsonl           synthetic customers: the release package's scenarios, plus one line the contract refuses
  proof/expected.json          per line: produced / stopped (issue codes) / invalid, run ID, content fingerprint, output fingerprints
  proof/expected/<case>/       document.html, email.html, email.txt, sms.txt as the studio produced them
  image/Dockerfile             container definition (Microsoft's Playwright image for the same playwright-core; runs verify while it builds)
```

Different from the design sketch, and why:

- **`verify` is a third command file**, next to `run` and `serve` (the design names it as a command but not as a file).
- **`runtime.json` and `package.json` sit at the top.** `runtime.json` is the integrity list `verify` checks (the release's own `manifest.json` covers `release/` only). `package.json` makes the extensionless scripts CommonJS wherever the folder is unpacked.
- **The headless browser is not inside.** It is a few hundred megabytes and differs per operating system. The package carries the pinned page composer (playwright-core 1.63.0) and finds the browser from `CHROMIUM_PATH` or the Playwright install; the container definition supplies both.
- **No ready container image.** No container daemon was running where this was built (`docker info`: "Cannot connect to the Docker daemon"), so no image was built or tested. `scripts/runtime-throughput.mjs --image` builds one when a daemon answers.
- **No font files.** None are in this repository (no `.ttf`, `.otf` or `.woff` file is tracked), so there is nothing whose licence allows redistribution. The README names the fonts; `verify` fails until they are present.

## The commands

| Command | What it does |
|---|---|
| `node run --data customers.jsonl --outputs pdf,html,email,sms --out <dir> [--parallel n]` | One document set per input line. Writes `documents/<ref>/…`, `results.jsonl`, `proof.jsonl`, `summary.json`. Outputs default to `html,email,sms`. Refuses a folder that already holds results. |
| `node serve [--port 8787] [--host 127.0.0.1] [--pdf]` | `POST /render` (200 produced, 409 stopped, 422 refused by the contract, 503 PDF without a browser), `GET /health`. Binds to 127.0.0.1 unless told otherwise. One log line per request: method, route, status, time. |
| `node verify [--without-pdf] [--json]` | Every file against `runtime.json`; the engine's own SHA-256; no drafts in the template; the template's digest against the release manifest; the browser and the fonts; then every proof case produced again and compared (status, issue codes, run ID, content digest, every file byte for byte, the PDF's content fingerprint and page count). Exit 1 on any difference, a missing browser or a missing font. |
| `node engine/iss-engine.mjs generate --count n --out file` | Engine-generated synthetic customers (the release's own outcome and edge cases, from the proof pack's synthetic customers), each with its own record id. |
| `node engine/iss-engine.mjs version` | Format, engine and renderer versions, and the SHA-256 computed from the engine file. |

An input line is a customer record, or `{ "customerRef": "...", "data": <record> }`; the reference defaults to `recordId`. Every line goes through the studio's own record check (`validateRecordShape`), with the values taken out of its messages. A bad line is reported in `results.jsonl` and skipped.

`results.jsonl`: `{ line, customerRef, status: "produced", runId, files }`, `{ …, status: "stopped", runId, blockedBy: [codes] }`, `{ …, status: "invalid", problems }` or `{ …, status: "failed", reason }`. `proof.jsonl`: one `proof-record/1` per document resolved (produced or stopped), `producer: "runtime"`, `producedAt` from the clock when it was produced. Fingerprints: HTML, email (`email.html`) and SMS by the SHA-256 of the exact file; PDF by the SHA-256 of the page source composed (`renderPagedDocument`) and the page count.

`run` (and `serve`, `generate`) refuse to start when the template, the release manifest, the font list, the engine description or the engine file was changed, when the template carries any draft, or when the engine's versions differ from the release's (exit 3).

## The document's date

For a template that uses dates (`documentDate` in `release/template.json`):

- `node run … --issue-date YYYY-MM-DD` gives the document's date for every customer of the run; a line may carry its own
  `"issueDate"` next to `"data"` (it wins). An invalid date is refused: the option with exit code 2, a line as `invalid`.
- A date given for the run is part of the run ID, is stated as `issueDate` in `results.jsonl` (never a date taken from
  the customer's data: that is a customer value), and is kept as `issueDate` in the proof record.
- `POST /render` accepts `"issueDate"` next to `"data"`; the answer states it.
- `proof/inputs.jsonl` keeps each dated scenario's `issueDate`, `proof/expected.json` records it per case, and
  `node verify` checks that each dated case is produced as issued on that day and that its proof record says so
  (`datedCases` in `--json`).
- `generate` keeps the date a generated customer reaches its outcome on.
- A template whose date is given for each run stops a customer with no date (`DOCUMENT_DATE_MISSING`), exactly as the
  studio does.

`RUNTIME_FORMAT_VERSION` stays 1: a line without `issueDate` means what it meant before, and the option is new.

## What holds, and how it is tested

`apps/api/test/runnable-package.test.ts` builds packages through the API, unpacks them into a temporary folder outside the repository and runs them with `process.execPath` and an environment of `PATH`, `HOME`, `LANG` (and `PLAYWRIGHT_BROWSERS_PATH` when set) only:

- **Same answer as the studio.** For six sample customers, a Spanish one and the release package's reference scenarios: `document.html`, `email.html`, `email.txt` and `sms.txt` are byte-identical to `renderInteractiveHtml`, `renderEmail` and `renderSms` on the release's template, and to the release package's reference files; run IDs equal `resolve` on the template and the release package's `facts.json`. Every `proof.jsonl` line passes `proofRecordProblems`, and `verifyProof` in the studio finds no difference.
- **Run IDs and the studio's stored copy.** When the approved version carries unapproved translation drafts, the studio's stored copy of the release resolves to a *different* run ID than the release's template (the resolver's project digest includes the drafts). For a release without drafts they are equal (tested on HarborCare). See "Open points".
- **Blocked and invalid.** A customer with a blocking issue is listed as stopped with its codes and gets no files; a line that is not JSON and a line with a wrong type are reported without their values.
- **Approved content only.** The Spanish customer gets approved Spanish, never the draft; a template with the drafts put back is refused by `run` (exit 3) and `verify`.
- **Tampering.** `verify` passes on the untouched package, and fails, naming the file, after a change to `release/template.json`, an expected output, or `engine/iss-engine.mjs`.
- **No outbound connection.** `run`, `verify` and `serve` run under a `--import` guard that records every `net.Socket.connect`, `tls.connect`, `dns.lookup` of a name, `dns.resolve`, `http(s).request/get` and `fetch`; nothing is recorded (`serve` only answers the test's own requests). The engine file is also scanned: its only Node imports are `crypto`, `fs`, `http` (the server), `module`, `os`, `path`, `readline`, `url`. Not covered: what Chromium itself does in the background while composing a PDF (pages are opened with Playwright's `offline: true` and carry no external references).
- **No customer data.** Every file of the ZIP is scanned for the names of an imported, a supplied and an edited customer and for draft wording, as for the release package; the proof inputs are exactly the release package's scenarios (built-in samples and engine-generated customers) plus one derived invalid line. No file states when it was built.
- **Determinism.** Building again a second later, and building directly from the same inputs, gives the same ZIP bytes.
- **PDF.** With the real composer: `verify` composes the proof pack and passes; `run` writes real PDFs whose proof fingerprints match the studio's page source and page count; with an empty font configuration (`FONTCONFIG_FILE`), `verify` fails and names the font. Without a browser, `run --outputs pdf` exits 4 with a plain message and email/SMS/HTML still run; without the composer files, the same.

Browser test: `e2e/runtime.spec.ts` (prepare, busy, ready, size and fingerprint, the three commands, download matches the SHA-256, check again, audit).

## Measured throughput

**One run on one development machine. Not a load test.** Measured with `node scripts/runtime-throughput.mjs --api http://127.0.0.1:3103 --release harborcare-demo-r1 --count 5000 --pdf-count 200 --pdf-parallel 1,4` on 2026-11-13.

- Machine: Intel Xeon Processor @ 2.10GHz, 4 cores, 15.6 GiB memory, Linux 6.18, Node.js v22.23.4; Chromium from the Playwright 1.63 install on the machine (revision 1243).
- Release: HarborCare explanation of benefits, release 1 (engine `iss-resolver/1.0.0`).
- Customers: 5,000 lines made by the package's own `generate`: 23 different engine-generated synthetic customers repeated with their own record ids. Some of them are built to be stopped by a blocking issue, so not every line produces a document.
- Each run writes every file to disk plus `results.jsonl` and `proof.jsonl`; the timing is the wall time of the whole `node run` process, start to exit.
- "Per core-hour" is documents per hour divided by the machine's 4 cores, whatever the run actually used.
- Peak memory: the largest sum of resident memory of the run's process tree (Node and Chromium), sampled every 100 ms.

| Run | Lines | Produced | Stopped | Wall time | Document sets per second | Per core-hour | Peak memory |
|---|---|---|---|---|---|---|---|
| Email + SMS + HTML | 5,000 | 4,565 | 435 | 8.07 s | 565.79 | 509,215 | 137 MiB (Node's own max RSS 140 MiB) |
| PDF + HTML + email + SMS, 1 page at a time | 200 | 183 | 17 | 36.36 s | 5.03 | 4,529 | 610 MiB |
| PDF + HTML + email + SMS, 4 pages in parallel | 200 | 183 | 17 | 27.21 s | 6.72 | 6,052 | 968 MiB |

What this says, and does not: email, SMS and HTML together took about 1.8 ms per produced set including writing files and proof records, in line with the studio's single-document figure. PDF is dominated by the browser; four pages in parallel were only about a third faster than one at a time on this 4-core machine, so the browser, not the engine, is the limit. The PDF figures include starting the browser (not measured separately) and are from a single run each; they were not repeated, averaged or tried on other machines, documents or operating systems.

## Open points

- **The studio's run ID with drafts present.** The resolver's run ID depends on a digest of the whole project, drafts included. The package runs the release's template (drafts removed), so for a release whose approved version carried unapproved drafts, the studio's live preview of that version shows another run ID than the package (and the release package's reference outputs) give. Proposed: leave drafts out of the digest the run ID uses (`packages/resolver/src/resolve.ts`), or have the studio resolve `releaseTemplate(frozen)` whenever it speaks for a release.
- **Not verified:** the container image (no daemon), other operating systems (Windows, macOS), other Node.js versions, other Chromium builds, a machine with Arial installed (the reference PDFs here used Liberation Sans, which `verify` therefore requires), and documents longer than a few pages.

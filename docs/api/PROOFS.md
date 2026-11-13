# Proofs API

Status: **built and tested (wave 1).** Screen: Proof (S21, `apps/web/src/screens/ProofLookup.tsx`, helpers in `screens/proof/`), plus "Produce from this release" in the release detail (`screens/releases/ProduceSection.tsx`).
Design: `docs/design/BEFORE_AFTER_AND_PROOF.md`, "Proof for any customer". Record contract: `packages/resolver/src/proof.ts` (`ProofRecord`, `buildProofRecord`, `verifyProof`, `proofRecordProblems`).
Code: `apps/api/src/proofs.ts` (store, producing, checking, plain words), `apps/api/src/routes/proofs.ts` (routes). Tests: `apps/api/test/proofs.test.ts`, `e2e/proof.spec.ts`.

## What is kept, and what is not

A proof record keeps fingerprints and decisions (the contract in `proof.ts`), never the customer's data, any value a rule tested, or the produced files. The customer reference is an identifier chosen by the producing system (for the studio, the test customer's id).

Records are kept in the table `proof_records` (created by `ProofStore` in `proofs.ts`; `db.ts` is unchanged). It only ever grows:

- There is no update or delete method, and the table refuses both: the trigger `proof_records_are_frozen` aborts any `UPDATE`, and `proof_records_are_kept` aborts any `DELETE` unless the test reset has opened its gate for the length of one transaction.
- Every record is checked before it is stored: `proofRecordProblems`, plus `proofProblems` (no extra field inside a decision or an output fingerprint either, no overlong text, whole-number sizes and page counts, each output once, a stopped document lists no outputs).
- Adding a record whose proof id is already stored stores nothing. It is reported as `known` (same content) or `conflict` (different content; the stored one is kept unchanged). Neither is an error.
- Indexed for search by document, release, customer reference, date (`produced_at`), proof id (primary key) and run id.
- A record whose release this studio does not have — or has under that id with different content — is kept and marked **"Release not known here"**. This is worked out when it is read (`release.status`: `known | unknown | different`), so it stays true if releases change.

## Who may do what

| Action | Author | Reviewer | Approver | Admin |
|---|---|---|---|---|
| Look up records, read one | yes | yes | yes | yes |
| Re-create and verify (stores nothing) | yes | yes | yes | yes |
| Produce from a release | no | no | yes | yes |
| Add records from a file | no | no | yes | yes |
| Reset (tests only) | no | no | no | yes |

Every document is visible to everyone signed in, so "anyone who can see the document" is anyone signed in. Producing and adding are checked in the handler so the refusal is in plain words: `403 FORBIDDEN` `"Only approvers and admins can produce documents from a release."` / `"…can add proof records."`, with `{ role, needs: "approve" }`. Without a session: `401 UNAUTHENTICATED`. With sign-in off the built-in local admin applies.

## Produce from a release

`POST /api/v1/releases/:releaseId/produce` — body `{ "recordId": "EOB-0004" }` or `{ "all": true }`, and optionally `"outputs": ["pdf", "html", "email", "sms"]` (default `["html", "email", "sms"]`).

- Resolves the **release template** (`releaseTemplate(frozen)`: the frozen approved version with unapproved translation drafts stripped, exactly the package's `template.json`, which the runnable package runs on). Never the working project, never drafts. Profile `paged-pdf`, as the runnable package.
- Fingerprints, the same as the runnable package (`packages/runtime/src/core.ts`, `outputFingerprints`): web page, email and SMS are `kind: "bytes"`, the SHA-256 of the exact file (email: the HTML email); the PDF is `kind: "content"`, the SHA-256 of the page source it is composed from (`renderPagedDocument`, no watermark) plus the page count of the composition.
- One record per customer, `producer: "studio"`, `producedAt` from the server clock (one time for the whole request). A customer stopped by a blocking issue gets `produced: false`, `blockedBy` and no outputs.
- **Test customers** are the document's: the shared samples and imported customers of its kind, and its own customers.
- **Runs inline**, not through the batch runner: email, SMS and web page need no browser (a few ms each), so up to **500** customers (the batch limit) are produced in one request, giving other requests their turn between customers. **With the PDF, at most 20** customers per request (each PDF is composed in a browser, about 0.3 s). **One produce request at a time** (`409 PRODUCE_RUNNING`).
- All records of a request are stored together or not at all. A composition failure stores nothing (`502 PRODUCE_FAILED`).
- **The produced files are not kept** by this feature. They go nowhere: the answer carries the fingerprints and records only.

`201`:

```jsonc
{
  "release": { "id": "harborcare-demo-r1", "number": 1, "title": "…", "documentId": "harborcare-demo", "standing": "test", "documentRemoved": false },
  "producedAt": "2026-11-13T18:09:00.000Z", "outputs": ["html", "email", "sms"],
  "counts": { "customers": 30, "produced": 30, "stopped": 0, "added": 30 },
  "results": [{ "proofId": "proof-…", "customerRef": "EOB-0001", "produced": true, "blockedBy": [], "blockedWords": [], "outputs": [/* ProofOutput */] }],
  "filesKept": false,
  "message": "30 of 30 produced from release 1. The produced files are not kept: each proof record keeps their fingerprints."
}
```

Errors: `409 RELEASE_NOT_CURRENT` (only a release that is current at Test or Production may be produced from; the message says whether it was withdrawn or replaced, or its document deleted), `400 CUSTOMERS_REQUIRED`, `400 INVALID_OUTPUTS`, `404 NOT_FOUND` (release, or not a test customer of this document), `404 NO_CUSTOMERS`, `413 TOO_MANY_CUSTOMERS` (with `limit`), `409 PRODUCE_RUNNING`, `502 PRODUCE_FAILED`.

## Add proof records from a file

`POST /api/v1/proofs/import` — body `{ "text": "<the text of proof.jsonl>", "dryRun": true }`. **`dryRun` defaults to true**: send `false` to add.

The file is untrusted. One JSON record per line; blank lines are skipped; every line is parsed and checked; a record with any field beyond the contract is refused; nothing is run or trusted beyond the record's fields. Limits: **5 MB**, **10,000 records**, **256 KB per line** (`413 FILE_TOO_LARGE` for the first two).

```jsonc
{
  "dryRun": true, "lines": 5,
  "new": 2, "known": 1, "conflict": 0, "refused": 2,
  "unknownRelease": 1,              // of the new ones: kept and marked "Release not known here"
  "producers": { "studio": 0, "runtime": 2 },   // of the new ones
  "added": 0,                       // what was stored (always 0 in a dry run)
  "details": [{ "line": 4, "proofId": null, "outcome": "refused", "problems": ["The line is not JSON."] }],   // first 500 lines
  "detailsCut": false
}
```

Only proof ids and problems are repeated back, nothing else from the file. Records from the runnable package (`producer: "runtime"`) are stored and searched exactly like studio ones; `meta.source` says `"file"`. A dry run writes no audit entry.

## Look up

`GET /api/v1/proofs?documentId=&releaseId=&customerRef=&from=&to=&q=&limit=&offset=`

- Newest first by when it was produced. `limit` 1–100 (default 25), `offset` from 0.
- `from` / `to`: a date `YYYY-MM-DD` (whole days, UTC; `to` includes the day) or an ISO time. `400 INVALID_DATE` otherwise.
- `q` matches part of a proof id or a run id.

```jsonc
{
  "records": [{ "proof": { /* ProofRecord */ }, "meta": { "source": "studio", "addedAt": "…", "addedBy": { "id": "…", "name": "…" } },
                "release": { "status": "known", "message": null, "info": { /* as in produce */ } } }],
  "total": 31, "limit": 25, "offset": 0,
  "limits": { "customers": 500, "customersWithPdf": 20, "fileBytes": 5242880, "fileLines": 10000, "lineBytes": 262144, "suppliedBytes": 1048576, "pageMax": 100 }
}
```

`GET /api/v1/proofs/:proofId` — the same item, plus:

```jsonc
{
  "explanation": {
    "namedFrom": "release",          // "ids" when the studio does not have the release
    "decisions": [{ "nodeId": "eob-claim-message", "part": "Claim message", "variantId": "eob-processing", "message": "Processing your claim", "rules": [{ "id": "R16", "title": "Out-of-network provider — explain network" }], "known": true }],
    "blocked": [{ "code": "CLAIM_RECONCILIATION_FAILED", "words": "the customer’s data did not add up" }],
    "valuesHeld": false
  },
  "outputs": [{ "channel": "email", "kind": "bytes", "sha256": "…", "size": 9123, "label": "email" }]
}
```

Names come from the release template (part names, message titles, rule titles). No customer values: none are held. `404 NOT_FOUND` for an unknown proof id.

## Re-create and verify

`POST /api/v1/proofs/:proofId/verify` — body `{ "recordId": "EOB-0002" }` (a test customer of the document) **or** `{ "record": { /* the customer's data, with its recordId */ } }`, and optionally `"releaseId"` to re-create with another release (to see what differs; the answer then names the release difference).

The server resolves the release template on that data, produces the outputs the record lists, and compares with `verifyProof`.

```jsonc
{
  "proofId": "proof-…", "same": true,
  "verdict": "Same data, same release, same result.",     // or "Not the same."
  "differences": [{ "kind": "data", "message": "<verifyProof's words>", "plain": "The data supplied is not the data the document was produced from." }],
  "checked": { "release": { /* … */ }, "dataFrom": "test-customer", "outputs": ["html", "email", "sms"], "stored": false },
  // Only when the same: the explanation with values and the re-created outputs, for this check only.
  "explanation": [{ "nodeId": "…", "part": "Claim message", "headline": "…", "steps": ["…"] }],
  "recreated": { "html": "…", "email": { "subject": "…", "preheader": "…", "html": "…", "text": "…" }, "sms": "…", "pdf": { "pages": 2, "note": "…" } }
}
```

`plain` names parts, messages and rules from the release ("“Claim message” showed “Processing your claim” then and shows “Claim denied” now."), outputs by name ("The text message (SMS) differs from what was produced.").

**The supplied data is never stored and never logged.** It is used for this one answer. Errors raised while reading it are answered with fixed words (`422 CANNOT_RECREATE`); the shape check (`422 INVALID_DATA`, with `problems`) may quote the supplied values back to the caller, and to no one else. The audit entry records that a check happened and its verdict, not the data. The PDF itself is not returned (its page count is).

Errors: `400 DATA_REQUIRED`, `404 NOT_FOUND`, `409 RELEASE_NOT_KNOWN` (the record's release is not here and no `releaseId` was given), `413 DATA_TOO_LARGE` (1 MB), `422 INVALID_DATA`, `422 CANNOT_RECREATE`.

## Reset (tests and demos only)

`POST /api/v1/proofs/reset` with `{ "confirm": true }` removes every proof record. `403 RESET_DISABLED` unless the server runs with `PROOFS_RESET=allow` (or `RELEASES_RESET=allow`); admins only. Start a test stack with `PROOFS_RESET=allow node scripts/dev-isolated.mjs <slot>`.

## Audit entries

Names and numbers only, never customer values.

| Action | `detail` |
|---|---|
| `proof.produce` | `releaseId`, `number`, `title`, `customers`, `produced`, `stopped`, `outputs`, and `all: true` or `customerRef` |
| `proof.import` | `added`, `known`, `conflict`, `refused`, `unknownRelease`, `runtime`, `studio`, `documents` (ids, at most 10) |
| `proof.verify` | `proofId`, `releaseId`, `number`, `dataFrom` (`test-customer` or `supplied`), `same`, `differences` (kinds) |
| `proof.reset` | `removed` |

## Limits

- A proof record shows what was produced, not that it was delivered. It is not an archive: a document can be re-created only when the data is supplied again and the release still exists here. Retention rules and legal holds are not part of it.
- One produce request at a time, inline in the API process; with the PDF, 20 customers per request.
- `verifyProof` compares the engine version too: after an engine upgrade, a check says the engine differs.

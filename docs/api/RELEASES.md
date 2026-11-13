# Releases API

Status: **built and tested on the server (phase 2 of the template work). The Releases screen (`apps/web/src/screens/Releases.tsx`) uses it.**
Design background: `docs/design/TEMPLATES_AND_CCM.md`. Package format: `docs/design/RELEASE_PACKAGE.md`.
Code: `apps/api/src/routes/releases.ts` (routes), `apps/api/src/releases.ts` (creating, stages, keeping packages), `apps/api/src/releasePackage.ts` (the package builder), `packages/model/src/releases.ts` (the rules and the shared types). Tests: `apps/api/test/releases.test.ts`, `packages/model/test/releases.test.ts`.

## What a release is

- Approving a document (`POST /api/v1/projects/:projectId/workflow` with `action: "approve"`) creates its next numbered release at stage **Test**, frozen at exactly the approved version.
- A release never changes. The store has no way to edit one and the database table refuses a write to any frozen column. Only two things about a release can change: where it stands at each stage, and whether its document still exists.
- Stages are **Test**, then **Production**. At each stage at most one release of a document is *current*. A newer one makes the earlier one *superseded*. A release can be *withdrawn* from a stage with a reason. Nothing is deleted.
- Deleting a document keeps its releases, marked `documentRemoved`. A document id that has releases is never given to another document. Restoring a sample keeps its releases too.

## Who may do what

| Action | Author | Reviewer | Approver | Admin |
|---|---|---|---|---|
| Read releases, download packages, prepare a package | yes | yes | yes | yes |
| Create a release (by approving, or from the approved version) | no | no | yes | yes |
| Add to the handover log | no | no | yes | yes |
| Move a release to Production, withdraw a release | no | no | no | yes |

Every route needs the session cookie when sign-in is on (`401 UNAUTHENTICATED` without it). With sign-in off the built-in local admin applies, as everywhere else. A role that may not do something gets `403 FORBIDDEN` with `{ role, needs }`. Moving between stages uses the new permission `promote_release`, which only admins have; it appears in `permissions` of `GET /api/v1/session`.

Errors have the studio's usual shape: `{ "error": { "code", "message", "correlationId", ... } }`.

## Shared shapes

Types are exported from `@iss/model` (`ReleaseInfo`, `ReleaseStageState`, `ReleasePackageStatus`, `ReleaseEvent`, `HandoverEntry`, ...), with pure helpers the web can use to decide what to offer (`promoteProblem`, `withdrawProblem`, `releaseRoleProblem`, `releaseStanding`, the label maps).

### ReleaseInfo

```jsonc
{
  "id": "harborcare-demo-r1",              // "<document id>-r<number>"
  "documentId": "harborcare-demo",
  "number": 1,                              // starts at 1 per document, never reused
  "title": "HarborCare – explanation of benefits",   // the document's title when it was approved
  "documentType": "eob",                    // credit-statement | eob | custom
  "kind": "Explanation of benefits",        // what a person calls that kind
  "modelVersion": 1,                        // the saved version that was approved
  "contentDigest": "44e16c20…",             // the studio's digest of the approved content (same value as in version history)
  "languages": ["en-US", "es-US"],          // source language first
  "approvedBy": { "id": "u-1a2b3c4d", "name": "Ada Approver" },   // null only if the approval had no recorded user
  "approvedAt": "2026-11-13T14:58:03.175Z",
  "origin": "approval",                     // "approval" = made when the document was approved; "manual" = made later from the approved version
  "createdBy": { "id": "u-1a2b3c4d", "name": "Ada Approver" },
  "createdAt": "2026-11-13T14:58:03.176Z",
  "versions": { "schema": "1.0.0", "engine": "iss-resolver/1.0.0", "pagedRenderer": "iss-paged-renderer/1.0.0", "htmlRenderer": "iss-html-renderer/1.0.0", "emailRenderer": "email-renderer/1", "smsRenderer": "sms-renderer/1", "packageFormat": 1 },
  "stages": {
    "test":       { "status": "current", "since": "…", "by": { "id": "…", "name": "…" } },
    "production": null                      // null until it is first moved to Production
  },
  "standing": "test",                       // production | test | superseded | withdrawn — one word for a list
  "documentRemoved": false,
  "documentRemovedAt": null,
  "package": { /* ReleasePackageStatus */ },
  "handover": { "received": false, "live": false, "entries": 0 }
}
```

A stage state is `{ status: "current" | "superseded" | "withdrawn", since, by, reason?, supersededBy? }`. `reason` is set when withdrawn; `supersededBy` is the release number that took its place.

`standing` is: `production` when it is the Production release; else `test` when it is the current Test release; else `withdrawn` when it was withdrawn from the furthest stage it reached (or from Test); else `superseded`.

### ReleasePackageStatus

```jsonc
{
  "status": "ready",                        // not-built | building | ready | failed
  "fileName": "harborcare-demo-r1.zip",
  "sha256": "35e1d8ba…",                    // ready only
  "bytes": 123711,                          // ready only
  "files": 41,                              // ready only (manifest.json included)
  "builtAt": "2026-11-13T14:58:03.311Z",    // when the studio built the ZIP it keeps; no file in the package states this
  "progress": null,                         // while work is going on: { "step": "Composing the reference outputs", "done": 2, "total": 5 }
  "error": null,                            // failed only: why, in plain words
  "summary": {                              // ready only
    "scenarios": 6, "references": 5, "pinnedExcluded": 0,
    "languages": [{ "locale": "es-US", "name": "Spanish (United States)", "texts": 117, "approved": 0, "missing": 117 }]
  },
  "verified": null                          // last check: { "at", "same": true, "sha256", "error": null }
}
```

"Building" is kept in memory only, so after a restart an interrupted build shows as `not-built`.

## Routes

### List releases

`GET /api/v1/releases?documentId=&stage=&status=`

- `documentId` narrows to one document.
- `stage=test|production` keeps the releases that are **current** at that stage. Add `status=superseded|withdrawn|any` for another standing at that stage (`any` = every release that has been at it). `status` without `stage` is `400 STAGE_REQUIRED`.
- Newest first.

```jsonc
{ "releases": [ /* ReleaseInfo */ ], "total": 4, "stages": [{ "id": "test", "label": "Test" }, { "id": "production", "label": "Production" }] }
```

Errors: `400 INVALID_STAGE`, `400 INVALID_STATUS`, `400 STAGE_REQUIRED`.

### What is live

`GET /api/v1/releases/live?includeUnreleased=1`

Per document that has at least one release (with `includeUnreleased=1`: every document), sorted by document id.

```jsonc
{
  "documents": [{
    "documentId": "harborcare-demo",
    "title": "HarborCare – explanation of benefits",   // the title now; for a deleted document, its latest release's title
    "documentType": "eob",
    "documentRemoved": false,
    "workflow": { "state": "approved", "label": "Approved" },   // null for a deleted document
    "production": null,                     // ReleaseInfo of the current Production release, or null
    "test": { /* ReleaseInfo */ },          // ReleaseInfo of the current Test release, or null
    "latest": { /* ReleaseInfo */ },        // the highest-numbered release, or null when there is none
    "releases": 1,
    "approvedUnreleased": false             // true when the document is approved and creating a release from that version would make a new one
  }],
  "stages": [{ "id": "test", "label": "Test" }, { "id": "production", "label": "Production" }]
}
```

`approvedUnreleased` is how to find documents that were approved before releases existed (and documents whose latest release was withdrawn).

### One document's releases

`GET /api/v1/projects/:projectId/releases` — works for a deleted document too, as long as it has releases. `404 NOT_FOUND` when there is neither a document nor a release with that id.

```jsonc
{
  "documentId": "harborcare-demo", "documentExists": true, "title": "HarborCare – explanation of benefits",
  "releases": [ /* ReleaseInfo, newest first */ ],
  "production": null,                       // id of the current Production release, or null
  "test": "harborcare-demo-r1",             // id of the current Test release, or null
  "create": { "allowed": true, "reason": null }   // may the caller create a release from the approved version right now; if not, why
}
```

### Create a release from the approved version

`POST /api/v1/projects/:projectId/releases` (approvers and admins; no body)

For documents approved before releases existed. Takes the version the review recorded as approved; the approver is the person who approved it, `createdBy` is the caller, `origin` is `manual`.

- `201` `{ "created": true, "reason": null, "message": "Release 1 was created at Test.", "release": ReleaseInfo }`
- `200` `{ "created": false, "reason": "unchanged", "message": "Release 1 already holds the approved version, so no new release was made.", "release": ReleaseInfo }` when the latest release already holds that content.
- `409 NOT_APPROVED` (with `state`) when the document is not approved or published; `409 APPROVED_VERSION_MISSING`; `404 NOT_FOUND`.

### Approving creates a release

`POST /api/v1/projects/:projectId/workflow` with `{ "action": "approve" }` answers as before, plus:

```jsonc
"release": { "created": true, "reason": null, "message": "Release 2 was created at Test.", "release": { /* ReleaseInfo */ } }
```

**Approving the same content again does not make a duplicate.** When the content is identical to the latest release (same digest) and that release was not withdrawn, the answer is `{ "created": false, "reason": "unchanged", "message": "Release 2 already holds this content, so no new release was made.", "release": ... }`, and the approval is added to that release's history (`reapproved`). If the latest release *was* withdrawn from a stage, approving its content again creates a new release: that is a deliberate decision to release it again.

The approval and its release are stored together or not at all. Other workflow actions are unchanged and have no `release` field.

### One release

`GET /api/v1/releases/:releaseId`

```jsonc
{
  "release": { /* ReleaseInfo */ },
  "history": [   // stage history, oldest first
    { "id": 1, "kind": "created", "stage": "test", "note": "Created when version 1 was approved.", "by": { "id": "…", "name": "…" }, "at": "…" }
  ],
  "handover": [  // handover log, oldest first
    { "id": 1, "kind": "received", "stage": "test", "note": "Loaded", "packageSha256": "35e1d8ba…", "by": { "id": "…", "name": "…" }, "at": "…" }
  ],
  "actions": [   // what this caller may do now, and why not
    { "action": "promote",  "stage": "production", "label": "Move to Production",       "allowed": true,  "reason": null },
    { "action": "withdraw", "stage": "test",       "label": "Withdraw from Test",       "allowed": false, "reason": "Only admins can withdraw a release." },
    { "action": "withdraw", "stage": "production", "label": "Withdraw from Production", "allowed": false, "reason": "Release 1 has never been in Production." },
    { "action": "handover", "kind": "received",    "label": "Mark as received",         "allowed": true,  "reason": null },
    { "action": "handover", "kind": "live",        "label": "Mark as live",             "allowed": true,  "reason": null }
  ],
  "document": { "id": "harborcare-demo", "exists": true, "title": "…", "modelVersion": 3, "workflowState": "draft" }   // title, modelVersion, workflowState are null when it was deleted
}
```

History `kind` is one of `created`, `reapproved`, `promoted`, `superseded`, `withdrawn`, `document-removed`. `stage` is null for events about the release as a whole. `note` holds the reason or note a person gave, or what the studio recorded.

`GET /api/v1/releases/:releaseId/template` returns the frozen template as JSON (the same content as `template.json` in the package), with `Content-Disposition: attachment; filename="<release id>-template.json"`. It can be imported as a project file through `POST /api/v1/projects/import`.

### Move to Production

`POST /api/v1/releases/:releaseId/promote` (admins) — body `{ "note"?: string }` (at most 500 characters)

```jsonc
{ "release": { /* ReleaseInfo, now current in Production */ }, "superseded": [ /* ReleaseInfo of the release it replaced, if any */ ] }
```

- A release that is superseded at either stage can be promoted: that is how an earlier release is put back.
- `409 INVALID_STAGE_MOVE` (with `stages`) when it is already the Production release, or was withdrawn from Test or from Production (a withdrawn release needs a new release).
- `400 NOTE_TOO_LONG`.

### Withdraw

`POST /api/v1/releases/:releaseId/withdraw` (admins) — body `{ "stage": "test" | "production", "reason": string }`

```jsonc
{ "release": { /* ReleaseInfo; stages[stage] is { "status": "withdrawn", "reason": "…", "since", "by" } */ } }
```

- `400 REASON_REQUIRED`, `400 INVALID_STAGE`, `400 NOTE_TOO_LONG`.
- `409 INVALID_STAGE_MOVE` when it was never at that stage, is already withdrawn from it, or (for Test) is the Production release: withdraw it from Production first.
- Nothing takes a withdrawn release's place by itself. After withdrawing the Production release, Production is empty until an admin promotes a release.

### Handover log

`POST /api/v1/releases/:releaseId/handover` (approvers and admins) — body `{ "kind": "received" | "live", "note"?: string, "stage"?: "test" | "production" }`

`201` `{ "entry": HandoverEntry, "handover": [ /* the whole log, oldest first */ ], "release": ReleaseInfo }`

An entry records who and when, the optional note, the environment when given, and `packageSha256`: the SHA-256 of the package the studio held at that moment (null if it had not been built). The log is a record only: it does not move the release, and any release can be logged against, including a superseded or withdrawn one. The studio makes no outbound connection.

Errors: `400 INVALID_KIND`, `400 INVALID_STAGE`, `400 NOTE_TOO_LONG`.

### The package

Building composes PDFs in a headless browser (about 0.3 s each), so it never happens inside the approval. It runs in the background, one package at a time, and gives other requests their turn between steps.

**Once a package is built it is never replaced.** It may already have been handed over. Building it again only *checks* it.

| Route | What it does |
|---|---|
| `GET /api/v1/releases/:releaseId/package/status` | `{ "package": ReleasePackageStatus }` |
| `POST /api/v1/releases/:releaseId/package` | Prepare. Body `{ "wait"?: true, "verify"?: true }`. Answers `{ "package": ReleasePackageStatus, "started": boolean }` with `202` while work is going on, `200` otherwise (the status says `ready` or `failed`). `wait` holds the answer until the work ends. A failed build is tried again by this route. |
| `GET /api/v1/releases/:releaseId/package` | Download. `200` ZIP when ready. When not built: starts the build and answers `202` `{ package, started }` with `Retry-After: 2`; with `?wait=1` it waits and sends the ZIP. `409 PACKAGE_FAILED` (with `package`) after a failed build: prepare it again. |
| `GET /api/v1/releases/:releaseId/package/files` | `{ "package": ReleasePackageStatus, "files": [{ "path", "sha256", "bytes", "role", "contentType" }] }` — `manifest.json` first, then the manifest's own list. `409 PACKAGE_NOT_READY` (with `package`) unless ready. |
| `GET /api/v1/releases/:releaseId/package/files/<path>` | One file, for a preview, without downloading the ZIP. `?download=1` for an attachment. `404` for a path the package does not have, `409 PACKAGE_NOT_READY` unless ready. |

Download headers: `Content-Type: application/zip`, `Content-Disposition: attachment; filename="<document id>-r<number>.zip"`, `X-Sha256: <SHA-256 of the ZIP>`, `X-Content-Type-Options: nosniff`.

Single-file headers: the content type for its extension, `X-Sha256`, `Content-Disposition: inline; filename="…"`, `X-Content-Type-Options: nosniff`; HTML and SVG also get `Content-Security-Policy: sandbox allow-scripts`, so a reference page shown in a frame can run its own scripts but cannot reach the studio.

`verify: true` on a ready package builds it again and compares the result with the kept ZIP. The kept ZIP stays whatever happens. The outcome is `package.verified`: `{ "at", "same": true|false, "sha256": <of the new build, or null>, "error": <why it could not be built, or null> }`. While the check runs the status stays `ready` with `progress` set.

A build fails with a plain reason when composition fails, or when the studio's engine, a renderer or the package format has changed since the release was made: the package states the versions that produced it, so it is not built with others.

### Reset (tests and demos only)

`POST /api/v1/releases/reset` with `{ "confirm": true }` removes every release. It answers `403 RESET_DISABLED` unless the server was started with `RELEASES_RESET=allow`, and needs an admin. It exists so browser tests can start clean; in normal use nothing deletes a release.

## Audit entries

Every state change writes one, with names and numbers and never content. `detail` always has `releaseId`, `number` and `title`.

| Action | When | Also in `detail` |
|---|---|---|
| `release.create` | a release was created | `stage: "Test"`, `origin`, `approvedBy` (name), `supersededAtTest` (numbers) |
| `release.promote` | moved to Production | `stage: "Production"`, `superseded` (numbers), `withNote` |
| `release.withdraw` | withdrawn | `stage` ("Test" or "Production"), `withReason: true` |
| `release.handover` | handover entry added | `kind` ("Received" or "Live"), `stage` (label or null), `withNote` |
| `release.package` | package work started or ended | `event`: `started`, `ready` (`sha256`, `bytes`, `files`), `failed` (`reason`), `check-started`, `checked` (`same`, `sha256`, `keptSha256`, `reason?`) |

Reasons and notes a person typed are kept on the release (history and handover log), not in the audit log. `workflow.approve` also says which release it made: `detail.release = { number, created }`. `project.delete` says `releasesKept`.

## Changes to existing routes

- `POST /api/v1/projects/:projectId/workflow` (`approve`): adds `release` to the answer (above).
- `DELETE /api/v1/projects/:projectId`: adds `releasesKept` to the answer.
- New documents (create, import, duplicate, set up) never get the id of a deleted document that has releases.
- `GET /api/v1/session`: admins have the extra permission `promote_release`.

## How releases relate to "Publish"

The review workflow still has its `publish` step (approved → published). It is a state of the document only: it creates nothing, moves no release and is not required for anything here. Releases answer the questions "publish" was a placeholder for (what was handed over, what is live). They are deliberately **not linked**: that is a product decision (see the report of this phase).

## Limits

- No screen yet. Nothing here has been exercised from a browser.
- A package can only be built by a studio whose engine, renderers and package format match the release. After an upgrade, a release whose package was never built cannot get one from that studio (the kept package of an already-built release stays available).
- One package is built at a time, in the API process. The longest stretch that holds up other requests is one PDF composition or the planning of the test scenarios (about 0.05–0.25 s for the two samples; a much larger document will take longer).
- The handover log has no notion of a target CCM yet (none is named); `stage` is optional free choice between the two stages.

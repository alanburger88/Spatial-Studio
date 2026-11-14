# Blocker owner, status and notes API

Blockers phase 4 (decision 6 in `docs/design/BLOCKERS.md`; wave 4 item 2 in `docs/design/WAVE4_TEAMS.md`). Each root cause
of a document can have an **owner** (a studio user), a **status** and **notes**. They are kept by the server per document and
per **blocker id** (`blockerIdOf` in `@iss/scenarios`, the same id as the Blockers screen's `?blocker=`), so they stay with the
cause across saves for as long as it exists.

Server: `apps/api/src/blockerWork.ts` (storage and the "fixed" rule) and `apps/api/src/routes/work.ts` (routes). Tests:
`apps/api/test/blocker-work.test.ts`; browser: `e2e/blockers-owners.spec.ts`.

## Statuses

| Status | Who sets it | When |
|---|---|---|
| Open | a person (or the default) | |
| Being fixed | a person | someone is working on it |
| Fixed | **the studio only** | the saved document no longer has the cause for any customer |
| Known data problem | phase 2 | every customer it stops is set aside by an approver (`docs/api/KNOWN_DATA_PROBLEMS.md`) |

A request that sets `fixed` or `known-data-problem` is refused with `422 STATUS_SET_BY_STUDIO`.

## Where "fixed" is decided

On the server, against the **saved** document and every customer the studio holds for it, on every day the approval check
uses (the same ground approval stands on). The server works out, without composing pages, every cause the resolver finds for
each customer, every broken "must" wording rule and the static rule and data-link checks (`savedCauses`). A cause someone works
on that is no longer among them is marked fixed, once, with the version it was found fixed in; its owner is notified (unless the
owner made the change). A fixed cause that comes back is open again.

This is checked after **every successful change to a document** (a hook on the document's routes: save, restore, rename,
customers added, edited or removed, known data problems), before the answer is sent, and again on every read of the work and of
"My work". So it never depends on someone having the Blockers screen open, and a change made outside a document (imported
customers removed) is noticed on the next read.

Causes only the **full check** can see (page layout, PDF/web differences, PDF accessibility) need composed pages, which the
server does not make on its own. They are judged by a full check of the saved version: the Blockers screen reports the causes a
full check of exactly the saved version found (`POST …/blocker-work/full-check`), and causes judged this way that it no longer
finds are fixed. A full check of any other version is refused (`409 NOT_THE_SAVED_VERSION`).

A fixed cause stays listed (status `fixed`) until the document's **next approval**, then drops off with its notes. The approval
time is read from the review history, so nothing has to happen at the moment of approval.

## Who may do what

| | Read | Owner, status, notes, full-check report |
|---|---|---|
| Admin, approver, reviewer, author (anyone with `comment`) | yes | yes |
| Not signed in (sign-in on) | `401` | `401` |

With sign-in off the only person is the local admin, who is also the only possible owner.

## Routes

All under `/api/v1/projects/:projectId/blocker-work`. Every answer is the whole list (below) and, for a write, `item` (the cause
written).

### `GET /api/v1/projects/:projectId/blocker-work`

```jsonc
{
  "projectId": "aster-card-demo", "modelVersion": 7, "authEnabled": true,
  "lastApprovalAt": null,                  // the approval that ends the "Fixed" listing of earlier fixes
  "items": [{
    "blockerId": "required-translation-missing~billing-summary~es-US",
    "kind": "wording", "title": "No approved Spanish text for “New balance”",
    "speed": "fast",                       // fast: judged on the saved document; full-check: judged by a full check
    "owner": { "id": "u-1a2b3c4d", "name": "Dana Author" },
    "status": "being-fixed",               // open | being-fixed | fixed | known-data-problem
    "statusBy": { "id": "u-9f8e7d6c", "name": "Sam Approver" }, "statusAt": "2026-11-14T09:12:00.000Z",
    "fixedAt": null, "fixedInVersion": null,
    "customerCount": 6,                    // customers of the saved document it stops (0 once fixed)
    "notes": [{ "id": "3", "body": "The Spanish text is with the translators.", "author": { "id": "u-9f8e7d6c", "name": "Sam Approver" }, "at": "2026-11-14T09:13:00.000Z" }],
    "updatedAt": "2026-11-14T09:13:00.000Z"
  }],
  "people": [{ "id": "u-1a2b3c4d", "name": "Dana Author", "role": "author" }]   // who can be made owner
}
```

### `PUT /api/v1/projects/:projectId/blocker-work/:blockerId`

Body: `{ "ownerId": "u-1a2b3c4d" | null }`, `{ "status": "open" | "being-fixed" }`, or both. The blocker id is URL-encoded.

| Refusal | Status | Code |
|---|---|---|
| neither field given | 400 | `INVALID_REQUEST` |
| `fixed` or `known-data-problem` | 422 | `STATUS_SET_BY_STUDIO` |
| any other status | 400 | `INVALID_STATUS` |
| an owner who is not an enabled studio user (with sign-in off: anyone but `local-admin`) | 400 | `UNKNOWN_PERSON` |
| not a blocker id the studio makes | 400 | `UNKNOWN_BLOCKER` |
| a cause the saved document does not have (save first) | 409 | `NOT_IN_SAVED_DOCUMENT` |
| a status for a fixed cause | 409 | `ALREADY_FIXED` |

A cause from the full check (layout and pages) is accepted although the server cannot see it; it is judged by full-check reports.
A new owner is notified (`blocker.assigned`), never the person who assigned.

### `POST /api/v1/projects/:projectId/blocker-work/:blockerId/notes`

Body: `{ "body": "plain text" }`, cleaned like comments (control and direction characters removed), 1 to 1,000 characters
(`400 EMPTY_NOTE`, `400 NOTE_TOO_LONG`). Answers `201` with `note`. The owner is notified (`blocker.note`) unless they wrote it.

### `POST /api/v1/projects/:projectId/blocker-work/full-check`

Body: `{ "modelVersion": 7, "contentDigest": "<projectContentDigest of the saved version>", "blockerIds": ["flow-overflow-no-continuation~transaction-table"] }`.
Answers with the list and `fixed` / `reopened` (blocker ids).

### `GET /api/v1/assignable-people`

`{ "people": [{ "id", "name", "role" }], "authEnabled" }`: every enabled studio user (names and roles, no email); with sign-in off,
the local admin alone. Anyone signed in may read it (the user list itself stays for admins).

## Notes stay in the studio

Notes are kept in their own table. They are never part of the document (nor its export), a release, a release package or the
Activity log (which records only who added a note to which blocker, and its length). `blocker-work.test.ts` approves a document
with notes and scans the release and every file of its package for them.

## Activity

`blocker.assign`, `blocker.status`, `blocker.note` (with the blocker's id and title, never the note), `blocker.fixed` and
`blocker.reopen` (written by the studio, with who made the change being judged when known).

Deleting a document removes its owners, statuses and notes.

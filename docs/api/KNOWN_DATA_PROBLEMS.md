# Known data problems API

A **known data problem** is the one exception the Blockers design allows (decision 7 in `docs/design/BLOCKERS.md`): an approver sets aside **one** blocker of the kind "the customer's data is wrong" (`customer-data`) for **one** customer, with a reason. It never applies to a blocker in the document itself (wording, rules, layout and pages, data fields): those must always be fixed.

While it is in force, that blocker does not stop that customer: the customer is not counted as stopped by an open blocker, the problem does not block approval, it is listed on the approval screen with its reason, and every release made while it is in force records it (and its package manifest lists it, without customer data).

The rules are pure and shared by the server and the screens (`@iss/scenarios`, `assist/blockers.ts`): `customerBlockers`, `knownDataProblemRefusal`, `splitKnownDataProblems`, `withKnownDataProblems`, `KNOWN_REASON_MAX`. The server is `apps/api/src/routes/knownData.ts`.

## It lapses by itself

An entry is checked against the **saved** document and the customer as the studio holds them now. It **lapses** when that blocker no longer stops that customer: the customer's data was corrected, the document changed so the problem no longer exists, or the customer was removed. A lapsed entry is not counted anywhere. The server removes lapsed entries on the next read or write of the list (and when the approval check runs), writes a `known-data.lapse` audit entry for each, and says so in plain words in the answer (`note`). Restoring a sample project to its approved state removes its entries.

The Blockers screen applies the same rule to the open, possibly unsaved model: an entry whose problem the unsaved model no longer has is simply not counted until the change is saved (then the server removes it).

## Who may do what

| | Read | Set aside | Remove |
|---|---|---|---|
| Admin, approver | yes | yes | yes |
| Author, reviewer | yes | no (`403 FORBIDDEN`, `needs: "approve"`) | no |

With sign-in off, the local admin may do everything.

## Shapes

```jsonc
// KnownDataProblem, as the routes return it
{
  "id": "7",                                                     // the studio's id of the entry
  "blockerId": "inconsistent-payment-state~payment-guidance",    // the stable id of the blocker (the Blockers screen's ?blocker=)
  "recordId": "CARD-60012",                                      // the customer
  "reason": "The source system corrects this account in the December cycle.",
  "markedBy": { "id": "u-1a2b3c4d", "name": "Ada Approver" },
  "markedAt": "2026-11-13T14:51:40.002Z",
  "blocker": { "title": "The account is “up to date” but lists missed payments", "kind": "customer-data", "fields": ["card.paymentStatus", "card.missedPayments"] },
  "customer": { "name": "Jordan Mercer", "origin": "supplied" }  // origin: sample | generated | supplied | imported
}
```

`blocker.fields` are the customer's values the problem is about, as Data Explorer paths (`claims[0].billedCents` for a claim row).

Every answer also has `lapsed` (`[{ id, blockerId, recordId }]`, the entries this request removed because they lapsed) and `note` (a sentence saying so, or `null`).

## Routes

### List

`GET /api/v1/projects/:projectId/known-data-problems` → `{ projectId, modelVersion, knownDataProblems: KnownDataProblem[], lapsed, note }`. Oldest first. Lapsed entries are removed first.

### Set one aside

`POST /api/v1/projects/:projectId/known-data-problems` with `{ "blockerId", "recordId", "reason" }` → `201 { knownDataProblem, lapsed, note }`.

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | `blockerId` or `recordId` missing |
| 400 | `REASON_REQUIRED` | no reason (it is trimmed first) |
| 400 | `REASON_TOO_LONG` | more than 500 characters after trimming |
| 422 | `NOT_A_DATA_PROBLEM` | the blocker is not about a customer's own data (anything in the document itself), or the id is not one the studio makes |
| 404 | `UNKNOWN_CUSTOMER` | the document has no such customer (another project's customer, or another kind of document) |
| 409 | `NOT_STOPPING_THIS_CUSTOMER` | that blocker does not stop that customer in the saved document |
| 409 | `ALREADY_KNOWN` | it is already set aside for that customer |
| 403 | `FORBIDDEN` | the role may not approve |

The checks run in that order, against the saved document.

### Remove one

`DELETE /api/v1/projects/:projectId/known-data-problems/:id` → `{ removed: id, lapsed, note }`; `404 NOT_FOUND` when there is no such entry (already removed, or lapsed). The customer counts as stopped by that blocker again.

## Elsewhere

- **Approval check** (`GET /api/v1/projects/:projectId/workflow`, `readiness`): a blocking issue that is a known data problem in force for that customer is left out of `blocking` (the issue's `recordIds` no longer name that customer, and an issue left with no customers is dropped). `readiness.knownDataProblems` lists every entry in force (shape above) and `readiness.knownDataNote` says when some lapsed. Approving checks the same way.
- **Releases**: `ReleaseInfo.knownDataProblems` and the package manifest's `knownDataProblems` (see `docs/api/RELEASES.md` and `docs/design/RELEASE_PACKAGE.md`). No customer data enters a release: a built-in sample or engine-generated customer is named by id; any other customer is recorded only as one such customer, and their name and id are taken out of the reason.
- **Data Explorer** opens on a customer from a blocker with `?customer=<recordId>&blocker=<blockerId>&highlight=<path>,<path>`: the values are highlighted and scrolled into view, and a banner says what is wrong, links back to the blocker, and offers "Make an editable copy" (shared customers) and "Mark as a known data problem".

## Audit entries

| Action | When | `detail` |
|---|---|---|
| `known-data.add` | set aside | `id`, `blockerId`, `recordId`, `name` (the customer), `blocker` (title), `reasonLength` — never the reason itself |
| `known-data.remove` | removed by a person | `id`, `blockerId`, `recordId`, `name` |
| `known-data.lapse` | removed because it lapsed | `id`, `blockerId`, `recordId`, `name`, `why`: `no-longer-stops` or `customer-gone` |

Activity shows each in plain words under "Known data problems".

## Limits

- An entry is about the blocker's stable id, so it stays in force while the same cause stops that customer, even if the customer's values change in a way that keeps the problem (for example, a different number of missed payments). It lapses only when the problem no longer stops them.
- A release is not made again when only the known data problems change: a release is made for new content (`releaseCreationDecision`), so re-approving unchanged content keeps the release, and its record, as they were.

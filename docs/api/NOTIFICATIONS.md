# Notifications and "My work" API

Wave 4 item 3 (`docs/design/WAVE4_TEAMS.md`). Each studio user has a list of notifications stored on the server, shown by the
bell in the top bar, and a **My work** list of what waits for them across every document. Nothing leaves the studio: no email,
no push, no websocket. The browser asks for the unread count every 30 seconds while the studio's tab is visible.

Server: `apps/api/src/notifications.ts` (store, `notify`, words) and `apps/api/src/routes/work.ts` (routes and the calls that
create notifications). Tests: `apps/api/test/notifications.test.ts`, `apps/api/test/blocker-work.test.ts` (sign-in on);
browser: `e2e/notifications.spec.ts`.

## Creating one: `notify`

```ts
import { notify } from './notifications';
notify(store, { userId, kind, projectId, data, actor });
// userId: who is told; kind: one of NOTIFICATION_KINDS; projectId: the document (or null)
// data: ids and whole numbers only; actor: { id, name } of the person whose action it is, or null when the studio noticed it
```

- It **never notifies the actor** about their own action (`actor.id === userId` stores nothing and returns null).
- **Ids and counts only**, as in the Activity log: `data` keeps only the keys `blockerId`, `noteId`, `commentId`, `parentId`,
  `nodeId`, `modelVersion`, `count`, `linkId`, `releaseId`, `versionId`, and only values that are ids (letters, digits and
  `_ . ~ + : @ -`, no spaces) or whole numbers. Anything else is dropped, so no customer's name, an amount with words, a note or a
  comment can be stored. The words a person reads are made when the list is read, from the document and the blocker as they are
  then. `notifications.test.ts` scans every stored row for a customer's name and values.
- Callers pass ids, never names in `data`; the actor's studio name is kept (as the Activity log keeps who acted).

## Kinds: what creates one, and who is told

| Kind | When | Told | Opens |
|---|---|---|---|
| `blocker.assigned` | a blocker is given an owner | the new owner | Blockers, on that cause |
| `blocker.note` | a note is added to a blocker | its owner | Blockers, on that cause |
| `blocker.fixed` | the studio finds a blocker fixed (see `BLOCKER_WORK.md`) | its owner, unless the owner's own change fixed it | Blockers, the cause in "Fixed" |
| `review.submitted` | a document is submitted for review | every enabled user who may review or approve (reviewers, approvers, admins) | the Review panel |
| `review.changes_requested` | changes are requested | the person who submitted that version | the Review panel |
| `review.approved` | it is approved | the person who submitted that version | the Review panel |
| `comment.reply` | someone replies in a comment thread | the person who started the thread | the Review panel, with the component selected |
| `review_link.comment` | a comment arrives through a review link | the person who made the link | the Review panel |

`review_link.comment` has its kind, words and target here; the review-links module calls
`notify(store, { userId: link.createdBy, kind: 'review_link.comment', projectId, data: { linkId, commentId }, actor: null })`
when a comment arrives (connected by the integrator).

With sign-in off there is one person, the local admin, so every action is their own and notifies nobody. Two kinds still reach
them: a blocker the studio finds fixed through a change made outside the document (for example imported customers removed),
and a review-link comment.

## Routes

### `GET /api/v1/notifications?limit=50`

The signed-in person's notifications, newest first (at most 200), and the unread count. `limit=0` answers the count alone
(what the bell asks for every 30 seconds).

```jsonc
{
  "unread": 2,
  "notifications": [{
    "id": "41", "kind": "blocker.assigned", "projectId": "aster-card-demo", "documentTitle": "Aster Card – credit-card statement",
    "data": { "blockerId": "required-translation-missing~billing-summary~es-US" },
    "actorName": "Sam Approver", "at": "2026-11-14T09:12:00.000Z", "read": false,
    "text": "Sam Approver made you the owner of a blocker in “Aster Card – credit-card statement”: No approved Spanish text for “New balance”",
    "target": { "screen": "blockers", "projectId": "aster-card-demo", "blockerId": "required-translation-missing~billing-summary~es-US" }
  }]
}
```

`target.screen` is `blockers` (with `blockerId`), `review`, or `comment` (with `nodeId` and `commentId`).

### `POST /api/v1/notifications/:id/read`

Marks one of the person's own notifications read: `{ "read": "41", "unread": 1 }`. Someone else's or an unknown id: `404 NOT_FOUND`.

### `POST /api/v1/notifications/read-all`

`{ "marked": 3, "unread": 0 }`.

Reading and marking are not recorded in the Activity log.

### `GET /api/v1/my-work`

What waits for the signed-in person across every document:

```jsonc
{
  "user": { "id": "u-1a2b3c4d", "name": "Dana Author", "role": "author", "roleLabel": "Author" }, "authEnabled": true,
  "blockers": [{ "projectId": "aster-card-demo", "documentTitle": "…", "blockerId": "…", "title": "…", "kind": "wording",
                 "speed": "fast", "status": "being-fixed", "customerCount": 6, "updatedAt": "…" }],   // owned and not fixed
  "reviews": [{ "projectId": "harborcare-demo", "documentTitle": "…", "state": "in_review", "label": "In review", "modelVersion": 3,
                "submittedBy": "Dana Author", "submittedAt": "…", "canApprove": false, "mine": false }]  // when the role may review or approve
}
```

Unanswered review-link comments are not part of this answer yet: they belong to the review-links module and are added when it
is connected.

## Who may do what

Anyone signed in reads and marks their own notifications and reads their own "My work". Nobody can read another person's.
Deleting a document removes the notifications about it.

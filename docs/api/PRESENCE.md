# Who else is editing (presence) API

Wave 4, item 4 of `docs/design/WAVE4_TEAMS.md`. Each open studio window tells the server which document, screen and
component it is on, and is told about the other windows on the same document. Server: `apps/api/src/presence.ts` (the list)
and `apps/api/src/routes/presence.ts` (routes). Tests: `apps/api/test/presence.test.ts`; browser: `e2e/presence.spec.ts`.

## What is kept, and for how long

- **In memory only.** Nothing is written to the database or the Activity log (the test compares every table and the
  connection's change counter before and after). A restart forgets everyone; every window reports again within 15 seconds.
- **Forgotten after 45 seconds of silence.** Windows report every 15 seconds while their tab is visible.
- **One entry per window.** A window is identified by an id its browser tab makes for itself when the page loads (so two
  tabs of one person, even a duplicated tab, are told apart; a reload is a new window) together with the signed-in user. One
  person can never move or remove another person's window, even knowing its id. A window that opens another document
  replaces its entry.
- **Limits:** 2,000 windows in all and 50 per user (`429 TOO_MANY_WINDOWS` beyond).

## Routes

Both need a signed-in user when sign-in is on (`any` in the route table of `apps/api/src/auth.ts`); both are read-like for the
audit trail, so they are never audited. Neither works for the public review page.

### `POST /api/v1/projects/:projectId/presence`

Report this window and get the others on the same document.

```json
{ "windowId": "w-6f1c…", "screen": "S02", "componentId": "payment-guidance", "dirty": true }
```

- `windowId` (required): 8 to 64 letters, digits, `-` or `_` (`400 INVALID_WINDOW` otherwise).
- `screen`: a screen id (`S01`…`S26`); anything else is kept as `null`.
- `componentId`: the component selected in Design Studio. Only a component the saved document has is kept; anything else
  is `null`. The studio sends it only from Design Studio.
- `dirty`: the window has unsaved edits.
- An unknown document is `404`.

Answer:

```json
{
  "others": [
    { "key": "Zp3c9…", "userId": "u-1a2b", "name": "Dana Author", "sameUser": false, "screen": "S02",
      "componentId": "payment-guidance", "dirty": false, "seenSecondsAgo": 4 }
  ],
  "intervalMs": 15000,
  "ttlMs": 45000
}
```

- The window itself is never in `others`, and no other window's id is ever returned (`key` is an opaque, stable hash for
  lists).
- `sameUser`: the same signed-in user in another window. **With sign-in off every window is the local admin**, so every
  other window is `sameUser: true`; the studio shows it as "Another window".
- Order: other people first, then the same user's other windows, each by name.

### `POST /api/v1/presence/leave`

`{ "windowId": "w-6f1c…" }` → `{ "left": true }` (`false` when there was no such window of this user). Sent when a window
leaves a document, when its tab is hidden, and with `navigator.sendBeacon` when the tab closes or navigates away.

## How the studio uses it

- `apps/web/src/shell/presence.ts` reports at once when a document opens, every 15 seconds while the tab is visible, and
  1.2 seconds after the screen, the selected component or the saved state changes. A hidden tab leaves at once and stops
  reporting; it reports again as soon as it is visible.
- The top bar (`shell/PresenceBar.tsx`) shows the others' initials (at most three, then "+N") beside the document name, or a
  count on windows narrower than 1,360 px. Its accessible name and tooltip list each one and the screen they are on; it opens a
  short list. Nothing is shown when the window is alone.
- The Design Studio Inspector says "Dana is also on this component." (or "Another window is also on this component.") when
  another window has the same component selected there. It is a warning, never a lock.

## A save refused because a newer version was saved first

Not part of presence, but its other half. `PUT /api/v1/projects/:projectId` already refuses a save whose `If-Match` is not
the current version (`409 VERSION_CONFLICT`). The refusal now also says who saved the newer version and when, from the
version history (`project_versions.saved_by`, `saved_at`; a name and a time, never content):

```json
{ "error": { "code": "VERSION_CONFLICT", "message": "Project is at version 7; you edited version 6.", "currentVersion": 7,
  "savedBy": "Dana Author", "savedAt": "2026-11-14T10:42:05.120Z" } }
```

The studio shows a dialog: who saved which version and when, that nothing was overwritten, and the choices **Load their
version** (the unsaved edits are lost, and the dialog says so) or **Keep editing and compare**, which opens Before & after
with that saved version (`?before=v7&after=working`) beside the working version. The studio does not merge edits.

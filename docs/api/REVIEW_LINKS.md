# Review links API

Wave 4, item 1. Design: `docs/design/WAVE4_TEAMS.md` section 1. Code: `apps/api/src/reviewLinks.ts` (rules and
storage), `apps/api/src/routes/reviewLinks.ts` (routes), `apps/web/src/review/ReviewPage.tsx` (the public page),
`apps/web/src/screens/releases/ReviewLinks.tsx` (making and managing links in the studio). Tests:
`apps/api/test/review-links.test.ts`, `e2e/review-links.spec.ts`.

A review link points to **one frozen version of one document** (a release, or a saved version) for **chosen synthetic
customers**. Anyone with the link can look at the outputs and comment under a typed name. A link holder can view and
comment only: nothing they do changes the document or its review state, and no approval or sign-off is possible.

## Limits

| What | Limit |
|---|---|
| Customers in a link | 1 to 12; built-in sample customers and generated customers only |
| Expiry | 1 to 30 days, default 7. There is no "never". |
| Active links per document | 20 (expired and revoked links do not count) |
| Comments per link | 30 an hour, 200 in all |
| Output requests per link | 120 a minute (`/output` and `/pdf`), counted in memory |
| Typed name | 1 to 80 characters, one line, cleaned like a comment |
| Comment | 1 to 2,000 characters, plain text, cleaned with `sanitizeCommentBody` |
| Label | up to 80 characters (default "Review of release N" / "Review of version N") |

## Routes for signed-in users

With sign-in off everyone is the local admin and may do all of it.

| Route | Who | What |
|---|---|---|
| `GET /api/v1/projects/:projectId/review-links/options?releaseId=…` or `?version=N` | any signed-in user | What a new link to that release or saved version may hold: every test customer with `kind` (`sample`, `generated`, `imported`, `supplied`, `missing`), `allowed` and `reason`; the approved languages; the four outputs; the limits; how many links are active. |
| `POST /api/v1/projects/:projectId/review-links` | `comment` (author, reviewer, approver, admin) | Makes a link. Body: `{ releaseId? , version?, label?, customers: string[], languages?: string[], outputs?: ("pdf"\|"html"\|"email"\|"sms")[], expiresInDays?: number }`. Answer `201 { link, token, path }`. **The token is in this answer only**; it is not stored and is never shown again. |
| `GET /api/v1/projects/:projectId/review-links` | any signed-in user | `{ links, active, limits }`, newest first. No token. |
| `POST /api/v1/projects/:projectId/review-links/:linkId/revoke` | the link's creator, an approver or an admin (checked in the handler; others get 403) | Revokes at once. Revoking again answers `alreadyRevoked: true`. |

A link (`ReviewLinkDto` in `apps/web/src/api/client.ts`):
`{ id, label, target: { kind: "release"|"version", releaseId, releaseNumber, version }, customers: recordId[], languages, outputs, createdBy, createdAt, expiresAt, status: "active"|"expired"|"revoked", revokedAt, revokedBy, opens, firstOpenedAt, lastOpenedAt, comments, mayRevoke }`.

Refusals (status, code): `400 TARGET_REQUIRED`, `404 NOT_FOUND` (no such release or version of this document),
`409 DOCUMENT_REMOVED`, `400 INVALID_CUSTOMERS` (not 1 to 12 different ids), `400 UNKNOWN_CUSTOMER`,
`400 CUSTOMER_NOT_ALLOWED` (imported, supplied or edited), `400 INVALID_LANGUAGES` (not among the approved ones),
`400 INVALID_OUTPUTS`, `400 INVALID_EXPIRY`, `400 LABEL_TOO_LONG`, `409 TOO_MANY_LINKS`.

## The five public routes

The token in the address is their only key. They need no session, read no cookie or header, set no cookie, and are
listed as `public` in the route table in `apps/api/src/auth.ts`. A token is accepted by no other route (the test reads
every route from the source and tries the token as a session cookie, a bearer header, another header and a query
parameter: each answers 401 with sign-in on).

Every reply, the dead-link answer included, carries `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
`X-Robots-Tag: noindex`. The review page itself (`/review/:token`) is sent with the same headers by the web server
(`apps/web/vite.config.ts`) and adds `referrer` and `robots` meta tags.

**One answer for every dead link.** An unknown, malformed, expired or revoked token, or a link whose document was
deleted, answers `404 { error: { code: "REVIEW_LINK_NOT_AVAILABLE", message: "This review link is not available. Ask the person who sent it for a new one." } }`.

| Route | Answer |
|---|---|
| `GET /api/v1/review/:token` | The summary: `{ banner, label, document: { title, kind }, version: { kind, releaseNumber, version }, newerExists, withdrawn, expiresAt, customers: [{ key, name, language }], languages: [{ code, name }], outputs: [{ id, label }], parts: [{ key, name }], limits }`. The first call counts as the link's first opening. |
| `GET /api/v1/review/:token/output?customer=&output=&language=` | One output for one customer: `{ customer, output, language, html? , email?: { subject, preheader, html, text }, sms?: { text }, pdf?: { query }, stopped?: { reasons } }`. `stopped` means the studio would not send this customer the document (the reasons are in plain words). Without `language`, the customer's own language when the link has it. |
| `GET /api/v1/review/:token/comments` | `{ comments: [{ id, author, body, createdAt, resolved, customer: { key, name }, output, language, part, replies: [{ id, author, body, createdAt, fromStudio }] }] }`: the comments made through **this** link and the studio's replies to them. Nothing else. |
| `POST /api/v1/review/:token/comments` | Body `{ name, body, customer, output, language?, part? }` (`part` is a key from the summary; leave it out for the whole document). `201 { comment }`. Refusals: `NAME_REQUIRED`, `NAME_TOO_LONG`, `EMPTY_COMMENT`, `COMMENT_TOO_LONG`, `UNKNOWN_PART`, `429 COMMENT_RATE`, `429 COMMENT_LIMIT`. |
| `GET /api/v1/review/:token/pdf?customer=&language=` | The PDF file (`application/pdf`, shown inline). `409 DOCUMENT_STOPPED` when the document is not produced for this customer. |

Other refusals of the public routes: `404 CUSTOMER_NOT_AVAILABLE` (not in the link, or no longer allowed),
`400 OUTPUT_NOT_AVAILABLE`, `400 LANGUAGE_NOT_AVAILABLE`, `429 TOO_MANY_REQUESTS`.

## How the rules are applied

- **Frozen target.** A release link reads the release's frozen project (`store.releaseProject`); a version link reads
  `project_versions`. Both go through `releaseTemplate`, which removes every unapproved draft. Outputs are produced
  with `produceOne` (the same function proof records use), so they are what would really be sent.
- **Synthetic customers only.** `customerChoices` decides each customer's kind with `pinnedCustomerRefs`, the same
  function a release package uses. It is applied when the link is made and again on every request: a customer that
  later becomes `supplied` (a person edited it) or is removed drops out of the link.
- **Languages.** English plus every language of the frozen document with at least one approved translation. The
  chosen language is applied by setting the customer's preferred language for that request; drafts are never shown.
- **Comment parts.** The reviewer picks a part from a list of the document's top-level parts; the keys are opaque
  (`p1`, `p2`, …) and the page shows no component ids.

## What is stored

- `review_links`: the link's id, document, label, target (release id or version), the chosen customer ids, languages
  and outputs, who made it and when, expiry, revoked when and by whom, open count and first and last opening.
  **The token is not stored, only its SHA-256** (`token_hash`).
- Comments go into the ordinary `comments` table on the link's version (`model_version`), with
  `author = "review-link:<linkId>"` and `author_name = "<typed name> (review link: <label>)"`; they are never shown as a
  user. `review_link_comments` records which link, customer id, output and language each came through.
- The Activity log records `review-link.create` (by whom, target, version, number of customers, languages and outputs,
  expiry), `review-link.revoke`, `review-link.open` (first opening only) and `review-link.comment` (link id, comment id,
  customer id, output, language, part, length). Never the token, the label, the typed name, the text or a customer's
  name. Entries from a link holder have no user (`userName` is "Review link").
- **No IP address or browser detail is stored anywhere.** The output limit is counted in memory per link.

## Hooks for later work

`onReviewLinkComment(link, comment)` in `apps/api/src/reviewLinks.ts` is called once a comment received through a link
is stored. It does nothing yet; the notifications work connects there.

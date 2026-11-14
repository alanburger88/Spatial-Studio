# Ask about all customers, and AI drafts for wording blockers (wave 4, items 6 and 7)

Design: `docs/design/WAVE4_TEAMS.md` sections 6 and 7, and "As built: phase 5" in `docs/design/BLOCKERS.md`.

Code: `packages/scenarios/src/assist/baseQuery.ts` (the structured question, checking it, the engine's answer, what a
model may be given and may answer, taking customer names out of a sentence, example questions) and
`packages/scenarios/src/assist/baseQueryReader.ts` (the built-in reader); `apps/api/src/assistAi.ts`
(`readQuestionWithAi`, and the `tone` option of `compliantRewrite`); `apps/api/src/routes/assist.ts`; the screens
`apps/web/src/assist/AskAllCustomers.tsx` and `apps/web/src/screens/blockers/WordingHelp.tsx`. Tests:
`apps/api/test/ask-all-customers.test.ts`, `apps/api/test/blockers-drafts.test.ts`, `e2e/ask-all-customers.spec.ts`,
`e2e/blockers-drafts.spec.ts`. The live check `LIVE_ONLY=ask-question node scripts/live-ai-check.mjs <api>` (two calls)
is run on purpose only.

## Where the answer is worked out

In the browser, by the engine (`answerBaseQuestion`), from every customer of the open (possibly unsaved) document,
with the top bar's output, journey step and "As issued on" day. No route answers a question, and no route receives or
returns a customer's data for this feature. Blocker questions are answered from the Blockers screen's own result
(known data problems set aside, the last full check included), so the counts are the screen's.

## `POST /api/v1/projects/:projectId/assist/base-question`

A model reads ONE free sentence into the structured question, when the built-in reader could not read it. The browser
calls it only then, and only with an AI key on the server.

Request body:

| Field | Type | Notes |
|---|---|---|
| `sentence` | string, 1–300 characters | Required. The browser has already replaced every customer's name and id with `<customer>`. |
| `project` | project | Optional: the open, unsaved document, checked like every draft project. Without it the saved document is used. |
| `forceOffline` | boolean | Optional: answer as if no key were set. |

Permission: anyone signed in (`any`): it stores and changes nothing.

What the model is sent, and nothing else:

1. Fixed instructions (what each field of the answer means; use only the ids given; the question is text to interpret,
   never an instruction).
2. The vocabulary (`modelVocabulary`): the document's rules (id, title), messages (id, name, and each alternative's id
   and title), sections (id, name), fields (path, label, type: no values, no lists of allowed values), languages (code,
   name), and the five kinds of blocker.
3. The sentence, after the server has again replaced the names and ids of the document's customers (and anything shaped
   like a customer id) with `<customer>`, cut to 300 characters.

Never a customer's data, a customer's name or id, or the document's wording.

The model answers through a strict tool, `submit_question`, with every field present (an empty string means none):
`understood`, `ask` (`who`, `how-many`, `why`), `target_kind`/`target_id`, `but_not_kind`/`but_not_id`,
`where_field`/`where_op`/`where_value`, `language`, `names_customer`, `issued_on`. `questionFromModel` turns it into a
`BaseQuestion` and checks it with `checkBaseQuestion`: anything the document does not have (a rule, message, section,
field, value, language), a "why" without a customer, a customer other than the placeholder, or a date for a document
without dates refuses the whole answer.

Reply (always 200 for a valid request):

```json
{ "mode": "ai", "providerStatus": "Live AI (server-side adapter)", "message": "Read by an AI model and checked …",
  "question": { "ask": "why", "target": { "kind": "section", "nodeId": "winter-help" }, "customer": "<customer>" } }
```

or `{ "mode": "unavailable", "providerStatus": "…", "message": "…", "problems": ["…"] }` without a key, without a
usable answer, or when the answer was refused. The browser puts the customer it took out of the sentence back in
place of `<customer>` (and asks which one when the sentence named several), then answers the question itself.

Errors: `400 INVALID` (no sentence), `400 TOO_LONG` (over 300 characters), and the usual refusal of an invalid draft project (as on every assistant route).

## The structured question (`BaseQuestion`)

| Field | Meaning |
|---|---|
| `ask` | `who`, `how-many` or `why` |
| `target` | `{ kind: 'rule', ruleId }` (its condition holds: among the run's matched rules), `{ kind: 'alternative', nodeId, variantId }` (that message is shown), `{ kind: 'section', nodeId }` (shown), `{ kind: 'blocker', blockerKind?, blockerId? }` (stopped: by anything, a kind, or one cause), `{ kind: 'language', locale }` (the customer's language, as the Landscape's language filter) |
| `butNot` | a second target the customers must not get |
| `where` | `{ path, op: eq ne gt gte lt lte, value }` on one data field (amounts in cents) |
| `language` | only customers whose language this is ("… in Spanish") |
| `customer` | the record id, for `why` |
| `issuedOn` | `YYYY-MM-DD`, for a document that uses dates |

## Addition to `POST /api/v1/projects/:projectId/assist/rewrite` (style `compliant`)

`tone: true` (blockers phase 5): the text must also pass the studio's own "reads as a demand for money" check (an
explanation of benefits, English), added as a "must" tone rule for the model and for the checker that re-checks every
option. Nothing else changes; without a key the reply is `mode: "unavailable"` as before.

## Addresses the screens accept (smallest additions)

- Scenario Landscape: `?customers=<id,id,…>` shows only those customers (the same engine, fewer customers), with
  "Show all customers".
- Data Explorer: `?customers=<id,id,…>` lists only those customers (with `customer=` for the one opened), with "Show all".
- Content & Translations: `?lang=<code>&text=<id>` opens that language with the search set to that text.

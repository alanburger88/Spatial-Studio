# Wave 4: teams

Status: **design for roadmap wave 4 (`docs/ROADMAP.md`). Not built yet.** Written on 2026-11-14 after the check-in
(decision D111).

Wave 4 is about more than one person working on a document: someone outside the studio reviewing it, people owning
problems, people being told when something needs them, and two people not overwriting each other.

## Check-in decisions (D111)

| Question | Decision |
|---|---|
| What may a person with a link do? | **View and comment.** Every link expires and can be revoked. Approval stays inside the studio, by a signed-in approver. No sign-off by link. |
| How are people told that something needs them? | **Inside the studio only.** A bell with unread items and a "My work" list. No email: nothing leaves the studio, so no outside service is needed. Email can be added later behind a setting. |

**A naming choice.** The roadmap called these "proof links". The studio already has a **Proof** tab (what a customer
was given, from which release, and why). To keep the two apart, the screens call the new thing a **review link**.

## Items and order

| # | Item | Built with |
|---|---|---|
| 1 | Review links for reviewers without an account | first pair |
| 2 | Blockers phase 4: owner, status and notes | first pair |
| 3 | Notifications and "My work" (in the studio) | with item 2 |
| 4 | See who else is editing | second pair |
| 5 | Blockers phase 6: warn before saving | with item 4 |
| 6 | Blockers phase 5: AI drafts for wording blockers | second pair |
| 7 | Ask questions of all customers | with item 6 |

Each item ends with tests, documentation and a demo path, and is verified before the wave is called done.

---

## 1. Review links (security design)

### What it is

An author, reviewer, approver or admin makes a link to **one frozen version of one document**, for **chosen synthetic
customers**. Anyone who has the link can open a review page, look at the outputs (PDF, web page, email, text message)
for those customers, and leave comments under a name they type. They need no account.

### What it is deliberately not

- Not an approval and not a sign-off. Nothing a link holder does changes the document or its review state.
- Not a way into the studio. A link holder cannot see rules, data fields, other customers, other versions, other
  documents, the library, releases, activity or users.
- Not a way to publish. A link is served by the same local studio as everything else; it reaches only people who can
  already reach that address. Nothing is deployed or sent anywhere.

### The rules

1. **Frozen target.** A link points to a release, or to a saved version of the document. It never follows the working
   version: the reviewer sees exactly what the creator chose, even if the document changes afterwards. The page says
   which version it is and whether a newer one exists ("a newer version exists; ask for a new link"), without showing it.
2. **Synthetic customers only.** The creator picks 1 to 12 customers. Only built-in sample customers and generated
   customers can be picked. Imported or supplied customers can never be in a link, the same rule a release package
   follows. The server enforces this when the link is made and again on every request.
3. **Languages and outputs.** The creator chooses which languages and which outputs the reviewer may see (default: all
   approved languages, all four outputs). Draft translations are never shown through a link.
4. **The token.** 32 random bytes from the system's secure generator, written in URL-safe base64. The studio stores
   only its SHA-256 hash, so the link cannot be read back out of the database: it is shown once, when made. A lost link
   is replaced by a new one.
5. **Expiry.** Every link expires. Default 7 days; the creator may choose 1 to 30. There is no "never".
6. **Revoking.** The creator, an approver or an admin can revoke a link at once. Deleting the document revokes its
   links. Withdrawing a release does not revoke links to it, but the review page then says the release was withdrawn.
7. **One answer for every dead link.** An unknown, expired or revoked token gets the same reply ("This review link is
   not available. Ask the person who sent it for a new one."), so the reply does not tell a guesser which tokens once
   existed.
8. **A narrow set of routes.** The token is accepted only by five public routes, all under
   `/api/v1/review/:token/`: the summary, one output for one customer, the comments made through this link, add a
   comment, and the PDF file. A token is never accepted anywhere else, sets no cookie and starts no session. Every other
   route keeps its existing rule (a signed-in user when sign-in is on).
9. **Comments.**
   - A reviewer types a name (required, up to 80 characters) and a comment (up to 2,000 characters). Plain text only;
     it goes through the same cleaning as studio comments.
   - A comment is about the whole document for one customer and output, or about one named part of it (the reviewer
     picks the part from a list: the page shows no component ids).
   - Comments made through a link are stored as review comments on that version, marked as coming from the link
     (its label and the typed name). Inside the studio they appear in the Review panel under "From review links", and
     can be answered and resolved there like any comment.
   - A link holder sees only the comments made through the same link, and the studio's replies to them. Internal
     comments are never shown.
   - A typed name is not an identity. The studio always shows it as "Name (review link: label)", never as a user.
10. **Limits.** At most 30 comments an hour and 200 in all per link; at most 20 active links per document. Requests
    for outputs are limited per link (120 a minute) so a link cannot be used to load the machine.
11. **Record keeping.** The Activity log records: link made (by whom, for which version, how many customers, expiry),
    link revoked, link first opened, and each comment received. The link list shows how many times a link was opened
    and when last. **No IP address or browser detail is stored.**
12. **Page hardening.** The review page and its API replies are sent with `Cache-Control: no-store`,
    `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`. The document's web page output runs inside a sandboxed
    frame without access to the review page, as in the studio's own preview. The review page loads only the studio's
    own scripts.
13. **Every output says what it is.** The review page has a fixed banner: "Review copy: synthetic data. Not for
    distribution." The outputs themselves are unchanged, so the reviewer sees what would really be sent.

### Threats considered

| Threat | What limits it |
|---|---|
| Someone guesses a link | 256 random bits; every dead or wrong token gets the same reply; request limits |
| A link is forwarded to the wrong person | It shows synthetic customers only, one frozen version, and expires; the creator can revoke it; the list shows opens |
| The database is copied | Only token hashes are stored; a hash cannot be turned back into a link |
| A link holder tries other routes | The token is accepted by five routes only and is never a session |
| A link holder posts harmful content | Plain text only, cleaned, length and rate limits; shown in the studio as text |
| A link holder pretends to be a colleague | Typed names are always shown with "(review link: label)" and never as a user; a comment cannot approve anything |
| Real customer data leaks through a link | Imported and supplied customers cannot be chosen; the rule is checked at creation and on every request |
| A link outlives its purpose | Mandatory expiry, at most 30 days |
| The link stays in a browser history or a chat | Accepted: that is how links work. Expiry and revoking are the answer, and the page says so to the creator |

### Where it is made and managed

- **Releases** and **Before & after**: a "Share for review" button makes a link to that release or saved version.
- **Overview** shows "2 review links active" with a link to the list.
- A **Review links** panel (on Releases) lists every link of the document: label, version, customers, expiry, opens,
  comments, who made it, and Revoke. The token itself is never shown again.

### Roles

| Action | Who |
|---|---|
| Make a link | author, reviewer, approver, admin (anyone with `comment`) |
| Revoke a link | its creator, an approver or an admin |
| See the link list | any signed-in user who can open the document |
| Answer or resolve a link comment | anyone with `comment` |

With sign-in off there is one local admin, who can do all of it. Review links still work, for anyone who can reach the
studio's address.

### Tests the builder must write

Unknown, expired and revoked tokens give the same reply and status. A token is refused on every non-review route. An
imported or supplied customer cannot be put in a link, and a link whose customer later becomes "supplied" stops
showing that customer. A link to version N keeps showing version N after the document changes. Draft translations are
not shown. Comment limits. The stored row holds no token. No IP or user agent is stored. The reply headers. A link
holder sees only this link's comments.

---

## 2. Blockers phase 4: owner, status and notes

Follows decision 6 of `docs/design/BLOCKERS.md`.

- Each root cause can have an **owner** (a studio user), a **status** and **notes**.
- **Statuses:** Open, Being fixed, Fixed, Known data problem. A person can set only Open and Being fixed. **Fixed** is
  set by the studio alone, when no customer is stopped by the cause any more. **Known data problem** comes from phase 2.
- A cause keeps its owner, status and notes for as long as it exists, across saves. A fixed cause stays listed under
  "Fixed" until the document's next approval, then drops off.
- **Notes** are short, plain text, with the author and time. They are for the people fixing it; they never appear in
  a document or a package.
- The Blockers screen shows the owner and status on each row, has a filter "Mine", and the detail panel has the owner
  picker, the "Being fixed" switch and the notes.
- Anyone who can comment can assign, change the status and add notes. With sign-in off the only possible owner is the
  local admin; the screen says that assignment becomes useful with sign-in on.

## 3. Notifications and "My work"

- **A bell** in the top bar with the number of unread items, and a panel listing them, newest first. Each item says
  what happened, in which document, and opens the right place. "Mark all as read".
- **What creates a notification** (never for your own action):
  - a blocker is assigned to you; a note is added to a blocker you own; a blocker you own is fixed;
  - a document is submitted for review (to reviewers and approvers); changes are requested or it is approved (to the
    person who submitted it);
  - someone replies to your comment;
  - a comment arrives through a review link you made.
- **My work**: one list of what is waiting for you across all documents: blockers you own that are not fixed,
  documents waiting for your review or approval, and unanswered review-link comments.
- Stored on the server per user. The browser asks for news every 30 seconds while the studio is open. No email, no
  push, nothing outside the studio.
- No customer names in a notification: ids and counts only, as in the Activity log.

## 4. See who else is editing

- The studio shows who else has the same document open: initials in the top bar, with the screen they are on.
- When another person has the same component selected in Design Studio, the Inspector says so before you edit:
  "Dana is also on this component." It is a warning, not a lock.
- Saving already refuses to overwrite a newer saved version (the version check). The message for that case is made
  clearer: who saved, when, and the choices (reload theirs, or keep editing and compare).
- How it works: each open window tells the server every 15 seconds which document, screen and component it is on. The
  server keeps this in memory only and forgets a window after 45 seconds of silence. Nothing is written to the
  database or the Activity log.
- With sign-in off, two windows are both "Local admin"; they are told apart as "another window".

## 5. Blockers phase 6: warn before saving

- On Save, the studio works out the fast blockers (rules, wording, translations, data) for the version about to be
  saved and for the last saved version, across all the document's customers.
- If the save would add a root cause that was not there before, a dialog lists the new causes with how many customers
  each stops, and offers **Go back** and **Save anyway**. Saving is never prevented: approval is where blockers stop a
  document.
- Layout and PDF blockers are not part of this check (they need pages to be composed); the dialog says so.
- No dialog when nothing new is added, so ordinary saves are unchanged.

## 6. Blockers phase 5: AI drafts for wording blockers

- For a **missing required translation**, the blocker's detail offers "Draft the translation": the existing
  translation helper writes a draft, labelled as a draft. The blocker stays open until a person approves the text.
- For **wording a "must" rule forbids**, it offers "Suggest wording that follows the rules" (the wave 2 helper), shown
  as a before and after that a person applies as one undoable step.
- Without an AI key the screen says so; the built-in helpers (the sample drafts, the rule's own replacement) are
  offered where they exist.
- The assistant policy is unchanged: nothing is approved by the assistant, and no customer data is sent to a model.

## 7. Ask questions of all customers

"Who gets the hardship message, and why?" "How many customers see the winter notice in Spanish?" "Which customers are
stopped, and by what?"

- The answer always comes from the engine: it resolves every customer of the document and counts. The AI model, when
  there is one, only turns the sentence into a structured question. It is given the names of the document's rules,
  messages, sections and fields, never a customer's data, and its output is checked against a fixed shape before use.
- A built-in reader understands the common forms without AI ("who gets X", "how many get X", "why does <customer> get
  X", "who is stopped", "who gets X but not Y").
- The answer shows the count, the customers, the reason in words (which rule and which condition), and links to the
  Scenario Landscape and Data Explorer with the same customers selected. It also shows the question as the studio
  understood it, so a wrong reading is visible.
- It lives in the assistant panel as "Ask about all customers".

---

## Build plan

Two builders at a time, each in its own branch, merged by the integrator.

| Pair | Builder | Scope |
|---|---|---|
| First | A | Review links: server, review page, making and revoking, tests, `docs/api/REVIEW_LINKS.md` |
| First | B | Blockers phase 4, notifications and "My work" |
| Second | C | Who else is editing; warn before saving |
| Second | D | AI drafts for wording blockers; ask about all customers |

The integrator joins review-link comments to notifications after the first pair is merged.

## Not in this wave

Email or any other outside notification; sign-off by link; locking a component while someone edits it; live
co-editing; a history of blockers.

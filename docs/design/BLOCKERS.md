# Blockers: seeing them, sharing them, resolving them

Status: **design agreed in a workshop with the product owner on 2026-11-13 (eight decisions). Phases 1 to 5 are built (see the phase list, "As built: phases 2 and 3", "As built: phase 4" and "As built: phase 5"); phase 6 is not.**

## Where we start from

- A blocker is a problem that stops a document being issued to a customer. The studio raises 16 kinds: missing approved wording or translation, rules that tie or select nothing, values that do not add up, broken data links, unsafe links, content that would run off the page, and a few more.
- They show in three places: the status bar count, Validate & Compare ("This customer" and "All customers"), and the Review panel, where they block approval.
- Every issue already has a **Suggested fix** with its effect on all synthetic customers shown before it is applied, and **Fix all safe issues** applies the low-risk ones in one undoable step (D66).
- Missing: one home for blockers, grouping by cause, a clear path for data problems, an owner and status, a way to work through them in order, and anything that stops a fixed blocker coming back.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Where blockers live | **A Blockers screen.** One always-up-to-date list for the whole document across all customers. The status bar count opens it. Validate & Compare stays for running checks and comparing outputs. |
| 2 | Grouping | **By root cause.** One blocker per cause, showing how many customers it stops and which. Fixing the cause clears all of them. |
| 3 | Kinds | **Sorted by the kind of fix:** wording or translation, rules, layout and pages, data fields, and "this customer's data is wrong". Each kind has its own next step and opens the right screen. |
| 4 | Data problems | **Open in Data Explorer** with the offending fields highlighted, and **mark as a known data problem** with a reason. (An exported report and document safeguards were not chosen.) |
| 5 | Help with fixing | **Work through them one by one** (most customers first), **AI drafts for wording blockers** (a person edits and approves), and **alternative fixes side by side** with the effect of each. |
| 6 | Ownership | **Owner, status and notes.** Statuses: Open, Being fixed, Fixed, Known data problem. Only the studio sets "Fixed", when no customer is stopped by it any more. |
| 7 | Exceptions | **Only known data problems** may be set aside, by an approver, with a reason; shown on the approval screen and in every release. Blockers in the document itself must always be fixed. |
| 8 | Prevention | **Warn before saving** when an edit would create a new blocker, and **offer to pin a test** when a blocker is fixed. (A full history of blockers was not chosen.) |

## What follows from these

- **Two speeds of checking.** Rule, wording, translation, data-link and data-consistency blockers are worked out by the engine in well under a second for every customer, so the Blockers screen keeps them current after every change. Page-layout, PDF/web mismatch and accessibility blockers need pages to be composed, which is slow; they are shown from the last full check with its time, and a button runs it again. The screen always says which is which.
- **A root cause is identified by** the kind of problem and the thing it is about (the component, rule, message or field, and the language). The same cause keeps its owner, notes and status while it exists, including across saves.
- **"Known data problem" is the only exception, and it is narrow.** It applies to one customer and one problem, needs an approver and a reason, never applies to a blocker in the document itself, and is undone automatically if that customer's data or the document changes so the problem no longer exists. It is listed on the approval screen and written into the release manifest.
- **The assistant policy (D65) applies unchanged:** fixes are proposed with their effect and applied by a person as one undoable step; AI drafts are labelled and never approved automatically, so a wording blocker that needs an approved translation stays open until a person approves the text.
- **"Fixed" is earned, not claimed.** Nobody can set it by hand. A fixed blocker stays listed under "Fixed" until the document's next approval, then drops off.
- **Sample customers stay read-only.** For a data problem in a sample customer the choices are: mark it as a known data problem, or make an editable copy in Data Explorer.

## Every place that shows a blocker links to resolving it

Asked by the product owner on 2026-11-13; the answer is yes, and it is part of phase 1. Wherever the studio mentions a blocker, one click opens the Blockers screen on that blocker, ready to resolve:

- the status bar count (every screen);
- Validate & Compare: each blocking issue, and the "All customers" list;
- the Review panel's "Ready to approve?" list;
- Content & Translations: "N customers are blocked until these are approved";
- Data Explorer: blocking issues in "What this customer gets";
- Preview & Export and batch runs: a customer who cannot be issued the document;
- Generate test customers: a generated customer that is blocked;
- the Design Studio inspector's Review tab for a component.

Existing links that jump straight to where a fix is made (a rule, a message, a field) stay; the link to Blockers is added beside them.

## The screen (sketch)

1. **Summary bar:** customers who can be issued the document, customers stopped, blockers by kind, time of the last full check, "Run full check", "Resolve one by one".
2. **List, grouped by kind:** each blocker in plain words, the number of customers it stops (with the list), owner, status, and its best suggested fix with a one-line effect.
3. **Detail:** what is wrong and why, who is affected, the fixes to choose from side by side (each with its effect and risk), "Open where this is fixed", notes, owner. For a data problem: the customer's values that disagree, "Open in Data Explorer", "Mark as a known data problem".
4. **Resolve one by one:** a guided pass over the open blockers, most customers first: explanation, fix options, Apply or Skip, then the next; a progress bar of customers still stopped; at the end, an offer to pin tests for what was fixed.

## Phases

1. **The Blockers screen:** root-cause list across all customers, kinds, the two speeds of checking, detail with existing suggested fixes shown as alternatives, links to where each is fixed; the status bar opens it.
2. **Data problems:** open in Data Explorer with the fields highlighted; known data problem (approver, reason), its effect on approval, the Review panel and the release manifest. **Built** (see "As built: phases 2 and 3").
3. **Resolve one by one**, and **pin a test when fixed**. **Built** (see "As built: phases 2 and 3").
4. **Owner, status and notes.** **Built** (see "As built: phase 4").
5. **AI drafts for wording blockers** (missing translation; wording that reads as a demand for money). **Built** (see "As built: phase 5").
6. **Warn before saving.**

Each phase ends with tests, documentation and a demo path, and is verified before the next starts.

## Risks and limits to keep in view

- A blocker is only as good as the synthetic customers: a cause no customer exercises is not listed. "Generate test customers" is the way to widen the net, and the screen should say how many customers were checked.
- Layout blockers can be stale between full checks. The screen must never present the fast result as a full check.
- Owners need people: with sign-in switched off there is one local admin, so assignment only becomes useful with sign-in on.
- AI drafts need the AI key; without it the screen says so and everything else works.

## As built: phases 2 and 3

Built on 2026-11-13. Engine: `packages/scenarios/src/assist/blockers.ts` (tests `assist-blockers-known.test.ts`); server: `apps/api/src/routes/knownData.ts` (tests `apps/api/test/known-data.test.ts`, and the package scan in `releases.test.ts`); screens: `screens/blockers/*` (`KnownDialog`, `ResolvePass`, `knownData.ts`), `screens/data/BlockerBanner.tsx`, the Review panel; browser tests `e2e/blockers-data.spec.ts` and `e2e/blockers-resolve.spec.ts`. API: `docs/api/KNOWN_DATA_PROBLEMS.md`.

### Phase 2: data problems

- **Open in Data Explorer** from a "the customer's data is wrong" blocker (the detail, each affected customer, and the guided pass) opens `data?customer=<id>&blocker=<id>&highlight=<path>,<path>`. The fields come from the engine (`customerBlockers`: for each kind of data problem, the customer's values that disagree, down to the claim row). They are highlighted, marked "to check" in words, and the first is scrolled into view. A banner, which stays in view, says what is wrong, lists the highlighted values by name, links back to the blocker, and offers the choices: for a sample or imported customer (read-only) **Make an editable copy** (the copy opens with the same highlight and banner) or **Mark as a known data problem**; for the document's own customer, correct and save (the banner says when the unsaved changes correct it, and when the problem has gone).
- **Known data problem**: one customer, one `customer-data` blocker, a reason (required, trimmed, at most 500 characters) and the `approve` permission. Stored by the server with who and when; listed, added and removed under `/api/v1/projects/:projectId/known-data-problems`; refused by the server for a blocker in the document itself, a missing or long reason, an unknown customer, a problem that does not stop that customer, and a role that may not approve. Each write is audited and shown in Activity.
- **Lapsing**: an entry whose blocker no longer stops that customer (data corrected, document changed, customer removed) is not counted, and the server removes it on the next read or write, audits it, and says so; the Blockers screen shows that sentence.
- **Effect**: one pure function (`withKnownDataProblems`) gives every blocker its status and every customer its place, for the screen and the server. A customer whose only blockers are set aside is **set aside**: not stopped, not issuable either (a tile says how many). A blocker whose every customer is set aside has the status **Known data problem**. The detail lists each entry with the reason, who, when and **Remove**. The approval check leaves those customers out of the blocking issues, and the Review panel lists every known data problem with its reason before approving. Every release records them, and its package manifest lists them (an addition; format 1 kept) with no customer data: a sample or generated customer by id, any other customer only as one such customer.

### Phase 3: resolve one by one, and pin a test

- **Resolve one by one** (Summary button, later "Resume one by one (N left)") replaces the list with a guided pass over the open blockers, most customers still stopped first. Each step: what is wrong and why, who is affected, the fixes side by side with the effect of each (the same cards as the detail), **Apply** (through `applyAssistCommands`, one undoable step) or **Skip**. The progress bar and the "N of M synthetic customers still stopped" count are the engine's numbers after each step. The step for a data problem offers Data Explorer and a known data problem instead of a fix; a layout blocker from the last full check says so and offers to run the full check. The pass keeps its place per document for the browser session, so it can be left and resumed; every applied fix is already an ordinary edit.
- **Pin a test**: at the end of the pass, and in the "no longer a blocker" note when a single blocker is fixed in the detail, the studio offers one test per fixed blocker on one affected customer, ticked, which the person can untick. Pinning is one undoable step (`UPSERT_TEST_CASE`), named "Stays fixed: <the blocker in plain words>" and expecting what the document gives that customer now (messages, sections, language, and "no blocking issue" when there is none). Nothing is pinned until the person chooses it.
- The pass, like the screen, says how many customers were checked and which speed each result comes from.

### What differs from the design, and why

- **The URL keeps Data Explorer's existing `customer=` parameter** (not `record=`), so existing links keep working.
- **Setting a problem aside is not undone with the top-bar Undo.** It is a decision stored on the server (with who and when, like an approval), not an edit of the document; **Remove** takes it back.
- **The server judges lapsing against the saved document**; the screen applies the same rule to the open, possibly unsaved model, and the server removes the entry once the change is saved.
- **Restoring a sample to its approved state removes its known data problems**, so a restored sample starts clean.
- **The reason is cleaned for a customer who is not synthetic**: their name and id are replaced by "the customer" in what a release records. The studio itself keeps the reason as typed.
- **A release is not made again only because the known data problems changed**: a release is made for new content, so re-approving unchanged content keeps the existing release and what it recorded.
- **`markedAt` is a moment in the package**, beside the approval and creation times, because the list is frozen with the release.
- **A fix applied in the pass to a blocker from the full check** is listed as "waiting for the full check to confirm" and is not offered a pinned test, because the studio cannot yet tell that it worked.
- **The status "Known data problem" belongs to a blocker only when every customer it stops is set aside**; otherwise each customer shows its own mark. Owners, the other statuses and notes are phase 4.
- **None of the shipped sample customers has a data problem today**, so the read-only path is shown in the tests with an imported customer (shared and read-only in the same way); a sample customer named by id in a release is tested with a document change that leaves a value every sample lacks.

## As built: phase 4

Built on 2026-11-14 (wave 4, item 2 of `docs/design/WAVE4_TEAMS.md`). Server: `apps/api/src/blockerWork.ts` and
`apps/api/src/routes/work.ts` (tests `apps/api/test/blocker-work.test.ts`); screens: `screens/blockers/WorkParts.tsx` and
`work.ts`, with the list, detail and guided pass; browser tests `e2e/blockers-owners.spec.ts`. API: `docs/api/BLOCKER_WORK.md`.

- **Owner, status and notes** are kept by the server per document and blocker id. Every row shows its status (Open, Being
  fixed, Known data problem) and its owner ("Yours" for the person's own); **Mine** (`?mine=1`) shows only the person's own. The
  detail has **Owner, status and notes**: the owner picker (studio users), the **Being fixed** switch, and the notes (plain text,
  author and time, oldest first, at most 1,000 characters). The guided pass shows the owner and status of each step.
- **Anyone who may comment** assigns, sets the status and adds notes; the server checks it (`comment`) with sign-in on. With
  sign-in off the only possible owner is the local admin, and the detail says in one line that assignment becomes useful with
  sign-in on.
- **"Fixed" is decided by the server, against the saved document.** After every successful change to a document (a hook on the
  document's routes, before the answer leaves) and on every read of the work, the server works out every cause the saved
  document has for every customer on every day approval checks (`savedCauses`: the resolver's findings per customer, broken
  "must" wording rules, the static rule and data-link checks). A worked-on cause that is gone is marked fixed once, with its
  version, and its owner is notified unless the owner's own change fixed it; a fixed cause that comes back is open again. The
  screen also shows a worked-on cause that the open, unsaved version no longer has as **Fixed when saved**.
- **Causes only the full check sees** (layout and pages, PDF/web, PDF accessibility) are judged by a full check of the saved
  version: the screen reports what such a check found, and the server refuses a report about any other version.
- **The "Fixed" group** lists fixed causes, with the version, owner and notes, until the document's next approval; then they
  drop off with their notes (the approval time is read from the review history).
- **Notes never appear in a document, a release or a package**; the test approves a document with notes and scans the release
  and every package file. The Activity log records who assigned, set a status or added a note (never the note), and when the
  studio found a cause fixed or open again.

### What differs from the design, and why

- **"Fixed" is judged on the saved document, not the open one.** It is a fact the whole team relies on and that notifies the
  owner, so it must not depend on someone's unsaved edits or on the Blockers screen being open. The screen shows the unsaved case
  separately ("Fixed when saved").
- **A cause must be in the saved document to be given an owner or a status** (`409 NOT_IN_SAVED_DOCUMENT`), otherwise the server
  would at once judge it fixed. Causes only the full check sees are the exception: they are accepted and judged by full-check
  reports.
- **Full-check causes are judged by what the browser reports** about a full check of exactly the saved version, because only the
  browser runs the full check today. A report is about status only; approval does not depend on it.
- **The owner picker reads a new `GET /api/v1/assignable-people`** (names and roles of enabled users) because the user list
  (`/api/v1/users`) is for admins only.
- **A fixed cause that comes back is Open**, not the status it had before; its owner and notes are kept.
- **Giving an owner, a status or a note is not an edit of the document**, so it is not undone with the top-bar Undo (as for known
  data problems).
- **No owners or notes are seeded into the example documents**, so the examples' accuracy check is unchanged.
- **A dated document**: the server judges a cause on every day approval checks, while the screen shows one "As issued on" day;
  a cause present only on another day is not shown as "Fixed when saved" on the screen.

## As built: phase 5

Built on 2026-11-14 (wave 4, item 6 of `docs/design/WAVE4_TEAMS.md`). Screen: `screens/blockers/WordingHelp.tsx`, shown in
the blocker detail under the fixes and in each wording step of "Resolve one by one"; server: the `tone` option of the
"suggest compliant wording" route (`apps/api/src/assistAi.ts`); tests `apps/api/test/blockers-drafts.test.ts` and
`e2e/blockers-drafts.spec.ts`. API: `docs/api/ASK_ALL_CUSTOMERS.md` (the `tone` addition).

- **A missing required translation**: **Draft the translation** asks the same helper Content & Translations uses (AI with a
  key; without one, the labelled sample drafts written for the built-in examples; otherwise it says there is neither). The
  text is stored as a DRAFT with where it came from ("AI" or "Sample"), as one undoable step, and never approved. The detail
  shows the draft, says that the blocker stays open until a person reviews and approves the text, and links to Content &
  Translations at that text (`content?lang=<code>&text=<id>`).
- **Wording a "must" wording rule forbids, and the built-in "reads as a demand for money" check**: **Suggest wording that
  follows the rules** asks the wave 2 helper for the text the blocker is about. Each suggestion is shown as the text now and
  as suggested, with the words that change struck out and underlined; **Use this wording** changes it as ONE undoable step
  (`setTextCommands` through `applyAssistCommands`). A translation becomes a draft for a person to approve. For the demand
  check the helper is given the studio's own tone rule as a "must", and every suggestion is re-checked with it.
- **Without an AI key** the detail says so in one line and still offers what is built in: the sample draft, and a banned
  word's own replacement from the rule, shown the same way as before and after.
- **Never rewritten by the assistant**: required disclosure text (the detail says so and links to it) and text that comes
  from the library (it says to reword it there).
- **The assistant policy (D65) is unchanged**: only the document's own text (and, for wording, the rules) is sent to a model,
  never a customer's data; a person applies every change; nothing is approved by the assistant. The tests prove it for both
  paths: the request the stand-in model receives holds no value of any customer; the translation is a draft and the blocker
  is still listed for the same customers afterwards (only an approval clears it); one change, and one undo, restores the
  wording.

### What differs from the design, and why

- **The rule's own replacement is offered twice when there is no key**: as the existing fix card ("Apply this fix") and as
  the before and after under "Suggest wording that follows the rules". Both are the same single change; the second shows the
  words that change, which the design asks for.
- **A "required phrase is missing" wording blocker gets no suggestion**: there is no text to rewrite; the fix cards say where
  to add it.
- **The demand-for-money check applies to explanations of benefits in English**, as the resolver's own check does.
- **Content & Translations gained `?lang=&text=`** (the language and the search box), the smallest way to open it at one text.


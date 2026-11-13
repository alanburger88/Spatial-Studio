# Blockers: seeing them, sharing them, resolving them

Status: **design agreed in a workshop with the product owner on 2026-11-13 (eight decisions). Nothing in this document is built yet.**

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
2. **Data problems:** open in Data Explorer with the fields highlighted; known data problem (approver, reason), its effect on approval, the Review panel and the release manifest.
3. **Resolve one by one**, and **pin a test when fixed**.
4. **Owner, status and notes.**
5. **AI drafts for wording blockers** (missing translation; wording that reads as a demand for money).
6. **Warn before saving.**

Each phase ends with tests, documentation and a demo path, and is verified before the next starts.

## Risks and limits to keep in view

- A blocker is only as good as the synthetic customers: a cause no customer exercises is not listed. "Generate test customers" is the way to widen the net, and the screen should say how many customers were checked.
- Layout blockers can be stale between full checks. The screen must never present the fast result as a full check.
- Owners need people: with sign-in switched off there is one local admin, so assignment only becomes useful with sign-in on.
- AI drafts need the AI key; without it the screen says so and everything else works.

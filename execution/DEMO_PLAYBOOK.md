# Eight-minute guided stakeholder demo — scripted but genuine

Audience: executive and experienced CCM engineers together. Presenter controls may advance scenes, **but all state and output must come from the working engine**. Button labels should match `contracts/SCREEN_CONTRACT.json`.

| Elapsed | Action and route | What must really change | Speaking point |
|---|---|---|---|
| 00:00–00:40 | S01 choose Aster Card; S02 Design | Show editable 2D page, live selected record, token and component tree | A familiar statement, built in an unfamiliar way |
| 00:40–01:30 | Drag conditional text component and bind field | Model version increments; save/reload; resolved preview updates | Not a static demonstration |
| 01:30–02:25 | Click payment-guidance `Explore variants` → S03 | 5 real variant faces, trace/conditions and active selection; transition from page | Pulling the document apart exposes decisions |
| 02:25–03:15 | Switch from CARD-0001 to CARD-0002, edit/undo R04 | Resolver recomputes to assistance variant; bound trace and contrast view change | Personalization is explainable, not magic |
| 03:15–04:00 | S04 Cube axis change; S05 Landscape defects filter | Cube intersections and Landscape population counts derived from 100 fixtures | Understand the entire possibility space |
| 04:00–04:45 | S08 trigger missed payment then assistance request | Future preview changes; issued Day 1 snapshot digest stays unchanged | Communication behavior evolves over time |
| 04:45–05:35 | S06 Page Stack with 250 transactions; S09 Validate | Measured continuation pages and real layout diagnostics | Find production risks before customer delivery |
| 05:35–06:30 | S10 export PDF + HTML, open both; show AFP preview | Actual PDF and offline HTML actions, semantic content parity; AFP labelled simulated | One meaning, separate physical experiences |
| 06:30–07:15 | S01 switch HarborCare; show EOB and denied-under-review | EOB uses same engine; visible THIS IS NOT A BILL; no unsupported patient debt | Different industry, same foundation |
| 07:15–08:00 | S12 ask AI why message appears; decline proposed edit; reset | Trace-based explanation, no mutation on decline, deterministic reset | AI assists without overriding governance |

## Before the meeting

- Start service and check all 12 routes, key golden case and PDF/HTML export on an actual browser.
- Run reset; choose CARD-0001 and default project version; verify offline fallback available.
- Have generated PDFs and HTML files as contingency **only** if clearly labelled prior generated artifacts, never presented as proof of a live command.
- Have a local-only startup option with fixture data; if AI unavailable, show `offline fallback` visibly.
- At 125% browser zoom verify readable document and inspector.

## Speaker shortcuts and failure handling

- Presenter mode advances semantic steps, not prerecorded video; every demo step can be interrupted and explored.
- No network means use offline AI; no live PDF means stop and report error, do not substitute static PDF as live export.
- Issues explain failures and exact remediation, never reset behind the user's back.
- After reset, expected source models and test fixtures must match the original baseline digests.

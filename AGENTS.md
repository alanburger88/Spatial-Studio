# Agent instructions — InfoSlips Spatial Studio

You are implementing the **approved POC** from the attached specification and this build contract. Deliver code and evidence, not a new set of speculative design documents. Work autonomously within the safe scope below.

## Non-negotiable execution rules

1. Read `START_HERE.md`, `BUILD_CONTRACT.md`, all three `docs/approved/*.md`, `execution/TECH_STACK_AND_ADRS.md` and `execution/MILESTONE_GATES.md` before writing core application code. Use `contracts/ACCEPTANCE_MATRIX.json` as the tracked requirements inventory.
2. Build **one model, one deterministic rule engine, separate presentation profiles**. UI, 2.5D, PDF, HTML, journey, diagnostics and AI explanation must all derive from the same resolved run.
3. Implement independently verifiable behavior. Do not substitute hard-coded screens, fake page counts, fabricated rule conflicts, preset PDF files, screenshot-based HTML or cosmetic spatial cards.
4. Use the supplied fixture IDs, node IDs, rule IDs and test oracle outcomes. Preserve source record data unless explicitly creating versioned scenario overrides. Tests must include both document types.
5. The four spatial views are **Exploded Document**, **Document Cube**, **Scenario Landscape**, **Page Composition Stack**. Exploded is the signature and must be both visually polished and model-driven. Each spatial insight needs keyboard and 2D/list alternatives.
6. Exactly 15 approved component types are authorable. Each supports insert/select/configure/save/load and standard editing operations; complex domain behavior is implemented in the designated subset.
7. Build true PDF output with composer-measured page counts and continuation tests, and an exportable interactive HTML experience. AFP is a clearly watermarked/labelled feasibility simulation only.
8. Financial arithmetic uses **integer cents**. EOB patient liability cannot be invented; `THIS IS NOT A BILL` must be visible. Do not claim regulatory or WCAG certification.
9. AI actions must be schema validated, explanation sourced to a resolver trace, and proposed mutations previewed and explicitly approved. Server secrets never enter client bundles. Fallback always works without AI provider.
10. Future events never modify issued snapshot bytes/hashes. No changes to immutable artifacts.
11. Keep animations subtle, meaningful and accessible, with `prefers-reduced-motion`. Provide full keyboard path for essential functionality.
12. Write tests **before claiming** features finished. A feature is done only when it works in a browser, relevant automated tests pass, and evidence is recorded. Track every AT-01…AT-36 explicitly.
13. After each milestone, run gate-specific tests. Repair failures. If a test cannot run, mark **BLOCKED** with reason; never mark PASS or silently skip.
14. Never use real customer, credit-card, medical or health records. Do not send such data to external AI. Do not deploy or create paid infrastructure without explicit instructions.
15. Finish with `reports/FINAL_IMPLEMENTATION_REPORT.md` containing exact launch commands, gate table, 36 acceptance statuses, screenshots/recordings, example exported files, architecture caveats and all unfinished work.

## Autonomy boundaries

- **Do autonomously:** choose compatible stable versions, install local dependencies, generate code, tests and assets, adjust implementation details, refactor, fix defects, create local repository commits where permitted, and record ADRs.
- **Seek approval only if required:** a real compromise to the approved requirements, disclosure of personal/confidential data, costs or irreversible external actions, branding adoption, or external publication.
- **Pending sponsor inputs:** official InfoSlips design assets (only at final brand integration) and publish destination (only at actual deployment). Use placeholder tokens in the meantime.
- **Do not:** commit `.env`, create production accounts, upload proprietary material to third-party services, use live customer data, claim AFP is exported, or report certification.

## If constrained by execution time or context

Persist state in `reports/BUILD_PROGRESS.md` and `reports/DECISIONS.md`: exact commit, completed gates, failing tests, next runnable command, outstanding acceptance cases. Never replace functional requirements with a superficial mock. A partial verified build is better than an inaccurate completion claim.

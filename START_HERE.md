# InfoSlips Spatial Studio — AI Development Pack v1.0

**Mission:** One autonomous development assignment to build the complete, connected **POC** described in the approved product and UX specifications. This pack contains **requirements and working test-oracle fixtures, not an already built application**. A one-shot instruction does not guarantee a single execution session or an enterprise-ready result: the agent must implement iteratively and prove each milestone.

## Fast start for Claude Code, Codex, or another coding agent

1. Unzip into an empty project directory; open that directory in the coding environment.
2. Provide the agent with `execution/ONE_SHOT_PROMPT.md` **verbatim** as the initial assignment. It directs the agent to read this file and `AGENTS.md`.
3. The agent should run `python3 scripts/verify_pack.py` immediately. **This checks supplied inputs only, not a built app.**
4. The agent should then build the application in `apps/` and `packages/` while honoring the locked contracts and implementing the acceptance tests.
5. After the application is running, the agent runs `python3 scripts/verify_app.py --base-url http://127.0.0.1:3001` and the project's own unit, integration, E2E, visual and accessibility checks. A missing application is a **failure**, not a skipped pass.
6. The agent delivers runnable source, build/test commands, representative outputs and a filled `reports/FINAL_IMPLEMENTATION_REPORT.md`.

## Document hierarchy / precedence

1. **Approved user decisions** represented by `docs/approved/PRODUCT_SPEC.md` (authoritative scope and behavior).
2. **AI implementation obligations** in `BUILD_CONTRACT.md` and `AGENTS.md` (clarifies how to implement without weakening approved scope).
3. **UX behavior** in `docs/approved/UX_BLUEPRINT.md` and `contracts/SCREEN_CONTRACT.json`.
4. **Test oracle / acceptance**: `fixtures/expected_scenarios.json`, `contracts/ACCEPTANCE_MATRIX.json`, and `tests/` (nonnegotiable for covered cases).
5. **Implementation recommendations** in `docs/approved/IMPLEMENTATION_PLAN.md` and `execution/TECH_STACK_AND_ADRS.md`.
6. **Visual inspiration only**: `reference/UX_ATLAS.html` and `reference/screenshots/` — NOT a functioning product and NOT proof of engine behavior.

If any documents appear contradictory, preserve the approved requirement, document the ambiguity in `reports/DECISIONS.md`, choose the simplest compliant implementation, and continue. Do not invent a user-approved scope reduction.

## What is inside

| Path | Function |
|---|---|
| `AGENTS.md`, `CLAUDE.md` | Repository-wide agent rules (Claude file points to AGENTS) |
| `BUILD_CONTRACT.md` | Required architecture, prohibited shortcuts, acceptance boundaries |
| `execution/ONE_SHOT_PROMPT.md` | Copy/paste launch instruction |
| `execution/TECH_STACK_AND_ADRS.md` | Chosen stack and binding architecture decisions |
| `execution/MILESTONE_GATES.md` | Autonomous order of implementation and evidence gates |
| `execution/DEMO_PLAYBOOK.md` | Eight-minute stakeholder run-through and fallback |
| `execution/SECURITY_AND_AI.md` | External AI, approval, offline, privacy constraints |
| `docs/approved/` | Three original specifications, Markdown + Word copies |
| `reference/` | Offline UX Atlas and 12 reference screenshot PNGs |
| `fixtures/` | 100 synthetic customers, 12 personas, 20 rules, 15 components, 30 content parts, 2 projects, journeys, oracle goldens |
| `contracts/` | JSON contracts, screen IDs and 36-case acceptance matrix |
| `oracle/` | Standalone **reference** evaluator; never import it as app engine |
| `scripts/` | Pack validation and independent live-app smoke test |
| `tests/` | Independent fixture/oracle tests and future E2E tests |
| `reports/` | Required reports and decision log templates |

## Known, intentional limitations

- **PDF** and **interactive HTML** are real target outputs. **AFP is a visible simulation only**, never a genuine AFP file.
- Credit statement and EOB output are **synthetic illustrations, not legal/regulatory certification**. EOB must prominently show **THIS IS NOT A BILL**.
- The future InfoSlips logo, brand assets and hosting destination are **pending sponsor inputs**. Use replaceable design tokens and local packaging. **Request branding only at visual-identity integration and hosting details only when actual publication is authorized.**
- Live AI is an **optional server-side external integration**. Core functionality must not depend on network connectivity to AI.
- Pack test oracles prove supplied fixture consistency and selected expected rules; they do not validate the eventual PDF engine or UI. The application's tests must provide that evidence.

## Immediate verification (no app required)

```bash
python3 scripts/verify_pack.py
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

After building the app (never pretend this is passing before then):

```bash
python3 scripts/verify_app.py --base-url http://127.0.0.1:3001
# Also run the app's documented pnpm lint, typecheck, test, e2e, a11y and build commands.
```

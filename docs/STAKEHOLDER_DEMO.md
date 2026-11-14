# Stakeholder demo — presenter guide (≈8 minutes)

**Before the meeting:** run `pnpm start` (or `pnpm dev`), open http://127.0.0.1:5173/projects, click **Reset demo**. Optionally run `./scripts/verify-all.sh --app` beforehand. Browser zoom 100–125%. Live AI is optional; the offline assistant is clearly labelled.

Open **Guided Demo** (S11) → **Start guided demo**. The narration banner travels with you; every step performs real commands and shows a ✓ checkpoint.

| Time | Step | Say | Point at |
|---|---|---|---|
| 0:00 | Familiar page | “A familiar statement — but every block is a component in one model, bound to data and rules.” | Dock: run ID, rules R01 R12; select a component, inspector tabs |
| 0:40 | Author | “This is an editor, not a viewer.” Bound field inserted and saved. | Save state → model version; undo button |
| 1:30 | Explode | “Pull the decision apart.” Five real variants in depth — depth means *alternative outcomes*, nothing else. | Panel chips (rules), reach bars (synthetic counts), connector to the page |
| 2:25 | Persona | Switch to Taylor Rivers (CARD-0002). “Assistance requested — because R04 matched, with these inputs.” | Active marker moves; decision trace table |
| 2:50 | Rule change | R04 disabled → standard message; undo → back. “Cause and effect, reversible.” | Rules & Data trace |
| 3:15 | Cube | Persona × language × journey across 70 records. “Empty means no matching fixture — we never invent output.” | Selected cell inspector |
| 3:40 | Landscape | “Every evaluated scenario grouped by outcome; Σ clusters = 70.” Show defects-only: the Spanish customers lack approved translations — a real finding. | Coverage bar ✓ reconciles |
| 4:00 | Journey | Day 30 missed payment → reminder; Day 45 assistance → assistance message. “The issued Day 1 statement is frozen — same hash.” | Issued vs preview hashes |
| 4:45 | Page Stack | 250 transactions → 8 measured pages, headings repeated. Optionally tick *Disable continuation* → genuine overflow diagnostic, then untick. | “8 pages · PDF verified 8” |
| 5:35 | Export | Real PDF + interactive HTML (sort/filter/expand). Parity: same facts, different experiences. AFP tab: simulation only. | Parity table 9/9 |
| 6:30 | HarborCare EOB | Same engine, different industry. THIS IS NOT A BILL; unconfirmed $300 is never shown as owed. | Member responsibility tile |
| 7:15 | AI | “Why does this message appear?” → answer sourced from the trace. Proposed rule change → **Decline** → model unchanged. | Proposal card, digest proof |

**Recovery:** any step can be re-run from S11 (**Run**). **Reset demo** restores both approved samples. If an export fails, say so and show the error — never substitute a saved file. **Explore freely** hides the banner; **Resume guided demo** brings it back.

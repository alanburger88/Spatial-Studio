# AI, consent and security contract

## Trust model

All records are synthetic. External AI may receive only the minimum sanitized synthetic scenario, tool schemas and model-neutral descriptions needed for user intent. No real customer, PHI, financial account, or proprietary InfoSlips document data is permitted. Do not automatically upload `docs/approved/` to a provider. Never send user-supplied uploads to an external provider without authorization.

- **Model calls happen server-side only**, with secrets loaded from environment; no `VITE_`/browser keys.
- Provider configurable through `AI_PROVIDER`, `AI_MODEL`, `AI_API_BASE_URL` and `AI_API_KEY`; offline mode is default and completely usable.
- Rate limit, bound prompt length, enforce server-side timeout/retry and friendly unavailable response. No fabricated provider reply on failure.
- Treat model output as untrusted. Validate a typed action against a strict allowlist and current project schema. Block unknown paths, external URLs, scripts, SQL, data exfiltration or hidden admin actions.
- Never interpolate untrusted content into rule evaluators as executable JavaScript.

## Allowed assistant tools (MVP)

| Action | Inputs | Mutation? | Safety/validation |
|---|---|---|---|
| `select_scenario` | `recordId`, optional approved `overrides` | No project mutation | Schema check, synthetic records only |
| `set_cube_axes` | exactly 3 unique axes from catalog | View state only | Enumerated whitelist, volume cap |
| `focus_component` | `nodeId`, optional `view` | View state only | Node must exist in current project |
| `explain_resolution` | `runId`, `nodeId` | No | Use actual deterministic trace and source bindings |
| `run_validation` | `runId`, `checks` | No | Known check identifiers only |
| `propose_rule_edit` | structured `rulePatch` | **Proposed only** | Need before/after diff and user click `Approve` |
| `propose_content_edit` | typed `contentPatch` | **Proposed only** | Sanitize, preview, click `Approve` |

### Explicit approval flow

1. Assistant returns a proposed typed patch; no model write.
2. UI shows old/new value, affected nodes, synthetic projected impact, validations and approval/decline controls.
3. Decline closes proposal and proves source model digest unchanged.
4. Approve calls typed command bus, validates permissions and creates an undoable version.
5. AI cannot modify immutable issued snapshots; proposal cannot bypass safety checks.

## Offline fallback

- Deterministic grammar/keywords recognize at least: choose assistance case CARD-0002, explain selected variant, show Spanish edge case, switch to EOB, run validation, open Cube.
- Every fallback response visibly says **Offline assistant / scripted capability**. It must not impersonate a connected LLM.
- Fallback explanations come from resolver trace and are correct for current model; avoid prewritten text asserting a fixed active rule.

## Threat-model checklist

- Sanitize rich text and URLs; disable inline scripts, javascript URLs, insecure embeds, external tracking pixels.
- Validate whitelist of binding paths per document schema and size limits for imported data.
- Deny network access during local fixture execution except explicitly authorized AI calls.
- Avoid logging personal data or API keys; redact request/response logs.
- Validate file names, export routes and project IDs against traversal; prevent SSRF via AI provider URLs and user content.
- CSRF policy for hosted write API; POC private server still needs origin controls.
- Security review before any real users or real data; **this POC is not certified to process production customer or health data**.

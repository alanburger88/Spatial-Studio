# HTTP/API contract v1.0

A proposed **implementation contract for the POC**, not an already implemented service. Service base URL local default `http://127.0.0.1:3001`; web on `http://127.0.0.1:5173`. Use JSON over HTTP unless binary export. Validate requests with shared typed schemas. `Content-Type: application/json; charset=utf-8`.

## Endpoint inventory

| Verb and route | Purpose | Success result |
|---|---|---|
| GET `/api/v1/health` | Readiness | `{ "status":"ok", "schemaVersion":"1.0.0" }` |
| GET `/api/v1/projects` | List two seeded projects + saved variants | `{ "projects":[{"projectId":"aster-card-demo", ...}, ...] }` |
| GET `/api/v1/projects/:projectId` | Get canonical project, version and profiles | `{ "project":{...} }` |
| PUT `/api/v1/projects/:projectId` | Save project with optimistic version | `{ "project":{...}, "saved":true }` |
| POST `/api/v1/projects/:projectId/reset` | Confirmed synthetic reset | `{ "project":{...}, "reset":true }` |
| GET `/api/v1/records?documentType=...` | Available synthetic records | `{ "records":[...] }` |
| POST `/api/v1/resolve` | Deterministic semantic resolution | `{ "runId":"...", "result":{...}, "trace":[...], "semanticManifest":{...} }` |
| POST `/api/v1/compose/pdf` | Compose actual PDF | `application/pdf`, `%PDF-` bytes, page provenance headers or manifest endpoint |
| POST `/api/v1/compose/html` | Export interactive HTML | `text/html`, standalone offline usable document |
| POST `/api/v1/compose/afp-sim` | Simulated AFP constraints | JSON `{ "simulationOnly":true, "warnings":[...], "media":{...} }`; NO AFP binary |
| POST `/api/v1/validate` | Run deterministic checks | `{ "issues":[{ "code": ..., "severity": ..., "nodeId": ... }] }` |
| POST `/api/v1/journeys/replay` | Replay named synthetic events | `{ "snapshots":[...], "preview":{...} }` |
| POST `/api/v1/assistant/message` | Constrained live/offline AI | `{ "mode":"external|offline", "response":"...", "proposal": ... }` |
| POST `/api/v1/assistant/proposals/:id/decision` | Approve/decline mutation | `{ "approved": false|true, "modelVersion": N }` |

Agent may version/add endpoints but must preserve these operation names and run evidence. API `runId` is an immutable handle to the specific resolved model, dataset, overrides and event position for provenance.

## Resolver request and response — strict common subset

`POST /api/v1/resolve`

```json
{
  "projectId": "aster-card-demo",
  "recordId": "CARD-0001",
  "overrides": {},
  "outputContext": { "profileId": "paged-pdf" },
  "journeyCursor": null
}
```

Response MUST contain these comparable fields under `result` (it may also include additional fields):

```json
{
  "runId": "generated-immutable-id",
  "result": {
    "recordId": "CARD-0001",
    "documentType": "credit-statement",
    "selectedVariants": { "payment-guidance": "payment-standard" },
    "matchedRuleIds": ["R01", "R12"],
    "additiveRuleIds": [],
    "requiredNodes": ["billing-summary", "payment-due", "sample-disclosure-set"],
    "diagnostics": [],
    "documentFacts": {
      "newBalanceCents": 124800,
      "minimumDueCents": 4500,
      "transactionCount": 12
    }
  },
  "trace": [{ "ruleId":"R01", "matched":true, "predicateInputs":{ "card.paymentStatus":"current" } }],
  "semanticManifest": { "modelVersion":1, "requiredNodeIds":["billing-summary","payment-due","sample-disclosure-set"], "facts":{...} }
}
```

**Digest comparability:** independent goldens contain `resultDigest` calculated from only the reference result fields, excluding digest itself. The app may use additional runtime metadata, but selectedVariants, matchedRuleIds, additiveRuleIds, requiredNodes, documentFacts and diagnostics MUST match the provided cases. A test may recompute a canonical subset digest; do not falsely require runtime digest of a different schema to match.

## Export request

`POST /api/v1/compose/pdf` or `/html`: `{ "projectId":"aster-card-demo", "recordId":"CARD-0001", "overrides":{}, "outputContext":{"profileId":"paged-pdf"} }`. For stress case pass the precise `overrides` from `fixtures/expected_scenarios.json` (250 transaction rows). Never treat a known record ID as an instruction to use pre-existing sample output.

## Error response

```json
{ "error": { "code": "INVALID_BINDING", "message": "Unknown field path", "nodeId": "example-node", "correlationId": "uuid" } }
```

Use 400 for invalid input, 404 for unknown ID, 409 for version conflict, 422 for rule/semantic blockers, 500 for unexpected errors (details logged safely). Compose may return 422 if blocking diagnostics affect mandatory content.

## Persistence and commands

- `PUT` requires `If-Match` project model version; on mismatch return 409 with current version. Saving is an explicit model transaction, never a change of selected persona.
- Each edit is a typed command (`INSERT_NODE`, `UPDATE_CONTENT`, `SET_BINDING`, `SET_LAYOUT`, `UPSERT_RULE`, `DELETE_NODE`, etc.) with `commandId` and undo metadata; modelVersion increments once per committed edit.
- `GET` after save returns identical stable semantic IDs and content. `reset` returns seeded default while preserving local standalone configuration.

## HTML output minimum

Must include semantic headings and table, `data-node-id` lineage where possible, sort/filter transactions, expandable explanation, CSS responsive breakpoints, and synthetically labelled data. HTML should run without external scripts/assets and contain no remote tracking. Export must be actual usable HTML, not a wrapper around a raster image.

## PDF output minimum

Must be a valid PDF with text content, useful title metadata, accurate amounts, all mandated labels, and measured pages. 250-row scenario must contain all 250 transactions across pages; continuation headings repeat when configured. Page count for Page Stack comes from the same composition process.

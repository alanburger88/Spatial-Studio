# Frozen sample scenarios — independent acceptance oracle

**Source:** `fixtures/expected_scenarios.json`. Goldens are produced by `oracle/reference_resolver.py` and then frozen as a fixture. The eventual application runtime must not call, copy, or import the Python oracle. It must independently implement the same rules and return compatible core result fields.

| Key | Record | Primary expectation |
|---|---|---|
| `card-standard` | CARD-0001 | R01 + R12; payment-standard; $1,248.00 new balance |
| `card-assistance` | CARD-0002 | R04; payment-assistance-requested, premium/additive hints |
| `eob-covered` | EOB-0001 | R13 selected; reconciled claim and NOT A BILL |
| `eob-under-review` | EOB-0002 | R14 selected; unconfirmed debt not asserted |
| `card-missed-first` | CARD-0001 + overrides | R02 reminder |
| `card-assistance-requested` | CARD-0001 + overrides | R04 assistance-requested |
| `card-arrangement-approved` | CARD-0001 + overrides | R05 supersedes R04 by priority |
| `card-spanish-missing-mandatory-translation` | CARD-0001 + locale | REQUIRED_TRANSLATION_MISSING blocking diagnostics |
| `card-inconsistent-payment-state` | CARD-0001 + inconsistent override | INCONSISTENT_PAYMENT_STATE blocking diagnostic |
| `eob-unconfirmed-liability` | EOB-0002 + contradictory claim override | UNCONFIRMED_MEMBER_LIABILITY blocking diagnostic |
| `card-250-rows` | CARD-0001 + 250 transactions | 250 rows with $508.00 cumulative purchases; R10; **page count must be measured by actual composer**, not encoded in golden |
| `card-tie-defect` | CARD-0002 + synthetic rule patch | R03/R04 priority tie yields `null` selected variant and blocking conflict. Test through editor or test-only rule engine, not public unvalidated arbitrary rule override |

## How to test independently

1. Load the record by `recordId`, apply `overrides` as a *nonmutating deep patch*, and use rule versions for the project.
2. Call the application's pure resolver. Normalize these keys: `recordId`, `documentType`, `selectedVariants`, `matchedRuleIds`, `additiveRuleIds`, `requiredNodes`, `diagnostics`, `documentFacts`.
3. Compare values against `case.expected`. Where arrays represent sets in runtime, normalize sorting, but retain meaning and severity. Do not special-case fixture IDs in application logic.
4. Verify `resultDigest` semantics if the application's canonicalization matches the reference; otherwise compare the normalized core structure.
5. For 250-row case, also compose a real document, parse pages, verify all row IDs and repeated configured table header. No predetermined page count is supplied.
6. For `eob-unconfirmed-liability`, prevent rendering a misleading positive debt even if an input supplied a positive unconfirmed patientResponsibilityCents value.

## Synthetic fields that can be confusing

- Seed projects intentionally include only *logical component placement*. The POC is expected to create initial fixed/flow layout geometry per target profile; do not confuse missing seeded geometry with absent layout requirements.
- Additive `showSection` rule targets (e.g., `relationship-manager`) can address a reusable `contentPartId` even if the target is not a permanent child node in the seed project. Resolution must materialize it deterministically with stable provenance, not silently discard the rule.
- EOB has per-claim scope: `claim` represents the actively evaluated claim; `claims` remains the record collection. Do not total unconfirmed patient responsibility as an amount presently owed.
- `sample-disclosure-set` and credit sample disclosures are demonstration-only. They are not a verified legal content library.

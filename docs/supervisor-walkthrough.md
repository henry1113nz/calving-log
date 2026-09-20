# Supervisor walkthrough — Week 6 scenario script

The application is ready for a supervisor walkthrough. Actual supervisor comments must be
recorded after the session; they are not claimed as completed evidence in the Week 6 report.

## Scenarios

| Scenario | Pages | Expected result | Feedback to record |
|---|---|---|---|
| Relief milker starts a shift | Login → Dashboard | Today’s vat exclusions and unresolved reviews are visible without editing reference data. | Is the morning decision clear in under 30 seconds? |
| Cow is treated for mastitis | Events | Select cow, diagnosis, product and regimen if required; server records the signed-in user. | Are the fields in the same order as farm work? |
| Cow calves earlier than predicted | Events → Reviews | Actual calving reconciles the dry-cow calculation; any still-unprovable case remains open. | Does the warning match the farm’s hold-and-check process? |
| Notebook date was entered incorrectly | Events → Correction history | Owner/vet enters a correction reason; before/after snapshots and actor remain visible. | Is the correction reason adequate for audit? |
| Farm moves from TAD to OAD | Medicines & schedule | Owner adds an effective date; old event snapshots remain unchanged. | Who normally authorises and records this change? |
| Dry-off treatment decision | Dry-off | SCC and mastitis evidence support a recommendation; owner/vet records the final decision. | Is the evidence sufficient and correctly worded? |

## Exit criteria

- Record each requested change, the page affected, priority and reason.
- Separate safety/regulatory changes from visual preferences.
- Do not close an unresolved review merely because the walkthrough is finished.

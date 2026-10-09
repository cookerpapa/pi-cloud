# Projection and commentary matched release

`projection-b14c3777` is deployed on October 9, 2026 from clean source
`b14c3777f5d78317e50a36516578c8a6a0000366`. It includes the projection SQL
optimization from `68872824`, commentary animation from `387c6807`, and the
owner's standing authorization to deploy verified changes without another
confirmation. Schema 183, Pi Durable 1.0.0, guest/Tool Worker protocol 4 and
Cube management protocol 7 remain the matched contracts.

## Deployment and artifact evidence

The [matched procedure](../MATCHED_RELEASE.md) built and scanned eleven images,
reusing the exact registered guest artifact where its inputs were unchanged.
Provenance and checksum verification passed. No fixable HIGH/CRITICAL findings
remain under the existing scan policy; unfixed findings remain in the evidence.
No scan policy was relaxed for this deployment.

There were no active Runs, unsealed writes, VMs, terminals or development
machines before cutover. The operator drained application writers, confirmed
quiescence and deployed matching Cube and application releases. No schema
conversion or business-data reset was required. Web, Control Plane and both
Workers now use `projection-b14c3777`.

[Bounded release evidence](projection-release-20261009.json) records image IDs,
acceptance outcomes and preservation checks. Private build, scan, inventory and
operator reports remain in `dist/releases/projection-b14c3777/`.

## Acceptance

- Browser presentation checks pass for commentary typing animation, immediate
  history/reconnect rendering and reduced-motion preferences.
- Real Luna follow-up, promotion, edits, ordering and same-key retries remain
  inside one Run. Stop returns unconsumed edited inputs; fixture cleanup passes.
- A real browser loses an accepted input response, keeps its draft, restores
  queued text/image after Stop, and resends with a new identity. Direct vision
  and oversized ASCII/Unicode Read diagnostics pass; fixtures are purged.
- The full production suite passes with 22 GPT-6 Luna requests: pure chat
  without a VM, real coding, authenticated preview, warm-VM reuse, background
  service survival, tenant isolation, and the 1,024-file fixture restored onto
  a fresh VM after the original allocation is removed. Observed total Workspace
  file counts were 1,025 before removal and 1,026 after the follow-up Run.

The earlier [source verification](projection-sql-20261009.md) covers 1,652
ordinary tests and 220 deterministic fault cases, including native/display
replay, authority-lock waits, Stop, stale owners and deletion. The release adds
live acceptance; it does not claim a new throughput benchmark or multi-node HA.

## Final state

Owned test accounts and business fixtures are removed after physical cleanup.
The foreign-tenant isolation fixture's exact Project/Workspace metadata is also
removed after confirmed Workspace purge, preserving that existing tenant.
Final native inventory scans 1/1 nodes with zero VMs. No Sessions, Runs,
Workspaces, projects, image objects, open writers or pending controls remain.

The original 29 users/tenants, 30 model profiles and credential bindings, four
password-credential rows and 29 API credentials remain. Before/after fingerprints
match, excluding access/update timestamps and version counters. Platform runtime
settings also match. Web, admin and Control Plane readiness return HTTP 200,
with both Workers ready.

The architecture walkthrough remains at initial-message PG acceptance, before
Worker claim and Session-lease admission. The private-use pilot has not started.

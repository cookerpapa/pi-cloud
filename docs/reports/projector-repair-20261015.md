# Projector review implementation

Status: in progress, 2026-10-15. The owner authorized all repair slices from the
[review](projector-envelope-review-20261015.md). [ADR-0249](../adr/0249-compact-projector-publication.md)
records the protocol decision before implementation. No release has occurred yet.

## Completed source slices

- A1: the private projection prefix now stores only display progress and uncovered
  event IDs. Forced and ordinary writer closure share whole-family cleanup.
  A real PGlite/native projection test checks two children, writer closure,
  preserved next display positions and repeat closure. Four targeted files / 31
  tests pass, including native checkpoint/closure and handoff contracts.
- A2: per-record native write indexes preserve first-match intent lookup and
  native batch order. Kafka decode returns prepared dispatches; Projector reuses
  them, control reconciliation retains only the validated reference, and Worker
  boundary checks no longer repeatedly expand the same dispatch. Six targeted
  files / 37 tests pass. Runtime-core typecheck passes.
- A3: compact execution-topic v17 envelope is implemented. Child view addresses
  and the original Boot reply Topic round-trip; duplicate aliases and standalone
  cancellation publication are removed. Internal commands remain expanded objects.
  Projection locks one root Run before its lease. Targeted envelope/PG/handoff
  tests pass. The broader runtime tests exposed one obsolete multi-Run probe
  fixture; it now uses native child views, and its five tests pass.
- A4: same-commit Tool-start/result references now provide public presentation.
  Arguments reference the admitted checkpoint; canonical result parts reference
  the post-hook Entry. The old post-commit Tool body publisher and its PG identity
  lookups are removed. Text and Tool descriptions share an events collection.
  Forty initial presentation/protocol tests pass; real Pi/native PG/child history
  checks pass (five files / 20 tests). A direct invocation without the maintained
  PG wrapper timed out in database setup; it was rerun with the isolated official
  PostgreSQL fixture, not counted as passing initially.

## Remaining work

- A5: fixed Tool/workflow request separation, matched guest contract, all fixture
  and delivery-provenance updates.
- A6: required checks, full matched release, real Luna/Cube/browser/native-input
  acceptance, obsolete-resource cleanup and final documentation.

Private intermediate logs are under `/tmp/pi-cloud-projector-a1-*` and
`/tmp/pi-cloud-projector-a2-*`. They are source checks, not a serving release.
Preserve the Session producer fencing and all existing closure, PG authority,
Tool dispatch and physical resource cleanup boundaries throughout the remaining work.

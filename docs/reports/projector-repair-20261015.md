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

## Remaining work

- A3: compact one-format Kafka envelope, shared identities/reply target, removal
  of redundant fields and unused standalone cancellation, internal/wire type
  separation, single-root PG validation simplification, matched topic contract.
- A4: native same-commit Tool-start/result display references and removal of
  duplicated post-commit Tool display bodies, with native cancellation/recovery.
- A5: fixed Tool/workflow request separation, matched guest contract, all fixture
  and delivery-provenance updates.
- A6: required checks, full matched release, real Luna/Cube/browser/native-input
  acceptance, obsolete-resource cleanup and final documentation.

Private intermediate logs are under `/tmp/pi-cloud-projector-a1-*` and
`/tmp/pi-cloud-projector-a2-*`. They are source checks, not a serving release.
Preserve the Session producer fencing and all existing closure, PG authority,
Tool dispatch and physical resource cleanup boundaries throughout the remaining work.

# Projector → Cube handoff repair

Status: source implemented; required checks and matched release pending,
2026-10-15. Baseline `9097ba11`; decision [ADR-0250](../adr/0250-cube-handoff-outcomes-and-runtime-admission.md).
The owner authorized the three reproduced findings and exact binding lookup.
The multi-operation-per-record concern is retained as a Pi upgrade contract test,
without changing Kafka/Cube position fields or imposing a native batch limit.

## Source changes

- Takeover failure classification now explicitly separates availability code from
  `not_started`/UNKNOWN evidence. Unknown refusal codes cannot prove non-execution.
  Known unavailable endpoints still block sampling while preserving negative evidence.
- Failure replies and quarantine start independently and are both joined. Lifecycle
  delay/error cannot suppress notification; propagation errors remain observable.
  The partition can still wait for lifecycle settlement. No detached retry task,
  second queue or successful-execution inference is added.
- Exact binding lookup replaces family enumeration in Tool/cancel/probe/preview
  routes and detached binding cleanup. The redundant memory writer index is removed.
  Tenant, Run, writer, readiness, closure and assignment guards remain.
- Native Cube's existing catalog predicate is read inside the execution Manager's
  admission/forget mutex for both Submit and Cancel. Confirmed absence cannot race
  a late request into recreating retained position state. Missing catalog state
  refuses admission; it does not authorize VM deletion or quota release. The new
  maintained patch is `0007-live-vm-tool-admission.patch`.
- An actual pinned Harness test holds both read executions outstanding, verifies
  overlap and separate native intent commits, then settles both. This checks an
  upgrade assumption, not a restriction on arbitrary Storage writes.
- The full Cube live driver now checks that a confirmed-deleted fixture VM rejects
  Submit and Cancel on the original executor Boot before creating its replacement.
  These negative requests carry no file/shell payload.

Contracts remain schema 189 / execution Topic v17 / boot reply v3 / guest 5 /
Cube management 7. Native patch/application artifacts still require the maintained
matched release. Accounts, model/provider configuration and credentials are preserved.

## Verification so far

- Initial outcome suites: 36 tests pass.
- Binding view/dispatcher/probe suites: 47 tests pass; sandbox-control typecheck passes.
- PG/native subset: 32 pass, one Kafka-dependent integration case is skipped without
  its transport fixture. Full transport verification remains required.
- Updated native admission tests, including both Submit/Cancel interleavings, pass
  under the race detector. Full native build/service checks remain part of CI.

The audit probes are replaced by maintained regressions. Their original code and
baseline assertions remain in Git `9097ba11`; their JSON review evidence is retained.
Do not interpret these source results as a completed deployment or live acceptance.

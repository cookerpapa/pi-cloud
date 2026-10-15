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

## Source verification

- Initial outcome suites: 36 tests pass. Binding view/dispatcher/probe suites: 47
  tests pass. The final native Harness/Tool subset passes all 42 tests, including
  concurrent fixed reads and unavailable-but-definitely-not-started sampling guards.
- A 1,000-binding family requires one hot entry lookup and zero hot PG reads;
  bootstrap uses four pages. The audit baseline enumerated all 1,000 entries.
- Updated native admission tests, including both Submit/Cancel interleavings, pass
  under the race detector. Full native admission/allocation/service build checks,
  repository build, typechecks, workspace tests and 71 acceptance-helper tests pass.
- The initial aggregate CI run stopped on a control-Tool recovery test's idle SQL
  measurement. PG projection precedes control consumption, so its original wait
  could count a legitimate unfinished creation/recovery wake as idle polling.
  The fixture now waits for the actual consumed commit, current-generation waiting
  handler and in-flight queries to settle. The unchanged 1.2-second zero-SQL
  assertion remains; no production dispatcher behavior changed for this failure.
  Re-running the complete real RF3/PG transport suite passes all eight tests in
  seven files. Its ordered-binding measurement also confirms 100 reads with zero SQL.
- The remaining fault evaluation and dependency security audit gates pass; the
  dependency audit reports no vulnerabilities. The checked-in fault report records
  its source revision and the test-fixture edit present at test start. Together
  these runs complete the required CI stages; the initial aggregate command itself
  did not exit successfully. Artifact scans and deployed acceptance remain pending.

The audit probes are replaced by maintained regressions. Their original code and
baseline assertions remain in Git `9097ba11`; their JSON review evidence is retained.
Do not interpret these source results as a completed deployment or live acceptance.

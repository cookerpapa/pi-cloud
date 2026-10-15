# Projector → Cube handoff repair

Status: implemented, deployed and accepted as `handoff-6ab91bb7`, 2026-10-15.
Baseline `9097ba11`; runtime repair `c0ebf9e1`; release revision `6ab91bb7`.
Decision: [ADR-0250](../adr/0250-cube-handoff-outcomes-and-runtime-admission.md).
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
Cube management 7. Native patch/application artifacts were deployed through the
maintained matched release. Accounts, model/provider configuration and credentials
are preserved; no schema migration or Topic replacement was needed.

## Source verification

- Initial outcome suites: 36 tests pass. Binding view/dispatcher/probe suites: 47
  tests pass. The final native Harness/Tool subset passes all 42 tests, including
  concurrent fixed reads and unavailable-but-definitely-not-started sampling guards.
- A 1,000-binding family requires one hot entry lookup and zero hot PG reads;
  bootstrap uses four pages. The audit baseline enumerated all 1,000 entries.
- Updated native admission tests, including both Submit/Cancel interleavings, pass
  under the race detector. Full native admission/allocation/service build checks,
  repository build, typechecks, workspace tests and 71 acceptance-helper tests pass
  (1,786 passing assertions across the workspace/helper suites; ten conditional skips).
- The initial aggregate CI run stopped on a control-Tool recovery test's idle SQL
  measurement. PG projection precedes control consumption, so its original wait
  could count a legitimate unfinished creation/recovery wake as idle polling.
  The fixture now waits for the actual consumed commit, current-generation waiting
  handler and in-flight queries to settle. The unchanged 1.2-second zero-SQL
  assertion remains; no production dispatcher behavior changed for this failure.
  Re-running the complete real RF3/PG transport suite passes all eight tests in
  seven files. Its ordered-binding measurement also confirms 100 reads with zero SQL.
- All 244 deterministic fault cases pass. The dependency security audit reports
  no vulnerabilities. The checked-in fault report records
  its source revision and the test-fixture edit present at test start. Together
  these runs complete the required CI stages; the initial aggregate command itself
  did not exit successfully.

The audit probes are replaced by maintained regressions. Their original code and
baseline assertions remain in Git `9097ba11`; their JSON review evidence is retained.

## Matched release and live acceptance

The clean `6ab91bb7` checkout prepared eleven images and passed the maintained
provenance, SBOM and vulnerability gates. The unchanged guest reused its exact
registered digest. Both PG ownership inventory and Cube's complete node inventory
were empty before cutover. Writers were drained before native/app replacement;
the matched operator completed successfully. The serving application catalog is
`handoff-6ab91bb7`, with the new native admission patch included.

All model-backed checks below used GPT-6 Luna:

- Full Cube production acceptance passes: pure chat without VM activation, actual
  file/Bash execution, authenticated preview, warm reuse and preservation of a
  detached background process across Run bindings. A 1,024-file fixture survives
  source-VM removal and attachment to a fresh VM. The deleted VM rejects both
  Submit and Cancel on its original executor Boot; allocation closure and final
  conversation cleanup are confirmed.
- Native input acceptance passes all five scenarios: consume, Stop, real Worker
  crash recovery, stream Stop, and loss of both Worker and Control Plane memory.
  Same-Run identity and native partial output survive; streaming bodies stay out
  of PG. The transient container lookup failure during the injected Control Plane
  crash is followed by the required restart/readiness proof and successful recovery.
  Final Pod inspection also records one replacement-Worker startup failure during
  that dual-crash window: `pi_worker_start_failed`, exit 1 at 10:04:44 UTC; kubelet
  restarted it at 10:05:09 UTC and the same-Run recovery passed. This is not a
  zero-extra-restart result or a diagnosis of the startup failure's internal cause.
- Real browser acceptance passes lost reply → Stop → returned input/image → new
  input identity/direct vision, plus oversized ASCII/Unicode Read through guest,
  completion, Worker and native history. Fixtures are physically purged.
- All five native child scenarios pass: supervisor interaction, messaging, parallel
  children, cancellation and guest workflow boundary. They retain one Session owner.
- During a running native child, a same-image rolling Control Plane replacement
  takes 12,644 ms. The original Worker continues, the control Tool reply recovers,
  the child completes and Bash executes once. This is not a cross-version upgrade
  guarantee; the maintained full matched release still drains writers.
- A separate model-free native check creates/releases an owned development VM
  through the Control Plane, confirms absence on its recorded node and unchanged
  executor Boot, then verifies Submit/Cancel rejection. Its temporary tenant and
  Volume are purged. This isolates live admission evidence from model availability;
  the maintained full Cube driver also covers this assertion.

## Failed samples and corrections

The first full Cube attempt passed through large-file creation, then the added
fixture queried Cube using PiCloud's formatted runtime UUID instead of the saved
native `runtime_name`. Only the operator driver was corrected; runtime artifacts
were unchanged. The final complete run uses the corrected driver.

Three subsequent full Cube attempts and the first browser attempt failed with
model `TLS handshake: EOF`; the successful complete Cube/browser reruns are
recorded separately. The first child-handoff attempt ended with
`native_task_failed` before fault injection, so it is not counted as handoff
evidence and its cause is not inferred from the other failures. Its retry performed
the actual replacement and passed. No provider route, credentials, retry policy or
assertion was weakened. The [external TLS investigation](model-egress-tls-20261012.md)
remains relevant; successful reruns do not prove that intermittent fault is fixed.

## Cleanup and retained boundaries

After lifecycle cleanup and confirmed physical absence, the five Cube-check
tenants and five owned projects left by these runs were removed. Other drivers
purged their own tenants/images. Final native inventory scans 1/1 nodes and finds
zero VMs; no unfinished Run/seal, active Session writer, VM, machine or terminal
remains. The temporary build proxy relay is stopped.

Before/after counts and SHA-256 digests match for 32 tenants, 32 users, 32 API
credentials, five password credentials, 35 model profiles and 35 credential
bindings; source-control credentials remain empty. API credential comparison
excludes only the usage timestamp, consistently on both sides. No original account,
model/provider setting or credential was removed. Normal immutable closure
history and the current execution Topic remain.

The partition can still wait for quarantine settlement after failure notification
starts. Arbitrary Shell work is not exactly-once or automatically replayable. The
native one-intent-per-commit observation remains a pinned-Pi upgrade gate, not a
runtime batch limit or an extension to Kafka/Cube ordered positions. The next
reading hop is Cubelet → the VM's fixed Tool process.

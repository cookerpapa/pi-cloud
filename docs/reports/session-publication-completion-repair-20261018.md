# Session publication and completion repair

Date: 2026-10-18. Implementation baseline: review commit `94ebd1ed`.
Decision: [ADR-0256](../adr/0256-session-publication-and-completion-boundaries.md).
Status: source implemented; full source, artifact and matched/live gates pending.
Serving release remains `tool-settlement-20ac9696` until the rollout below is recorded.

## Implemented behavior

- SPC-01: normal completion replay reads the original tenant/Run/Session/Turn
  terminal and coverage. The shared reader also replaces duplicate forced-seal
  decoding. Replays preserve the event identity and all closure checks.
- SPC-02: a definite pre-send refusal remains native `StorageRejected` through
  the actual Session Host. Unknown ACK or post-ACK confirmation/adoption failure
  interrupts the owner; even a wrongly typed no-send callback exception after ACK
  cannot make a committed batch appear rejected.
- SPC-O1: completion passes its locked Run to the transition helper, which still
  checks row version and returns the updated version for a subsequent cancellation
  transition. The measured fixture uses 16 statements instead of 18, and one Run
  SELECT instead of three. Counts exclude BEGIN/COMMIT and routing revocation,
  and include one timeout-configuration statement.
- SPC-03: RUN_LIFECYCLE and STREAM_DURABILITY now describe direct Session Kafka
  publication, native children and normal versus forced writer retirement.
- SPC-Q1: the closure fixture explicitly exercises a repeated control reference
  and checks one durable terminal/no additional Tool submission. The idle-query
  fixture restarts its bounded observation window only after an actually observed
  ordered wake; unexplained SQL still fails. Verification remains pending below.

The pre-send repair does not add waiting for queue space, automatic storage
retries or preservation of rejected Tool results. The native regression verifies
one Tool execution, native fault settlement and missing-result context. Those
costs were discussed with the owner before implementation.

## Verification

- Scoped runtime-core, pi-session-postgres, control-plane and sandbox-supervisor
  typechecks pass.
- Initial focused regression: 23 tests pass, covering normal completion lost
  return/replay, native cancellation versions, stale old-writer completion after
  readmission, shared Host refusal, unknown/post-ACK failures and native results.
- Full CI, RF3 transport/fault gates, artifact scans and live acceptance: pending.

Baseline defect probes are archived at `94ebd1ed`; maintained regression tests
replace them. The [review](session-publication-completion-review-20261018.md)
retains the initial 7/9 RF3 result and passing diagnostic repeats; those historical
samples are not rewritten as a clean run.

## Release and cleanup

No schema, Kafka Topic, guest or Cube management protocol changes. Release still
uses the maintained matched/drained procedure and scanned artifacts. Preserve
accounts/model/provider configuration/credentials and require physical cleanup
evidence before deleting owned fixture records. Rollout and live outcomes will
be recorded here after completion; source tests are not deployment evidence.

# Worker claim schema repair

Date: 2026-10-10. Implements R10C-01–04 under
[ADR-0242](../adr/0242-worker-claim-schema-cleanup.md), following the
[focused review](worker-claim-schema-review-20261010.md).
Source verification is complete; matched deployment and live acceptance are pending.

## Changes

- Child eligibility uses the candidate tenant and existing child-Run composite
  index, retaining parent liveness checks and one physical-Session owner.
- `run_transitions_run_history` indexes tenant, Run, timestamp and ID.
- Physical Session creation/Fork/storage fixtures no longer write the unused
  creation-time, parent and name columns; migration 184 removes them.
- `workers`, `worker_retirements` and their Worker-reference columns/types replace
  the misleading Sandbox names. Lease coordination and retirement use Worker
  names internally. Cube IDs and existing management/guest transport contracts
  keep their meaning; no compatibility columns or views exist.
- The migration rejects queued/active Runs, unreleased leases or unsealed history,
  preserving existing Worker IDs, boot credential references and closure evidence.

Normal new-lease admission remains nine business SQL statements plus BEGIN/COMMIT.
The change reduces query work, not the number of database exchanges or authorities.

## Source verification

`npm run ci` passes on the implementation worktree based on `94d43eca`:

- All 22 workspace typechecks; 1,671 tests across 255 passing files.
  Nine existing gated tests in seven files remain skipped in this command.
- 64 operator/helper tests, including the asset-recovery drill.
- Seven isolated Kafka/PG transport tests across six files.
- All 235 fault cases in 72 execution groups.
- Dependency preparation, formatting/docs, installer, runtime policy, Cube
  admission/allocation contracts, Helm, observability, image closure, build and
  dependency vulnerability audit.

New tests prove migration refusal before closure, retained Worker/credential/fence
identity, FK and current-owner uniqueness, and child admission with live versus
closed parents. Existing tests cover lost COMMIT, expiry, concurrent Lanes,
registration/reconnect/retirement, Fork/Storage, Stop and native recovery.

The isolated [query-plan probe](../../scripts/experiments/review-worker-claim-20261010/probe.mjs)
uses the current schema and captured candidate query, comparing a deliberately
deoptimized control only inside synthetic test tables. Child relation access with
50,000 historical records uses 3 shared buffers versus 391; the Run history lookup
uses 4 versus 1,539 and returns the same five rows. These are bounded plan
measurements, not production latency or fleet-capacity claims.

Early targeted checks identified outdated fixture columns, the migration-count
assertion and a fixture management URL missing its required trailing slash.
They were corrected before the complete passing CI run; no product fallback or
weakened constraint was introduced.

Private source logs and the pre-release preservation fingerprint are in
`dist/releases/worker-claim-checks/`. The fault report records the pre-commit
worktree provenance explicitly; release artifacts will identify the committed source.

## Deployment

Pending matched schema 184/application rollout, followed by real Luna native-input,
browser/Tool checks and controlled Worker replacement/recovery. Accounts,
model/provider configuration and credentials must retain their pre-release fingerprints.

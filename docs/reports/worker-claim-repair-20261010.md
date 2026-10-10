# Worker claim schema repair

Date: 2026-10-10. Implements R10C-01–04 under
[ADR-0242](../adr/0242-worker-claim-schema-cleanup.md), following the
[focused review](worker-claim-schema-review-20261010.md).
Source verification, matched deployment and live acceptance are complete.
Deployed `worker-claim-5c803cc5`, source `5c803cc536b1718af5a03b6fe003b073671bbb2b`,
schema 184. [Structured results](worker-claim-repair-20261010.json).

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

## Deployment and live acceptance

The maintained prepare/apply workflow built and verified 11 matched images,
drained writers, confirmed native VM absence, applied schema 184 and restored
the application. Image policy found zero fixable HIGH/CRITICAL findings; unfixed
findings remain recorded in the private image evidence. Guest input protocol 4,
Tool Worker protocol 4 and Cube management protocol 7 remain unchanged.

The first preparation failed when an Ubuntu package download returned HTTP 502.
The identical committed source/version passed on retry. The temporary local build
proxy was closed before apply; no permanent proxy or runtime service was added.

Real GPT-6 Luna acceptance passes:

- Native same-Run input consumption, edits, promotion, retry identity and Stop.
- Browser lost-response recovery, Stop/returned draft/image resend, direct vision,
  and large ASCII/Unicode Read through Cube completion and canonical history.
- Cold conversation restoration on another Worker.
- A confirmed Worker process crash (exit 137), ordered recovery of the same logical
  Run, exactly one original native submission, successful completion and a later Run.
- Four concurrent Runs completed across both Workers. This is bounded functional
  evidence, not a fleet-capacity or multi-node-HA measurement.

The [Worker-pool report](pi-worker-pool-acceptance-latest.json) records the live
execution evidence. Native-input/browser drivers purge their own fixtures; the
Worker-pool fixture's remaining account/configuration rows were removed only after
its Session deletion and Workspace Volume purge were confirmed.

Final checks: Control Plane and Web ready, two Workers ready, native inventory
**1/1 nodes scanned and zero VMs**; no Runs, current leases, unsealed writers,
machines, terminals, Sessions, projects or Workspaces remain from acceptance.
The original 29 tenants/users, 30 model profiles/credential bindings, 29 API
credentials, four password-credential rows and platform settings retain their
pre-release configuration fingerprints. No backup was created or requested.

Private evidence is under `dist/releases/worker-claim-5c803cc5/`, with prepare/apply
logs beside that directory. The broader coding/preview/cold-VM and live delegated
Agent suites were not rerun; child-owner/shared-lease and Fork behavior are covered
by the passing source suite. Reading resumes at native Session opening/context loading.

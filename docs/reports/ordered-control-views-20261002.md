# Ordered control views acceptance — 2026-10-02

Status: implemented and deployed. Application revision
`07729c7345fe4aa6c50f3294d9f0dd3f597140aa`, migrations 160–162,
`pi-cloud.execution-log.v13`. Acceptance helper corrections are recorded in
`309de64d`. [ADR-0212](../adr/0212-ordered-control-read-models.md) defines the decision.

## Result and authority

PG mutations co-commit bounded Outbox references. The existing Session ingress
publishes them on the physical Session's Kafka partition; the existing Projector
updates disposable memory views. No second consumer group, cache service,
scheduler, native writer or Pi loop modification was introduced.

| Path | Implemented behavior | Measured acceptance |
| --- | --- | --- |
| Sandbox binding | Tool/probe routing uses an indexed owner view. Creation publishes before returning; closure installs a dispatch barrier before publication. | 100 warm binding lookups: zero SQL. Lost ACK, stale read, deletion and owner replacement cannot reopen a closed binding. |
| Pending input display | Watched queue snapshots arrive through existing SSE; edit responses update the view directly. `viewVersion` is separate from the edit revision. | Another client enqueued messages without browser queue GETs. Reload recovered four items; a 4.5-second idle window issued zero queue GETs. |
| Steer reconciliation | Committed Session changes, native consumption, seals and known retry deadlines wake pending work. | Idle timer tests issue zero reconciliation SQL; in-flight notifications and retry deadlines remain effective. |
| Subagent reads and waiting | Bounded directory/Worker/status views and pending references replace repeated reads and global one-second scans. | Ten repeated status calls issue zero status SELECTs; settled notification streams leave waiting work without idle SQL scans. |

These counts apply to the named paths, not every database operation. PG retains
admission, mutations, leases, history, Outbox and actual Agent-input delivery
eligibility. A regression test demonstrated why the last check must remain fresh:
a receiver can finish before its asynchronous state notification arrives.

Bootstrap captures Kafka bounds before loading PG views. Revocation/reset
invalidates outstanding reads; pending-work recovery reloads durable references.
Control facts do not create Pi Entries or enter model context. Obsolete published
references are pruned in bounded batches, retaining current heads and unpublished
work; deleted source resources need no permanent control history.

## Verification

[Verification record](ordered-views-verification-20261002.json) contains the scope
and counts: 1,562 workspace assertions, 66 acceptance-helper assertions, 124/124
deterministic fault cases, and three dedicated real-PG/RF3-Kafka integration files.
Eight environment-gated workspace cases were skipped; the separate Kafka and live
gates provide their stated coverage, not blanket coverage of every skipped case.

The full workspace command initially failed on old Outbox/queue fixtures. Seal
fixtures now select terminal records explicitly and the shared-notification test
separates admission from settlement. After the final Web fixture gained required
`viewVersion`, all 151 Web tests and 66 helpers passed on rerun. No concurrency,
rollback, idempotency or queue-action assertion was removed.

Build, typechecks, formatting, documentation, dependency, installer, runtime-policy,
Helm/distributed-policy, observability-config, image-closure and high-severity
security gates passed. The security gate still reports two pre-existing moderate
dependency findings.

All real model calls used GPT-6 Luna:

- [Queue/browser acceptance](ordered-views-queue-20261002.json): remote-client SSE,
  reload, no polling, edit/order/cancel and edited Steer; three Runs completed in
  order, and cancelled/promoted source Runs never executed.
- [Thirteen Subagent Turns](ordered-views-subagents-20261002.json): lazy research,
  parallel children, shared/independent VMs, worktree coding/merging, nested compute,
  recursion, direct Agent messages, supervisor exchange, cancellation and guest
  boundary checks. The message had one command, one consumption receipt and one
  native input Entry.
- [Control Plane SIGKILL](ordered-views-handoff-20261002.json): Cube completed the
  original Bash while Control Plane restarted. The original Run and executing
  Worker completed; the file contained one start and one finish, with no replay.

The first rollout exposed a startup dependency cycle: the sandbox listener
required publication readiness before Control Plane could bind its publication
endpoint. Listeners now bind first; readiness remains closed until recovery.
A real HTTP regression checks live=200, ready=503, then ready=200 after recovery.

The initial Subagent acceptance attempt also exposed a test-evidence race:
released temporary VM rows intentionally clear runtime identity. The helper now
observes actual Tool bindings during execution and still asserts shared/distinct
VM identity. It does not retain production history or weaken release behavior.

## Rollout and retained assets

Runs, leases, unsealed output and pending seals were drained before migration.
A private PG dump and configuration/inventory backup were saved under the ignored
runtime backup directory. Matching Control Plane, Workers and Web were deployed;
the bootstrap container was recreated from the new image.

Guest build inputs stayed at `e661c7d9d5798d4ef1f0761df29594163cb6da13`.
Cubelet and Guest templates were unchanged. [Final health](ordered-views-health-20261002.json)
records 16 healthy services, no active/unsealed fixture Runs or unpublished Outbox
records, the same generation-5 user VM, and all 174 original native rows unchanged.
The ordered full-row MD5 before/after is `3d5d7c8afb87d46da35e9b88714128d0`.
Owned acceptance Sessions/Workspaces and isolated test PG/Kafka were cleaned up.

## Limits

This is single-host functional/failure acceptance, not a multi-node capacity or
latency benchmark. Binding bootstrap currently bounds the global snapshot at
65,536 rows; watched queues, Subagent views and pending references have explicit
count/byte limits. Capacity pressure must recover from PG rather than discard
durable work. Admission failure under those limits is not proof of fleet scaling.

Shared Workspace/preview/global configuration caching remains outside this slice.
The deferred monitoring expansion and the separately discussed automatic VM
rebuild policy were not implemented here. Arbitrary shell effects remain subject
to the existing uncertainty boundary, without exactly-once claims.

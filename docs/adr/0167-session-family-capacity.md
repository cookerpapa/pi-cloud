# ADR-0167 — Session-family capacity and model-request fairness

Status: accepted and implemented.

Supersedes ADR-0124's per-Run lease allocation and ADR-0146's claim-derived
ownership/fixed child slots. Their historical versions remain in Git.

## Decision

A Worker slot means one active physical Pi Session (`tenantId/piSessionId`),
including main and all delegated Lanes. Human Forks remain separate families.
Idle browser history does not reserve capacity. The family is retained until
all its active Run executions drain; children do not compete for another root
slot. Remove the fixed parent/child split and the per-Root concurrent-child
admission rejection. Keep bounded tree depth and total descendants.

PostgreSQL remains the only durable scheduler. A Worker has one in-flight claim
probe, supplies its admitted family set/new-family allowance, and records the
claimed family before probing again. Its admission filter is also enforced on
fixed-ID claims. PG lease accounting and local Supervisor admission count
distinct physical Sessions. There is one durable owner lease per physical
Session and one monotonic Session epoch; heartbeats renew that row once, not
one lease/deadline per child. A RunAttempt is a task identity, not an owner.

The task execution reference carries the shared lease ID/epoch plus its Attempt
ID. It has no separate expiry or renewal. `run_attempts` retain task lifecycle
and release markers; a read-only `active_execution_scopes` projection joins those
records with the Session lease for executor authorization. No duplicate mutable
per-task lease table, compatibility decoder or new authority service remains.
The shared Session liveness watch is held by the native Session Host. Native
stream/Tool cancellation remains task-local; a quiet child is not a lost owner.

Task terminal seals close individual operations. An uncertain Session writer or
lost Session lease closes the shared incarnation; recovery waits for all affected
task closures to project before assigning the family elsewhere. A task cannot
launch new effects after cancellation merely because the Session lease is valid.
No lease, fence or ordered closure is replaced by a slot.

Model concurrency is a different, volatile concern: a bounded in-process
round-robin permit queue keyed by physical Session, with global and per-family
limits. A permit covers one provider request through stream completion, including
Compaction, and is released on error/cancellation. Waiting for tools, children or
supervisor input holds no model permit. Native context and semantic history remain
owned by the Harness/SessionStorage; the limiter stores neither transcripts nor
durable work. Queued requests are removed on abort and process shutdown.

Keep family/node limits and container memory limits explicit; admission can stop
new families at a soft memory watermark without deadlocking existing parents
waiting for descendants. A soft watermark cannot guarantee immunity from OOM.
Metrics distinguish active families, active Lane executions, model requests and
model-admission wait. KEDA counts the union of active, starting and ready physical
families, not all child Run rows. An already-owned family's backlog cannot be
moved to another Worker by scaling replicas.

This changes capacity, not recovery semantics. Lost Workers still require ordered
closure/projection before cold restore. Neither JavaScript workflow stacks nor
in-flight model connections are resumed from the append-only log.

The pre-release wire contract now uses `ExecutionReference`/`pcer1_` for task
attribution and family-only heartbeat records. New facts use the v8 Kafka topic.
Migration 137 requires drained leases/Runs/Outbox and released old full-VM
capsules; stop old execution services and deploy matching images. It preserves
PG semantic history and user/configuration data, with no legacy wire/capsule
decoder. A retired topic can be removed only after confirmed projection.

## Adopt before build

Reviewed [p-queue](https://github.com/sindresorhus/p-queue) and
[Bottleneck](https://github.com/SGrondin/bottleneck). They offer concurrency,
priority and grouped limits, but a plain FIFO/global queue does not provide our
per-family round-robin eligibility. Chained limiters can occupy one budget while
waiting for another. Adding a Redis job authority would duplicate the PG queue.
Retain PG scheduling; implement only the small abortable local permit adapter,
with fairness and cleanup tests. Pi's public stream/complete APIs remain intact.
[Node's event-loop guidance](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)
also distinguishes inexpensive I/O waits from serialization/CPU work; a shared
Session writer does not make many live model contexts free.

## Acceptance

Prove one-slot multi-Lane admission, independent-family capacity, final-Lane
release, duplicate claim handling, complete heartbeat renewal and reconciliation.
Prove fair model admission, per-family/global limits, aborted queued requests,
release on stream/Compaction failure, and parent-waits-child progress at a model
concurrency of one. Align Compose/Helm/KEDA and reject retired capacity settings.
Run paid multi-family, recursive coding and recovery checks, then remove only
acceptance resources while preserving users and configuration.

The one-host acceptance passed with two family slots/one model permit, a real
Worker SIGKILL/replacement, recursive delegation and browser-played Snake.
See [acceptance](../reports/session-family-acceptance.md) for the verified scope
and recovery limitations.

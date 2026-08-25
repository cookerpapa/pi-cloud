# ADR-0124: Opaque ExecutionGrant sequencer

## Status

Accepted on 2026-08-25. This supersedes the externally propagated
Attempt/Lease/Fencing tuple in ADR-0111 and ADR-0122; RunAttempt remains a
durable execution-history record, not a capability.

## Context

The original cloud protocol copied `commandId`, `runId`, `attemptId`,
`leaseId`, `fencingToken`, `sessionId` and `turnId` into every Worker event and
remote Tool assignment. Event Ingest then joined Run, Attempt, Command,
Session, Turn and SessionLease rows to reconstruct a fact the authority had
already established: which bounded execution currently owns this Session.

Those fields represented valid internal facts, but exposing them as one
security tuple made every consumer reproduce the authority state machine. It
also kept a six-table PostgreSQL query on the text-delta path.

Google Chubby addresses the same delayed-owner problem with a single opaque
sequencer containing the lock generation; recipient services validate the
sequencer or reject the request. Consul exposes the equivalent
`(Key, LockIndex, Session)` tuple, while etcd exposes a lease-bound unique lock
key and creation revision. All remain advisory until the protected resource
checks the grant. Adding another consensus service would therefore not remove
PiCloud's application-level validation and would create a second ownership
authority beside PostgreSQL.

## Decision

PiCloud exposes one `ExecutionGrant` string to trusted Workers and downstream
services. It is an unguessable, never-reused sequencer issued only by the
PostgreSQL authority. Its versioned payload carries a random grant ID, the
durable Run execution ID and an internal monotonically increasing generation.
Callers treat the complete string as opaque.

PostgreSQL table `execution_grants` is the sole current-execution authority. A
row binds the grant to tenant, Project, Workspace, Session, Run, Turn, Command,
Run execution, Worker sandbox and expiry. Acquisition is one transaction:

```text
lock Session + Run + RunExecution + Worker capacity
→ invalidate any expired current grant
→ increment Session execution generation
→ create a new random grant
→ bind it to the claimed RunExecution
→ reserve the Worker slot
→ commit
```

Heartbeat renews only `valid_until`; it does not mint a new grant or change the
generation. Replacement creates a different grant and higher generation.
Grant IDs are never reused. The old Worker can retain bytes in memory, but no
protected sink accepts them after the current row changes.

The trusted protocol uses `executionGrant` wherever ownership must be proven.
`attemptId`, `leaseId` and `fencingToken` are removed from Worker events,
heartbeats, command acknowledgements and Tool RPC assignments. Ordinary task
context may still carry Run, Session and Turn IDs because the Agent needs to
load those resources; they are not accepted as authority.

Every protected boundary performs one of these checks:

- Event Ingest locks matching `execution_grants` rows once per microbatch,
  validates Session/Turn and sequence, waits for R=3 PubAck, then advances the
  grant watermark before committing.
- PostgreSQL SessionStorage checks the current grant in the same transaction
  as each Pi mutation.
- Tool Broker resolves the grant to canonical assignment facts before creating
  or rebinding Cube; its per-activation capability remains the narrow Tool
  operation authority.
- terminal Run, Workspace and interruption settlement compare the current
  grant before committing effects.

RunAttempt is renamed conceptually to RunExecution in current documentation
and APIs where practical, but historical migrations and durable audit records
are not rewritten merely to hide their origin. It records retry/failure
history and is never itself accepted as a bearer capability.

## Token and trust boundary

The token prefix and embedded IDs are routing data, not the security proof.
Security comes from the random 122-bit grant ID, internal-service
authentication and exact comparison with the current PostgreSQL grant row.
The token is never included in model context, guest environment, logs, traces,
browser events or reports. Trusted Cube control metadata stores the decomposed
grant/execution/generation identity needed for orphan reconciliation, but it is
not mounted into the guest and does not bypass internal-service authentication.

An Ed25519 self-contained token is deliberately not used in this cutover.
Offline signature validation cannot provide immediate revocation without a
second current-generation projection or waiting for token expiry. The exact
PostgreSQL comparison preserves immediate takeover semantics. A future
measured need may project current grants into JetStream, but PostgreSQL remains
the sole issuer and a new Worker may not start before that projection barrier.

## Failure semantics

- Authority transaction rollback: no grant is issued and no Worker starts.
- Worker pause followed by replacement: the replacement grant differs and has
  a higher internal generation; old events and Tool requests are rejected.
- Heartbeat loss: the current grant expires and can be invalidated by the next
  acquisition/reconciler.
- Event Ingest crash after JetStream commit: stable event ID retry is
  deduplicated; the same grant may advance its watermark idempotently.
- Arbitrary Tool already started: revoking the grant does not undo the process;
  Broker terminates/quarantines the old activation or records `UNKNOWN` before
  admitting another writer.

## Consequences

The public trusted protocol has one ownership concept. PostgreSQL event
authority becomes a single indexed grant lookup instead of a six-table join.
The database still performs one transaction per authority microbatch because
that is the exact broker/fencing boundary; throughput must be remeasured after
cutover.

Consul, etcd, ZooKeeper and Kubernetes Lease are not added. They provide useful
lease/sequencer primitives but cannot atomically protect PostgreSQL,
JetStream, Cube and Workspace effects without the same recipient-side checks.

# ADR-0124: One durable Session lease with fencing

Status: accepted

## Context

A trusted Pi Worker may pause, lose its connection and resume after another
Worker has taken over the same Session. A time-bounded lease is required for
liveness, while a monotonically increasing fencing token is required to reject
the old Worker at every effect boundary.

PiCloud previously represented the same authority as an `ExecutionGrant` and
then asked Tool Broker to mint a second per-activation Tool capability. Tool
operations still queried PostgreSQL before starting, so the second bearer did
not remove the durable authority check. It made one Run appear to have two
independent authorities and kept extra owner-local secret state.

## Decision

PostgreSQL `session_leases` is the sole current-execution authority. Acquiring a
Run atomically:

1. locks the Session and current RunAttempt;
2. advances `sessions.last_fencing_token`;
3. creates a never-reused lease ID with `valid_until`;
4. binds the RunAttempt to that lease ID and fencing token; and
5. reserves one Worker slot.

The trusted Worker carries one versioned `ExecutionLease` string containing the
lease ID, Attempt ID and fencing token. It is never placed in model context,
the browser or Cube. Heartbeat extends only `valid_until`;
replacement creates a new lease ID and higher fencing token.

The same lease is presented at the three Run effect boundaries:

- one-time publication opening before Worker direct Kafka append;
- Tool Broker before an operation is durably marked running and injected into
  Cube; and
- Run settlement and Workspace control mutations in PostgreSQL.

Tool Broker no longer mints or persists a `pcts_*` capability. Its management
API still uses a machine service credential, while the Tool operation endpoint
uses the Session lease as its only Run authority. The Tool binding stores the
allowed Tool snapshot and frozen Turn/Attempt context; those are policy and
causal bindings, not additional credentials.

Kafka records carry the frozen execution scope; concrete Tool commands include
the lease identity for executor admission. Projector checks recorded scope and
opening/seal positions, not current wall-clock expiry. Native PG projection is
coordinated with seals rather than a lease that may legitimately expire after
Kafka ACK. There is no second channel lease or record signature.

## Failure semantics

- Missing heartbeat: the lease expires and no new effect may start.
- Replacement: a higher fencing token makes every old lease stale.
- Old Worker resumes: records after its seal cannot change any projection;
  Tool Broker and control-state commits reject its obsolete authority.
- Tool transport becomes ambiguous: the operation is `UNKNOWN`; arbitrary
  Shell is not replayed.
- Command was already running when the lease expired: takeover retires the old
  Tool binding and kills that process tree; it destroys the shared Workspace
  runtime only when process termination cannot be confirmed.
- Authority transaction rolls back: no lease is issued and no Worker starts.

## Consequences

There is one logical Run authority and one persisted monotonic fence. Tool
Broker restart no longer depends on an activation-local capability digest.
PostgreSQL remains on the Tool-start path, which is acceptable because Tool
operations are low-frequency and already require a durable operation ledger.
If renewal becomes material at much larger scale, PiCloud should introduce
hierarchical Worker-connection leases or a partitioned PostgreSQL lease
authority, not a second eventually-consistent lease store.

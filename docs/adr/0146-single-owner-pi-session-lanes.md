# ADR-0146: One active Worker owns every lane of a Pi Session

## Status

Accepted.

## Context

Pi Harness V2 defines a Session as one append-only Entry tree plus named Lane
pointers and per-Lane operation logs. Lanes may execute in parallel, but the
serving layer routes the whole Session to one Harness writer. The current
PiCloud runtime instead lets every product Run compete independently in the
global PostgreSQL queue. A delegated Child uses a Lane in its parent's physical
Pi Session, yet its Run can still be claimed by another Worker. PostgreSQL
transactions keep the stored tree valid, but Parent/Child communication,
in-memory state and recovery then require a second distributed coordination
model that Pi does not define.

The published Pi 0.84.1 runtime used by PiCloud, and the reviewed 0.84.4
release, expose SessionStorage, Entry DAG, Lane and operation-record contracts.
Their high-level AgentHarness execution methods still throw
`HarnessNotImplemented`. PiCloud therefore cannot replace its production Agent
Loop with the unfinished upstream class.

## Decision

- One live Worker identity owns all active Runs whose product execution scopes
  bind to the same `(tenant_id, pi_session_id)`.
- Ownership is derived from the existing live RunAttempt claims. The shared
  `pi_sessions` row is the serialization lock during claim. No second scheduler,
  affinity table or owner Lease is introduced.
- A Worker may claim a Run only when every unexpired active Attempt for the
  physical Pi Session has the same never-reused Worker boot identity. Different
  Lanes may run concurrently on that Worker; one product Session/Lane remains
  FIFO.
- Subagent creation still writes its durable execution, Turn and Run records,
  but only the owning Worker may claim that Child Run. The creating Worker
  immediately wakes its local Child capacity. Other Workers skip the Run rather
  than treating local preference as an optimization.
- Conversation and Child capacity are bounded separately. A Parent waiting for
  a Child does not consume the only capacity from which that Child could start;
  the existing Subagent tree concurrency limit remains the Child bound.
- Every Run keeps its existing ExecutionLease and fence for Pi mutations,
  Kafka admission and Tool Broker effects. Session ownership chooses the only
  process allowed to hold those concurrent per-Lane leases; it does not replace
  effect authority.
- When all active Attempts expire, another Worker may claim a Run for the same
  Pi Session. Existing ExecutionLease checks prevent the old Worker from
  committing after takeover.
- The Worker uses the current CloudAgentRuntime as the Lane execution adapter
  until Pi ships the complete AgentHarness. The adapter must remain behind the
  Session/Lane contract and must not grow a competing public Harness API.
- Human conversation Fork remains a new physical Pi Session and may be owned by
  a different Worker.

## Consequences

- Branch now means shared Session, shared active Worker and independent Lane;
  Fork means independent Session, ownership and lifecycle.
- Normal Parent/Child execution no longer needs cross-Worker routing. Durable
  supervisor rows remain recovery state until the unfinished upstream Harness
  can replace the current adapter; they are not evidence that another Worker
  may execute the Child.
- Scaling remains Session-level: different physical Pi Sessions spread across
  the Worker pool, while Lane concurrency handles one Session's parallel work.
- The common `pi_sessions` claim lock is brief. Model requests and Tool effects
  never hold it.
- A hot Session is bounded by one Worker. This matches Pi's design and is an
  intentional trade for one-writer recovery semantics.

# ADR-0111: Current Pi Cloud production architecture

## Status

Accepted on 2026-08-21. This ADR consolidates and supersedes every architecture
decision older than ADR-0104. Those development-stage ADRs remain recoverable
from Git history, not from the current documentation tree.

## Context

Pi Cloud passed through several valid experiments: local containers and gVisor,
Temporal orchestration, execution Cells, Worker affinity, JSONL/S3 Session
checkpoints, Kopia Workspace copies and a broad optional product API. Keeping
their ADRs beside the final implementation made mutually exclusive designs look
simultaneously active to people and repository-reading agents.

The maintained product needs one unambiguous account of its authorities,
execution path and failure semantics.

## Decision

### Durable authorities

- PostgreSQL is the sole product, Run queue and canonical Pi Session
  authority. It owns
  tenants, Sessions, Attempts, leases, fences, canonical completed Turns and
  Pi's native SessionStorage records.
- One persistent Cube Volume is the byte authority for a Workspace. PostgreSQL
  stores only its bounded settlement reference; user Git state
  remains inside the Volume.
- Kafka is the bounded AcceptedFact authority refined by ADR-0128. It is
  neither a second conversation transcript nor a Run scheduler.
- A live process tree exists only inside one Cube KVM. Process memory, sockets,
  PTYs and background processes are not durable after that Cube is destroyed.

### Scheduling and Agent runtime

- Every healthy Pi Worker competes for one shared PostgreSQL ready-Run queue.
  `LISTEN/NOTIFY` reduces wake-up latency; bounded polling preserves
  correctness. There is no Temporal scheduler, execution Cell or persistent
  Worker affinity. A newly created Child may race for an immediately free slot
  on its parent's Worker, then falls back to the shared queue without waiting.
- A transactional claim creates a RunAttempt and monotonically fenced execution
  authority. The recorded Worker identity is temporary ownership, never a
  routing preference.
- A Worker creates Pi's native `Agent` only for an active Run. It restores the
  newest compaction plus the active suffix from PostgreSQL SessionStorage,
  executes the Agent Loop and appends complete Pi messages incrementally.
  Cold Sessions retain no dedicated process and never download a lifetime
  JSONL transcript.
- Fork context uses copy-on-write Entry references plus a bounded per-Worker
  immutable-payload cache. Local Child placement can avoid retransferring the
  inherited payload; remote placement remains a normal PostgreSQL read.
- Pi remains responsible for model messages, Tool selection and compaction.
  Pi Cloud adds cloud admission, interruption/world-state facts, active steer,
  remote Tool routing and terminal settlement around Pi's public primitives.

### Tool and Workspace boundary

- The trusted Worker holds model credentials but never executes model-generated
  shell or file operations locally and never receives Cube management
  credentials.
- The Tool Broker validates the ExecutionLease, frozen Workspace/Turn/Tool
  bindings and operation identity. It then reconciles Cube through the Cube
  API. Models cannot choose runtime identity, mounts, resources or network
  policy.
- CubeSandbox KVM is the only untrusted Tool runtime. The guest receives the
  persistent `/workspace` mount and no platform credential. Public egress uses
  a deployment-owned proxy that rejects private, link-local, metadata and
  platform destinations.
- Cube activation is lazy and may remain warm according to Session policy. A
  fresh Cube attaches the same persistent Volume. Warm reuse is an optimization,
  not a correctness dependency.

### Event and recovery semantics

- Each active ExecutionLease owns one short PostgreSQL-leased logical Fact
  Stream. A Worker multiplexes all of its Streams over one long-lived WebSocket.
  Assistant text events and complete Pi Session mutations cross that connection
  without an intentional application batch and receive one R=3 PubAck each.
  Independent leases publish concurrently; one lease is ordered. Provider
  Tool-call JSON, thinking deltas and partial Tool output are not public events.
  There is no Worker disk WAL.
- Pi SessionStorage and the browser stream are independent projections. A
  Session-keyed projection barrier completes before a replacement Worker reads
  PostgreSQL; it does not wait for Gateway consumers.
  `message_end` submits a complete Pi message through the same PostgreSQL
  Authority Gate to the accepted Session mutation topic;
  the PostgreSQL projector applies it before the next model Step. Pi's ordered
  log stores stable identifiers and hydrates canonical entries/records on read.
- The browser sees only Facts durably accepted by Kafka after the authority
  decision. Gateway reconstructs incomplete Session tails in memory; reconnect
  receives a cursor-free PostgreSQL + live-tail replacement snapshot. Failed or
  cancelled visible text is settled into a
  bounded hidden Pi entry, so Worker replacement preserves both UI history and
  subsequent model context.
- Settlement stores the terminal event and metadata in PostgreSQL. Live events
  age out after the reconnect window; no second complete transcript is
  materialized.
- Queue delivery and event batches are at least once with idempotent/fenced
  commits. Arbitrary shell starts are not exactly once. An ambiguous Tool result
  becomes `UNKNOWN` and is never blindly replayed.
- Cancellation revokes authority before process termination. Stale Workers
  cannot mutate SessionStorage, start Tools, settle a Run or advance Workspace
  revision. Material execution-world changes are recorded as minimal
  model-visible interruption/reset facts.

### Scaling and deployment

- Control Plane, Pi Workers and Tool Brokers are independent
  replica sets. Worker replicas add Agent Loop slots; Cube compute adds Tool
  capacity. PostgreSQL/PgBouncer, persistent Workspace storage
  and Cube are external authorities in distributed deployment.
- KEDA may scale Workers from PostgreSQL ready-queue depth, but does not own
  delivery or retry semantics.
- The one-host profile is functional and self-contained; it is not an HA claim.

## Consequences

- One current ADR can be checked directly against the deployment manifests and
  source tree.
- A lost Worker or Cube can preserve committed conversation and Workspace files,
  but not an in-memory process world.
- Streaming durability uses a bounded retained Kafka log; PostgreSQL stores
  complete semantic Pi entries rather than provider-token rows.
- Removing the local WAL deliberately weakens "model generated" durability,
  but not "user observed" durability: unacknowledged bytes are invisible.
- Normal message persistence never sends a control signal to the live-stream
  projection. Stream inspection is reserved for exceptional hard-interruption
  reconciliation when no Pi `message_end` exists.
- Removing a scheduler, cache or warm runtime cannot change correctness as long
  as the three narrow durable authorities and fencing rules remain intact.
- New architecture components require measured need, a named authority boundary
  and an update to this ADR rather than an unindexed parallel design.

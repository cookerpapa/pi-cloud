# ADR-0129: Multiplex active Run facts over one Worker connection

## Status

Accepted on 2026-08-28.

## Context

Each active Run needs an independently authorized, ordered Fact Stream. The
first remote implementation represented that logical boundary as one physical
WebSocket per ExecutionLease. That preserved correctness, but made Worker and
Control Plane socket/file-descriptor count grow with active Agent Loops even
though all streams used the same service identity and ingest endpoint.

Kafka producers and HTTP/2 demonstrate the relevant separation: logical
records or streams retain independent identity and ordering while a bounded
number of physical connections carries them concurrently. PiCloud needs the
same transport property without giving Workers Kafka credentials or moving
ExecutionLease validation downstream of the Authority Gate.

## Decision

- One Pi Worker process owns one authenticated Worker Fact WebSocket to its
  configured ingest endpoint.
- Every active Run still owns one logical Fact Stream, identified by an opaque
  process-local `streamId`. Stream open binds its ExecutionLease, Session and
  Turn to a separate PostgreSQL Authority scope.
- Frames from different Streams may interleave on the physical connection.
  Each Stream permits one in-flight publication, retains its own event
  watermark and receives ACKs routed by `streamId`; different Streams publish
  to Kafka concurrently.
- A Stream close or non-retryable authority failure removes only that Stream.
  Other Runs on the Worker keep the same socket.
- A physical disconnect closes server-side channel ownership. The Worker
  reconnects once, then each still-active logical Stream independently reopens
  under its existing ExecutionLease. Authority replacement or expiry still
  fails closed.
- The Worker Control Channel remains separate. High-frequency accepted facts
  cannot create head-of-line blocking for registration, heartbeat, Steer or
  cancellation control traffic.
- Workers still have no Kafka credential or route. The Authority Gate remains
  the only CandidateFact acceptance boundary, and Kafka `acks=all` remains the
  browser-visibility durability boundary.

## Consequences

Physical Worker-to-ingest connection count now scales with Worker replicas,
not active Runs. Logical channel count, Lease renewal and per-Session ordering
still scale with active Runs because those are correctness state rather than
transport overhead.

One Worker socket is a shared availability path: a disconnect briefly makes all
its active Streams reopen. It does not merge their authority, ordering,
backpressure or failure state, and another Worker is unaffected.

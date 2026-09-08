# ADR-0158: bounded transport backpressure

Accepted and implemented, 2026-09-08.
[Acceptance](../reports/bounded-transport-acceptance.md).

Keep the existing authorities, two Pi semantic checkpoints, concrete Kafka Tool
commands and ephemeral HTTP result return. This is process-local flow control,
not another scheduler, tenant quota or Workspace lock. Broker routing and the
PostgreSQL read-your-writes barrier are measured, not redesigned here.

## Producer

Use the adopted Platformatic ProducerStream and Node Writable `drain` contract.
Each existing producer lane serializes writes only until the stream admits more
bytes; it does not serialize every Fact on its PubAck. Other lanes keep moving.
A process-local count/encoded-byte budget covers queued AND submitted Facts until
their Kafka ACK. Overflow rejects before enqueue, never reports durable success.
No unbounded secondary queue waits outside that budget. Delivery failure rejects
pending receipts; graceful close drains admitted writes, while a bounded close
failure never claims successful publication. Queue space and `drain` are not ACKs.

## Broker

Bound active operations independently from physical Cube allocations. Bound all
HTTP result readers, including duplicate readers of an already-running command,
and bound response bytes held until HTTP finish/close. Time out stalled sends only
after the result exists; legitimate long-running Tools keep their own deadline.
Disconnect removes its result waiter without killing the command. Seals reject
pending old readers; bytes already sent cannot be retracted, and Kafka's seal is
still the canonical/live cutoff. Result cache retirement and no-replay metadata
remain as in ADR-0157. Limits describe application buffers, not a hard RSS cap.

## Configuration and evidence

Producer defaults/loading are shared by embedded and standalone projection roles.
The AcceptedFact topic is one code-owned generation; remove Broker's unsupported
single-service topic override. Expose restart-bound limits through Compose/Helm
and document complete semantic checkpoints separately from command PubAck and PG
effect admission. Keep credentials and guest protocols unchanged.

Adopt Node [Writable buffering/backpressure](https://nodejs.org/api/stream.html#buffering)
and the pinned Platformatic stream rather than a new queue library. Node's
highWaterMark is a threshold, not a hard memory limit. Kafka
[delivery semantics](https://kafka.apache.org/41/design/design/#message-delivery-semantics)
remain distinct from application buffering and external Cube effects.

Validate stalled producers, independent lanes, overflow/recovery, duplicate IDs,
close/error while waiting for drain, stalled/disconnected HTTP readers, seals during
Tools and unchanged effects. Measure real Kafka and PG waits separately from model
time, then repeat paid multi-round coding and clean only acceptance-owned data.

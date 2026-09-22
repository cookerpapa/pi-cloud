# ADR-0158: bounded transport backpressure

Accepted and implemented, 2026-09-08.
[Current overload probe](../reports/transport-backpressure-acceptance-latest.json).

Keep the existing authorities, two Pi semantic checkpoints, concrete Kafka Tool
commands and the Kafka Tool replies in ADR-0183. This is process-local flow control,
not another scheduler, tenant quota or Workspace lock. Broker routing and the
native append acknowledgement boundary follow ADR-0161.

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

Bound active operations independently from physical Cube allocations. Capture
bounded output in the guest, drain its pipes, and bound reply Producer bytes
through Kafka ACK. The Worker holds only active invocation callbacks. Completion,
cancellation and Worker shutdown release those callbacks; late replies cannot
reopen them. There are no completed-result HTTP readers or response retry caches.
The guest's fixed Bash progress consists of replacement snapshots, so transport
backpressure may retain just the latest pending snapshot before final completion.
Limits describe application buffers, not a hard RSS cap.

## Configuration and evidence

Producer defaults/loading are shared by Workers and the Projector's control publisher.
The execution-log topic is one code-owned generation. Broker publishes native
replies to boot-scoped Topics using the adopted Kafka client. Expose limits through Compose/Helm
and document complete semantic checkpoints separately from command PubAck and PG
effect admission. Keep credentials and guest protocols unchanged.

Adopt Node [Writable buffering/backpressure](https://nodejs.org/api/stream.html#buffering)
and the pinned Platformatic stream rather than a new queue library. Node's
highWaterMark is a threshold, not a hard memory limit. Kafka
[delivery semantics](https://kafka.apache.org/41/design/design/#message-delivery-semantics)
remain distinct from application buffering and external Cube effects.

Validate stalled producers, independent lanes, overflow/recovery, duplicate IDs,
close/error while waiting for drain, missing/late reply consumers, seals during
Tools and unchanged effects. Measure real Kafka and PG waits separately from model
time, then repeat paid multi-round coding and clean only acceptance-owned data.

# ADR-0157 — Kafka-driven Tool commands

Status: accepted; implemented. See the [acceptance](../reports/kafka-tool-command-acceptance.md)
and [Cube execution-entry study](../reports/cube-execution-generation-study.md).

## Decision

Route Agent file/shell operation commands through the existing Worker Fact
connection, Authority Gate and Session-keyed Kafka log. Remove the public-to-
Worker direct operation POST path. Tool Broker consumes commands and invokes
Cube; the Worker only awaits the authenticated operation result and gives it
back to Pi, whose existing Tool-result checkpoint remains authoritative.
Human terminals, Preview, credentials and lifecycle APIs are unchanged.

Keep Pi's complete-model-output and validated-intent checkpoints. A command
publication is the durable transport for a concrete remote operation, not a
replacement for its parent Pi Tool intent (one Pi edit may perform several
remote operations). Measure the added transport ACK separately from model time.
Workers still have no Kafka credentials. Candidate commands carry their lease
only to the Gate; accepted commands contain canonical execution identity and
the destination binding, never a bearer token. Results do not create a second
PostgreSQL transcript or bypass Pi's redaction/checkpoint path.

Extract the existing Kafka consumer into a lightweight transport package shared
by Runtime Core and Broker. Do not import Agent Runtime/SessionStorage into the
Broker or implement another Kafka client. Keep Confluent/librdkafka partition
flow control and Platformatic production.

Bindings currently belong to one Broker boot. Each boot consumes the shared
log independently and executes only its own binding IDs; this avoids a second
dispatcher or a mutable partition-to-VM ownership ring. It does multiply Kafka
read traffic by Broker replicas and must be measured, not described as exclusive
global sharding. Readiness establishes the starting log position before any
binding can be created. In-process consumer reconnect resumes observed progress;
a replacement boot never replays commands for vanished bindings.
Broker is a trusted reader of the shared log, including non-command records;
the new access is never extended to a Cube guest or Pi Worker.

Tool work is detached from the partition handler so long Bash cannot hide its
seal or block other Sessions. Bound active work and tie result retention to the
binding lifetime, preserving exact operation-ID deduplication. A seal rejects
commands consumed after it. Work already handed to Broker admission may remain
UNKNOWN, even if actual process launch has not yet occurred.
Existing Broker/PG Lease, owner and operation checks remain for this stage.
Moving dispatch after Kafka does not make Cube calls transactional or physically
fenced. No automatic replay of unknown Bash or file effects is introduced.

## Evidence and acceptance

Kafka [delivery semantics](https://kafka.apache.org/41/design/design/#message-delivery-semantics)
distinguish a durable log from external effects; Kafka consumer ownership alone
cannot revoke an envd process request. Reuse the adopted clients and operation
ledger rather than add a workflow engine or another message bus.

Validate Gate scope/lease removal, Kafka-before-execution, duplicate delivery,
consumer reconnect, cancelled/sealed queued work, lost result connections,
Broker replacement, concurrent Sessions, native read/write/edit/bash semantics,
real multi-round coding and model-free command latency. Drain the old protocol
before deployment and remove the retired operation POST route, not retain it
as a fallback. Research final Cube execution-generation isolation separately;
do not claim or implement it implicitly as part of this transport change.

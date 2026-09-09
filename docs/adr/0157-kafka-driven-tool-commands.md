# ADR-0157 — Kafka-driven Tool commands

Status: accepted; implemented. See the [acceptance](../reports/kafka-tool-command-acceptance.md)
and [Cube execution-entry study](../reports/cube-execution-generation-study.md).

## Decision

Route Agent file/shell operation commands through the trusted Worker's execution
log and unified Projector ([ADR-0163](0163-direct-log-and-unified-projector.md)).
There is no Worker direct operation POST. Projector routes admitted commands to
the owning Tool executor, which invokes Cube; the Worker awaits its result and gives it
back to Pi, whose existing Tool-result checkpoint remains authoritative.
Human terminals, Preview, credentials and lifecycle APIs are unchanged.

Keep Pi's complete-model-output and validated-intent checkpoints. A command
publication is the durable transport for a concrete remote operation, not a
replacement for its parent Pi Tool intent (one Pi edit may perform several
remote operations). Measure the added transport ACK separately from model time.
Workers have private Kafka producer access. Logged commands contain canonical
execution identity and the destination binding, not a bearer header. Results do not create a second
PostgreSQL transcript or bypass Pi's redaction/checkpoint path.

Keep Kafka transport in the execution-log/Projector layer, not Tool Broker.
Do not import Agent Runtime/SessionStorage into the executor or implement
another Kafka client. Keep the adopted Kafka clients behind their ports.

Bindings belong to one Broker boot. [ADR-0162](0162-sharded-tool-command-routing.md)
defines positioned owner forwarding. A replacement boot never adopts vanished
bindings. Projector is the sole consumer; Cube never receives Kafka access.

Tool work is detached from the partition handler so long Bash cannot hide its
seal or block other Sessions. Bound active work and preserve exact operation-ID
deduplication. A seal rejects
commands consumed after it. Work already handed to Broker admission may remain
UNKNOWN, even if actual process launch has not yet occurred.
Existing Broker/PG Lease, owner and operation checks remain for this stage.
Moving dispatch after Kafka does not make Cube calls transactional or physically
fenced. No automatic replay of unknown Bash or file effects is introduced.

## Result delivery acknowledgement

Commands carry the native `toolCallId` outside the Cube request. One Pi Tool can
issue several concrete operations. Correlation uses the exact accepted execution
scope and Tool call ID, never output text. Only a native `toolResult` Entry in
an accepted Session mutation acknowledges semantic settlement; UI events alone
do not. Broker reads the PiCloud `tool.completed` event co-published in that same
Fact, not Pi Entry/Record internals. Consuming that fact retires the associated response
bodies without another HTTP ACK or PostgreSQL query. Error/UNKNOWN results are
terminal too; they do not necessarily prove receipt of every raw output byte.

Broker's execution map owns only in-flight operations. The executor is
the sole completed-result cache; after acknowledgement it retains lightweight
operation-ID/request-hash tombstones until binding retirement. Duplicate commands
cannot restart effects. Execution seals retire missing-result calls. Already
admitted work may finish after retirement but cannot repopulate the cache or
enter the sealed canonical stream. ADR-0158 removes pending readers on seal or
disconnect; already-transmitting responses may finish with their own references.
Neither grants new readers nor new publications after closure.

A total encoded-body byte budget bounds the completed-result cache. Overflow
sheds oldest retry copies, preserving in-flight readers and no-replay tombstones;
new readers without a retained copy receive an explicit unavailable outcome,
never an automatic effect retry. This bounds retention, not guest collection or
HTTP buffers. Raw results are not a second durable transcript.

Drain active Runs and update Worker/Projector/executor together. No guest protocol,
template or historical Session data rewrite is needed. ADR-0162 adds binding
route metadata; old Tool bindings are not adopted.

## Evidence and acceptance

Result lifetime follow-up: [acceptance](../reports/tool-result-retirement-acceptance.md).

Kafka [delivery semantics](https://kafka.apache.org/41/design/design/#message-delivery-semantics)
distinguish a durable log from external effects; Kafka consumer ownership alone
cannot revoke an envd process request. Reuse the adopted clients and operation
ledger rather than add a workflow engine or another message bus.

Validate publication scope, Kafka-before-execution, duplicate delivery,
consumer reconnect, cancelled/sealed queued work, lost result connections,
Broker replacement, concurrent Sessions, native read/write/edit/bash semantics,
real multi-round coding and model-free command latency. Drain the old protocol
before deployment and remove the retired operation POST route, not retain it
as a fallback. Research final Cube execution-generation isolation separately;
do not claim or implement it implicitly as part of this transport change.

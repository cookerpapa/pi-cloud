# ADR-0154 — Close execution streams in Kafka order before handoff

Status: accepted.

## Decision

Lease validation and Kafka append are not one atomic operation. A paused ingress
can publish an old assistant mutation after a replacement Worker has read its
context. Expiring the lease or killing the Worker does not retract that request.

Keep the authority gate and Kafka decoupled. The Run terminal transaction requests
an immutable `execution_seal` through the existing terminal Outbox. It identifies
the exact RunAttempt. Data and seals use the same Session key and a fixed Kafka
partition count. The first seal in partition order closes that execution stream.
Later records from that execution cannot change Pi SessionStorage or live output.

The canonical consumer applies semantic records preceding the seal, preserves any
visible interrupted text not already in Pi, then atomically records the seal and
the public terminal event. Its sequence follows the actual accepted events, not
the periodic lease progress report. Claiming another Run in that Session waits
for this projection. The Gateway uses the same closed-execution boundary and
publishes the terminal only after the canonical transaction has committed.

An ACK-lost seal may be appended again; the execution's first committed seal wins.
Closure metadata belongs to the durable RunAttempt and survives Kafka retention.
The existing durable prompt/control mailbox is unchanged. A delivered Steer is
not automatically treated as consumed or replayed. Pre-start retries have no
Agent output: the backend commits `started` before invoking the Runner.

Consumers that retain a volatile interrupted-prefix fold replay the bounded Kafka
log from its retained beginning on assignment/restart. They skip durably sealed
executions, deduplicate unsealed records, and verify the recorded first offset of
an unsealed execution has not been lost to retention. Committed consumer offsets
alone cannot restore this fold. Recovery beyond retention stops rather than
silently discarding visible output. This adds recovery scan cost, not PG delta
rows; incremental durable fold checkpoints require separate measured justification.

ADR-0155 supersedes the retained-beginning scan with a durable partition recovery
floor and positional seal classification. The seal and handoff invariants above
remain in force; the old boolean-only live cutoff is not the maintained path.

## Alternatives and limits

PostgreSQL Outbox/CDC for every fragment would make authority + append transactional
but restore the tiny-row write amplification deliberately removed here. Kafka
transactional producer fencing can fence producer generations, but is not a PG
Run authority or a Cube side-effect fence. The in-band seal is a bounded protocol
on adopted Kafka/PG, not another coordinator or broker.

Sources: [Kafka design](https://kafka.apache.org/41/design/design/),
[producer transactions and fencing](https://kafka.apache.org/41/javadoc/org/apache/kafka/clients/producer/KafkaProducer.html),
[Debezium Outbox](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html).

This closes the *message stream*, not running shell processes. Cube ownership,
physical process termination and uncertain external effects retain their existing
contracts; this does not promise exactly-once Bash or automatic Run replay.

## Cutover and verification

Stop/drain publishers before upgrading the protocol. Preserve canonical user data;
start a new bounded Kafka topic generation. Historical settled attempts are marked
closed by the additive migration. Never read old `terminal_event` records through
the new seal protocol or fall back to guessed terminal sequence numbers.

Verify: late assistant before/after seal; pending seal blocks a queued Run; partial
text is recoverable before handoff; duplicates and ACK loss; consumer restart and
rebalance; no late SSE output; exact terminal sequence despite stale progress;
independent lanes; actual API Follow-up/Steer with a killed DeepSeek Worker and a
paused ingress; retained user input and no automatic shell/Steer replay.

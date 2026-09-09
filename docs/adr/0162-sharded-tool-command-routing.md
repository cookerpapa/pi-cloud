# ADR-0162 — Sharded Tool consumption, owner-direct results

Status: accepted; implemented and [verified](../reports/tool-command-sharding.md).

## Decision

Keep physical Pi Session partition keys and the existing accepted log. Broker
replicas within a Sandbox Domain share one Kafka consumer group. Kafka owns
partition assignment and committed delivery offsets; no Workspace shard ring or
second command topic is introduced. Different domains use distinct groups because
their Cube authority and service credentials are separate.

Separate the Kafka router from the boot-local Tool executor. The router forwards
only concrete commands, native-result acknowledgements and execution closure to
the binding's owning Broker. It waits for synchronous admission of that log record,
not completion of the guest operation. Worker result GETs still go directly to
the owner returned by binding creation. No raw result travels through the router.

Persist immutable binding-to-Broker-boot routes before returning a binding to a
Worker. This is routing metadata, not a new execution authority. Routes cascade
with their RunAttempt. Cache positive per-Attempt routes; query all writer routes
at whole-writer closure so a newly added Lane is not omitted. A dispatcher restart
can rebuild routes without replaying the entire Session. No delta performs a route
query or forwarding RPC. Native-result forwarding excludes Pi messages/output.

Each internal delivery includes Kafka topic/partition/offset and the exact owner
boot. The executor folds deliveries synchronously and retains its applied
partition positions. Rebalance/retry duplicates and delayed lower offsets cannot
restart a command or cross a seal. Its existing operation-ID and PG effect checks
remain. A different boot rejects the delivery; it never adopts old Tool bindings.
Lost acknowledgements retry delivery of the same positioned record, not shell
execution. While an owner remains live but unreachable, only the affected Kafka
partition stalls. An expired/stopped owner is abandoned with UNKNOWN semantics.

The canonical safe-retention reaper, not this delivery group, protects unfinished
execution prefixes. A router offline past the reclaimed prefix resumes at the
current log start; those removed executions have already been closed/projected.
It never replays effects from a second store. An offset beyond the log end is an
error, not a silent reset. Canonical/native recovery keeps its stricter floor checks.

Use a Broker-only forwarding credential, not Worker/Control Plane service tokens.
The forwarding endpoint is not another Worker execution API. HTTP starts before
consumer readiness so concurrent startup/rebalance does not deadlock routers
waiting on one another. Existing effect admission remains PostgreSQL-authorized.

## Adopt before build

Reuse the pinned Confluent/librdkafka consumer group's assignment, offset commits
and partition flow control, and the existing Fastify HTTP server. Kafka's
[delivery semantics](https://kafka.apache.org/41/design/design/#message-delivery-semantics)
require downstream cooperation for external effects; its offset is not an
exactly-once Cube launch guarantee. The
[official JavaScript client](https://docs.confluent.io/kafka-clients/javascript/current/overview.html)
already provides the group/rebalance mechanism. The small owner adapter is specific
to PiCloud's independent Workspace and Session lifetimes.

## Cutover and acceptance

Drain Runs, deploy the schema and all Broker replicas together. Keep the accepted
Fact/Worker/guest protocols and templates unchanged. Remove the independent
whole-log-per-boot consumer path rather than retaining it as a fallback.

Test disjoint partition consumption, cross-owner command routing, owner-direct
large results, lost HTTP ACK, consumer rebalance/restart, stale boot, native result
retirement, whole-writer/single-Attempt seals and late completions. Verify real
Kafka before claiming sharding, then real model/Cube multi-round coding. Report
routing/Tool latency separately from model time and remove private test resources.

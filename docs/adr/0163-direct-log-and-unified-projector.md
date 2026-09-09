# ADR-0163 — Direct Worker log and unified Session Projector

Status: accepted; implemented and [verified](../reports/unified-projector-acceptance.md).
Publication signing was removed by [ADR-0164](0164-trusted-private-log-publication.md).
Supersedes the remote Fact ingress
and independent canonical/live/Tool consumer topology, not Cube effect semantics.

## Decision

Workers append directly to the existing Kafka transport. PostgreSQL remains the
only Run/Lease authority. Opening an execution binds one immutable publication
scope to that exact Attempt, Lane and native writer. An ordered opening record
precedes data. A Projector loads/caches scope and applies in-log seals; it never
rechecks wall-clock Lease expiry per token. Only the exact control-plane-requested
seal payload in PG is a valid control record. Kafka access is private and never
granted to Cube, browser or untrusted extensions. ADR-0164 removes cryptographic
origin checks under this trusted-Worker/private-infrastructure threat model.

Run opening/closing are authority operations, not a data gateway. Remove the
Fact WebSocket, its second channel lease/renewal/progress state and remote ACKs.
The Harness still sees append/acknowledge, not Kafka or projection internals.
Kafka ACK means durable append, not guaranteed application of a stale record.
After retirement, records physically after the seal cannot affect any projection.
Lease failure requests a seal; the next owner waits for its PG transaction.
Normal Lane completion closes that execution only; uncertain shared-writer loss
still closes its affected Lanes. No global comparison of unrelated Session fences.

One Projector consumer group owns the accepted log's physical-Session partitions.
Each record passes one admission/ordering boundary, then bounded modules apply
the native PG projection, live view and Tool command dispatch. Complete state
and PG recovery position commit together. A seal commits the interrupted prefix
and terminal, then announces it directly to the local live view: remove the
second execution-committed Kafka round trip and pending-notification buffers.
The partition handler does not wait for guest execution, only command admission.
PG or live-owner routing failure stalls that partition, not unrelated partitions.

Projector replicas advertise their HTTP endpoint in Kafka group membership.
Session SSE requests are served by the assigned Projector; another API replica
proxies the authenticated request to that owner. No second partition authority,
browser cursor, cache cluster or stream-reading gateway is introduced. Rebalance
invalidates old subscriptions and rebuilds unsealed tails before serving snapshots.

Replay starts no later than PG's canonical/unsealed-prefix floor and the group's
completed delivery position. Fetching is not acknowledging. Duplicate native
projection is idempotent; owner Tool admission keeps exact operation IDs and
positioned no-replay semantics. Tool execution remains an external effect, not a
replayable materialized view. Already-admitted guest work may remain UNKNOWN.
The existing owner-direct raw-result path and Cube lifecycle interfaces remain.

## Adopt before build

Reuse Kafka/librdkafka group membership, ordered partitions, delivery checkpoints
and the existing producer, HTTP server and Pi SessionStorage adapter. Ordinary
Kafka ACLs protect transport access, not arbitrary JSON Session/epoch fields;
the deployment trusts its producers. Publication scope is cached; no per-token
authority SELECT or remote admission service remains.

References: [Kafka delivery semantics](https://kafka.apache.org/41/design/design/#message-delivery-semantics),
[Confluent JavaScript client](https://docs.confluent.io/kafka-clients/javascript/current/overview.html).

## Cutover and verification

Drain Runs and fully project seals before deployment. Move to a new code-owned
topic and remove old transport entry points/configuration rather than support
mixed protocols. Preserve PG semantic history and user Volumes; no user-data
reset is necessary for the additive publication metadata.

Verify scope rejection; opened/sealed ordering; normal versus shared
writer closure; partial-output reconstruction; failures before/after PG commit;
lost delivery ACK and replay; cross-replica SSE; effect deduplication and UNKNOWN;
multi-Lane/provider/Compaction contracts; paid multi-round Cube coding; model-free
publication and projection latency. Keep aggregate evidence and remove generated
test resources. Do not claim Kafka is the only system store or exactly-once shell.

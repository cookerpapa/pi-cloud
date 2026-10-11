# ADR-0209: control-plane publication and sandbox authority

Status: deployed and verified, 2026-10-01.
[Production acceptance](../reports/cube-execution-rollout-20261001.md).
Accepted by the owner after the review.
This supersedes ADR-0163's direct Worker producer and the independent Tool Broker
responsibilities. It does not restore historical FactChannel leases, projection
receipts, signatures or a second Run authority. Implementation proceeds in
complete, separately verified slices; the deployed topology changes only at the
matched cutover.

## Decision

PostgreSQL remains the sole authority for Run and physical-Session ownership.
The original one-execution-per-Run clause is superseded by
[ADR-0229](0229-native-durable-runtime.md): an interrupted logical Run may resume its
native pending task only after ordered old-owner closure and a fresh PG grant.
RunAttempt stays removed; a restored native task does not authorize itself.
Pi, native stamping, after-Tool processing and model context remain in the Worker.
The deployment treats its infrastructure as trusted private services.

The control plane owns three bounded modules: publication admission, the existing
Session Projector/tool dispatcher, and sandbox lifecycle management. These are
modules in the existing service, not three new services or schedulers.

### Publication

- Workers submit records to one control-plane publication owner per Kafka
  partition. Physical Session ID remains the immutable partition key; all of its
  Lanes share a writer. The existing Projector consumer-group assignment supplies
  ownership and routing. Do not add a second PG channel lease.
- Control-plane admission installs a recorded Run/publication scope once. The
  publication module caches that scope and its open/closing/closed state. Ordinary
  appends check this memory, without a PG query or lease renewal. Unknown scopes
  cannot open themselves by presenting a larger epoch. PG/control recovery runs
  at admission, closure and ownership replacement, outside the append hot path.
  Registration may reject an already-known stale or closed identity before the
  PG read. This negative check grants no authority: all potentially successful
  registrations still verify PG, then recheck memory and the admission ticket.
- A closure immediately stops new admission for its Run, or every Lane of a failed
  writer. It drains already accepted appends before publishing the seal through
  the same partition writer. New ownership still waits for all required seals to
  be projected. A successful Worker reply means Kafka durable commit, never just
  acceptance into an in-memory queue.
- Use stable Kafka transactional producer identities per publication partition
  to fence an old publication service after reassignment/restart. Reuse pinned
  Confluent/librdkafka transaction APIs. Consumers use read-committed isolation;
  recovery/catch-up must handle transaction-control offsets and aborted batches.
  Publication transactions also include the current consumer-group metadata,
  preventing a delayed old ingress initialization from committing after reassignment.
  They retain the current dispatch offset under the same per-partition commit guard;
  publication never advances or regresses the independent effect-dispatch boundary.
  Producer ownership is transport fencing, not a replacement for PG Run authority.
- Bound pending records/bytes and per-partition batches. No transaction or PG lock
  spans a network write. Failed/uncertain delivery is not permission to rerun an
  Agent or shell operation. A native append with uncertain commit retires its
  original writer; a proven pre-admission rejection retains its existing semantics.
- The Projector keeps canonical replay, idempotency, recovery floors and the
  commit-before-effect boundary. Source admission removes duplicate live ownership
  decisions downstream; historical closure metadata is still needed for recovery.
  Do not confuse valid historical intent with permission to start a cancelled Tool.

### Sandbox and Tool execution

- The control plane chooses, creates, reuses, observes, quarantines, destroys and
  recreates Cube runtimes. The adapter reports typed physical/execution observations
  and performs requested mechanics; a Tool transport catch must not silently make
  a whole-VM destruction decision.
- Cube lifecycle state, node availability, guest execution readiness and individual
  Tool state are distinct. Correct or bypass the upstream CubeAPI mapping that
  labels unknown/stopped states as running through a pinned, explicit adapter.
  A missing heartbeat alone does not prove physical death or termination.
  Upstream's `status` is the main execution container's state, not an assertion
  that the VM process has disappeared. Preserve running/paused/pausing/stopped/
  error/unknown and retain the reported Cube node identity. A stopped execution
  container may require VM cleanup, but cannot itself release VM quota.
- Observation of absence must address the recorded full Sandbox ID on its known
  node. A missing master route, unhealthy/missing node, failed RPC or metadata
  recovery gap means unavailable. Only a successful exact node lookup with no
  retained runtime metadata can establish absence under Cube's deletion contract;
  a partial cluster listing is never sufficient. VM cleanup still requires an
  explicit control-plane lifecycle decision and confirmed completion.
- Implement a Cube-side execution handoff before removing long execution ownership
  from the control plane. Fixed whole Tools remain in the guest; a trusted Cube-side
  completion adapter owns bounded final-result delivery to the original Worker boot.
  The handoff and cancellation contract includes operation identity and physical
  runtime identity, not merely receipt of HTTP bytes. It may retry a result but
  never restart arbitrary shell work after ambiguous completion.
- Preserve image claim check and Worker canonical after-hooks. No inline large
  Kafka images, completed-result GET cache or PG Tool operation ledger is added.
  Define and verify the guarantees across dispatcher loss, executor loss and node
  loss separately; a volatile exit-code map cannot claim durable result recovery.
- Move Tool dispatch into the Projector's control-plane composition once handoff
  is concrete. Migrate terminal, preview, uploads, machine adoption and workflow
  channels before deleting independent Broker deployment/routes/boot ownership.
  The Kafka handler waits for bounded handoff, not the duration of a Bash command.
- Shared-VM normal Tool errors affect the operation. Scoped cancellation must prove
  its execution scope stopped before claiming other users are unaffected. Whole VM
  loss affects all bound users; uncertain stopping triggers explicit control-plane
  quarantine/cleanup policy. User-owned machines retain explicit release semantics.
- Existing log-path probes remain observations. Guest/node health uses bounded
  management observation, not per-probe history writes or another execution lease.

## Adopt before build

Reuse PostgreSQL transactional admission, the existing Kafka consumer group and
pinned Confluent Kafka JavaScript 1.10.1/librdkafka producer fencing, transactions
and offset APIs. Kafka documents stable transactional IDs and producer epochs:
[producer contract](https://kafka.apache.org/41/javadoc/org/apache/kafka/clients/producer/KafkaProducer.html),
[Confluent client](https://docs.confluent.io/kafka-clients/javascript/current/overview.html).
The existing KafkaJS wrapper does not expose processed EOF/position evidence;
use its pinned client's public native consumer port if needed for committed-log
catch-up, rather than infer completion from timers or telemetry statistics.

The [Cube/E2B/OpenSandbox comparison](../reports/cube-result-delivery-study-20261001.md)
found no complete trusted-host Tool handoff/Kafka result contract. Retain Cube as
backend. Any bounded Cube extension must be isolated, pinned, licensed and tested
through the PiCloud-owned adapter; do not silently upgrade or substitute runtimes.
A generic workflow engine or another broker would duplicate existing authorities.

The historical [late publisher experiment](../reports/late-publisher-findings.md)
proved that checking authority before an asynchronous send is insufficient. The
new ingress must serialize closure and fence its own replaced producer as well.

## Acceptance and cutover

Prove queued/late/duplicate publication, lost ACK, old publisher pause/resume,
consumer reassignment, aborted transactions and control-only Kafka tails. Measure
append-path PG queries (zero) and latency. Preserve per-Lane/native ordering and
unrelated Session progress within the stated partition failure boundary.

Prove actual Cube state mapping, guest/VM/node failure distinctions, operation
cancellation with a second Session's web server surviving, confirmed absence
before quota release, dispatcher restart after handoff, result publication retry,
late replies after seal and workflow/terminal/preview/upload continuity.

Update protocol, topology, deployment and install contracts together. Drain and
seal the old protocol, preserve PG/native history and Volumes, start the new log
wire generation and remove superseded runtime/configuration paths. Do not retain
mixed-version production fallbacks. Record isolated and live acceptance separately.

# Implementation roadmap

## Completed foundation

- multi-tenant Web Coding Agent using Pi SDK;
- PostgreSQL Run/Attempt state, leases/fences and same-Session ordering;
- one shared, horizontally scalable PostgreSQL-backed Pi Worker queue;
- official Pi `SessionRepo`/`SessionStorage` PostgreSQL adapter with
  compaction-bounded reads and upstream backend conformance;
- R=3 JetStream resumable SSE with PostgreSQL canonical terminal Turns;
- CubeSandbox KVM-only Tool execution;
- persistent Cube Volumes as Workspace byte authority;
- lazy/bounded-warm elastic Cubes plus explicit user-owned development machines;
- Kubernetes/KEDA deployment with PostgreSQL backlog scaling;
- one-host installer, configuration UI and real Cube/model acceptance.
- human Pi Session tree navigation and transactional conversation forks.
- Run-scoped built-in Tool capability snapshots enforced independently by the
  Agent Host and Tool Broker.
- user-owned exclusive Cube development environments with pause/resume,
  full-VM rootfs/process persistence, restart adoption, root terminals, fenced
  Agent handoff and one-time SSH access;
- Session/Workspace lifetime independence with missing-Workspace rebinding;
- committed RePublish with one Core NATS subscription per Gateway and no replay cache;
- one ExecutionGrant Authority Gate and Session-keyed PostgreSQL projection barriers.
- short-leased per-ExecutionGrant FactChannels with no Agent-event
  application batching delay and one R=3 PubAck per visible event.

## Current release gate

- [x] Remove Temporal and the duplicate Outbox handoff scheduler.
- [x] Remove execution Cells and Worker affinity queues.
- [x] Remove MinIO/S3 checkpoint runtime and Kopia Workspace copies.
- [x] Make PostgreSQL SessionStorage the production Pi conversation authority.
- [x] Attach the same Workspace Volume across Cube activations and conversations.
- [x] Enforce Agent events and Pi Session mutations at one PostgreSQL Authority Gate.
      before their accepted JetStream PubAck.
- [x] Replace the full Harness experiment with a thin runtime composed from
      Pi Agent, SessionStorage and compaction primitives.
- [x] Remove lifetime JSONL download/restore from the production Worker path.
- [x] Update Compose and Helm/KEDA to the new topology.
- [x] Complete full CI for the production cutover.
- [ ] Repeat the clean one-host installer on a fresh machine.
- [x] Re-run token-consuming multi-round chat/coding, native Compaction,
      cross-Worker recovery and Cube restart acceptance.
- [x] Expose focused/full Pi Session trees and fork settled assistant responses
      without making tree control model-visible.

## Next reliability work

- run Worker, Control Plane, PostgreSQL connection and Cube loss injection on a
  multi-node cluster;
- validate Tool Broker and persistent Volume gateway replacement under load;
- publish PostgreSQL queue latency and Worker slot-density measurements;
- validate JetStream ingest/replay and PostgreSQL semantic projection at target load;
- define Workspace snapshot/backup policy separately from normal Run commits;

Every performance or availability claim must name the tested revision,
topology, workload and observed result.

# Implementation roadmap

## Completed foundation

- multi-tenant Web Coding Agent using Pi SDK;
- PostgreSQL Run/Attempt authority, same-Session ordering and shared Worker queue;
- Pi `SessionRepo`/`SessionStorage` PostgreSQL adapter with native Compaction;
- one FactChannel and PostgreSQL Authority Gate for Agent events and Pi mutations;
- Kafka `acks=all` AcceptedFact log keyed by Session;
- rebuildable Gateway live tails and cursor-free snapshot-first SSE;
- CubeSandbox KVM-only Tool execution and persistent Workspace Volumes;
- bounded-warm elastic Cubes and user-owned development machines with SSH;
- conversation trees, Fork, Steer, recursive Subagents and Workspace rebinding;
- Compose one-host deployment and Kubernetes/KEDA manifests.

## Current release gate

- [x] Remove JetStream, browser cursors and replay-specific Gateway state.
- [x] Keep PostgreSQL as canonical product/Pi Session authority.
- [x] Keep Kafka as the only AcceptedFact durable append log.
- [x] Ensure terminal messages unload covered Gateway fragments without racing
      in-flight immutable snapshots.
- [x] Run full deterministic tests and real model/Cube multi-round acceptance.
- [ ] Validate Kafka broker, canonical projector and Gateway process loss under
      concurrent active Runs.
- [ ] Repeat the clean one-host installer on a fresh machine.
- [ ] Validate autoscaling and persistent storage on at least three physical nodes.

Every performance or availability claim must name the tested revision,
topology, workload and observed result.

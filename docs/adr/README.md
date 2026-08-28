# Current architecture decisions

This directory contains only decisions that constrain the maintained Pi Cloud
product. Superseded experiments and pre-release decisions are intentionally not
kept beside current ADRs; Git history is their archive.

Read the documents in this order:

1. [ADR-0131](0131-run-table-postgres-queue.md) — Run as the only PostgreSQL
   execution queue, typed Cancel/Steer control requests and terminal-only Outbox.
2. [ADR-0130](0130-user-managed-workspace-concurrency.md) — same-Session FIFO
   with user-managed concurrency across Sessions, terminals and shared files.
3. [ADR-0129](0129-multiplexed-worker-fact-connection.md) — one physical Fact
   connection per Worker with independently authorized logical Run Streams.
4. [ADR-0128](0128-kafka-soft-state-session-gateway.md) — Kafka AcceptedFact
   durability, rebuildable Gateway hot tails and cursor-free snapshot-first SSE.
5. [ADR-0127](0127-authority-gate-and-accepted-fact-bus.md) — one
   ExecutionLease Authority Gate, one logical per-Run FactChannel and a
   broker-neutral AcceptedFactBus before independent downstream projections.
6. [ADR-0124](0124-session-lease-fencing-authority.md) — one durable Session
   lease with a monotonically increasing fence across every Run effect boundary.
7. [ADR-0123](0123-isolated-preview-origins.md) — target-scoped capabilities
   and independent browser origins for untrusted application Preview.
8. [ADR-0120](0120-exclusive-full-vm-authority.md) — exclusive Cube full-VM
   state, restart adoption and the elastic/exclusive durability split.
9. [ADR-0118](0118-session-workspace-environment-and-ssh.md) — independent
   Session/Workspace/compute lifetimes, exclusive Cube handoff and SSH access.
10. [ADR-0111](0111-current-production-architecture.md) — current end-to-end
   architecture, state authorities and scaling boundary.
11. [ADR-0112](0112-run-scoped-tool-capabilities.md) — Session grants, immutable
   Run Tool snapshots and Broker-side execution authorization.
12. [ADR-0113](0113-cloud-native-pi-subagents.md) — upstream-compatible Pi
   subagents on durable Child Sessions/Runs with explicit Workspace modes.
13. [ADR-0114](0114-conversation-subtree-delete-and-tail-prune.md) — recursive
   tree deletion and Pi-native conversation tail pruning.
14. [ADR-0115](0115-user-owned-development-environments.md) — tenant-aware,
   user-owned exclusive Cube development environments.
15. [ADR-0109](0109-postgres-session-reference-checkpoints.md) — PostgreSQL Pi
   SessionStorage as the sole conversation authority.
16. [ADR-0105](0105-pi-session-backend-conformance.md) — compatibility with Pi's
   public Session backend contract.
17. [ADR-0104](0104-human-session-tree-and-conversation-forks.md) — human tree
   navigation and conversation forks.
An ADR absent from this index is not part of the current design. Historical
migration source may contain retired table or component names solely so a new
database can replay the ordered migration chain.

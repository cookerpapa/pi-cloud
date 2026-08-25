# Current architecture decisions

This directory contains only decisions that constrain the maintained Pi Cloud
product. Superseded experiments and pre-release decisions are intentionally not
kept beside current ADRs; Git history is their archive.

Read the documents in this order:

1. [ADR-0125](0125-postgres-authority-before-jetstream.md) — PostgreSQL-only
   Authority checked before both JetStream accepted logs and set-oriented
   heartbeat renewal.
2. [ADR-0124](0124-opaque-execution-grant-sequencer.md) — one opaque,
   never-reused ExecutionGrant across Worker, events, SessionStorage and Tools.
3. [ADR-0123](0123-isolated-preview-origins.md) — target-scoped capabilities
   and independent browser origins for untrusted application Preview.
4. [ADR-0122](0122-jetstream-event-authority.md) — R=3 JetStream, batched
   Run capability validation, committed live fanout and Session mutation projection.
5. [ADR-0120](0120-exclusive-full-vm-authority.md) — exclusive Cube full-VM
   state, restart adoption and the elastic/exclusive durability split.
6. [ADR-0118](0118-session-workspace-environment-and-ssh.md) — independent
   Session/Workspace/compute lifetimes, exclusive Cube handoff and SSH access.
7. [ADR-0111](0111-current-production-architecture.md) — current end-to-end
   architecture, state authorities and scaling boundary.
8. [ADR-0112](0112-run-scoped-tool-capabilities.md) — Session grants, immutable
   Run Tool snapshots and Broker-side execution authorization.
9. [ADR-0113](0113-cloud-native-pi-subagents.md) — upstream-compatible Pi
   subagents on durable Child Sessions/Runs with explicit Workspace modes.
10. [ADR-0114](0114-conversation-subtree-delete-and-tail-prune.md) — recursive
   tree deletion and Pi-native conversation tail pruning.
11. [ADR-0115](0115-user-owned-development-environments.md) — tenant-aware,
   user-owned exclusive Cube development environments.
12. [ADR-0109](0109-postgres-session-reference-checkpoints.md) — PostgreSQL Pi
   SessionStorage as the sole conversation authority.
13. [ADR-0105](0105-pi-session-backend-conformance.md) — compatibility with Pi's
   public Session backend contract.
14. [ADR-0104](0104-human-session-tree-and-conversation-forks.md) — human tree
   navigation and conversation forks.
15. [ADR-0107](0107-remove-dormant-advanced-api.md) and
   [ADR-0108](0108-workspace-api-matches-the-file-browser.md) — deliberately
   removed product surface.
16. [ADR-0110](0110-pi-cloud-product-identity.md) — the clean Pi Cloud identity.

An ADR absent from this index is not part of the current design. Historical
migration source may contain retired table or component names solely so a new
database can replay the ordered migration chain.

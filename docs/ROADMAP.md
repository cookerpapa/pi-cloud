# Implementation roadmap

## Completed foundation

- multi-tenant Web Coding Agent using Pi SDK;
- PostgreSQL Run/Attempt authority, same-Session ordering and shared Worker queue;
- Pi `SessionRepo`/`SessionStorage` PostgreSQL adapter with native Compaction;
- one multiplexed Fact connection per Worker, logical per-Run Streams and a PostgreSQL Authority Gate;
- lossless PostgreSQL queue wake-up and background fail-closed execution-plane readiness;
- Kafka `acks=all` AcceptedFact log keyed by Session;
- rebuildable Gateway live tails and cursor-free snapshot-first SSE;
- CubeSandbox KVM-only Tool execution and persistent Workspace Volumes;
- bounded-warm elastic Cubes and user-owned development machines with SSH;
- same-Session FIFO, concurrent cross-Session Agent Loops and one Workspace-owned
  Cube with independently fenced concurrent Tool bindings;
- Broker-independent development-machine runtime with running-state-preserving takeover;
- conversation trees, Fork, Steer, recursive Subagents and Workspace rebinding;
- Compose one-host deployment and Kubernetes/KEDA manifests;
- non-exclusive GitLab Issue claims and private-project
  Issue-to-Run execution choices;
- ordinary user-owned Git worktrees with user-directed commit, push and
  provider delivery;
- versioned Agent definitions with Run/Worker routing and Runtime-native Session Storage.
- Provider-native Web Search on the verified OpenAI Codex and DeepSeek Responses routes,
  frozen with each issued model runtime, retained as Codex-shaped Pi transcript
  items and kept outside Tool Broker.
- Provider → model → reasoning selection with GPT request-scoped Fast mode,
  Session desired settings and immutable Turn snapshots.
- composer-level cascading Provider/model/reasoning selection, with new Web
  conversations starting on GPT-5.6 Sol, medium reasoning and Standard service.
- role-free neutral Subagents with explicit task/context/Workspace/Tool settings
  and lazy Cube activation on the first local Tool call.
- Codex-style per-call Hosted Web Search activity for GPT and DeepSeek, plus
  stable-region Markdown rendering for citation-heavy streams.

## Current release gate

- [x] Remove JetStream, browser cursors and replay-specific Gateway state.
- [x] Keep PostgreSQL as canonical product/Pi Session authority.
- [x] Keep Kafka as the only AcceptedFact durable append log.
- [x] Ensure terminal messages unload covered Gateway fragments without racing
      in-flight immutable snapshots.
- [x] Run full deterministic tests and real model/Cube multi-round acceptance.
- [x] Validate Kafka broker and combined canonical/Gateway process loss during
      an active Run without creating a second Attempt.
- [ ] Repeat the clean one-host installer on a fresh machine.
- [ ] Validate autoscaling and persistent storage on at least three physical nodes.

Every performance or availability claim must name the tested revision,
topology, workload and observed result.

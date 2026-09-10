# Implementation roadmap

## Completed foundation

- multi-tenant Web Coding Agent using Pi SDK;
- PostgreSQL Run/Attempt authority, same-Lane ordering, physical Pi Session
  Worker ownership and shared Worker queue;
- Pi `SessionRepo`/`SessionStorage` PostgreSQL adapter with one self-contained
  append-only semantic log per physical Session and native Compaction;
- direct Worker append under a PG-issued publication identity;
- lossless PostgreSQL queue wake-up and background fail-closed execution-plane readiness;
- Kafka `acks=all` AcceptedFact log keyed by Session;
- one partitioned Session Projector group and cursor-free snapshot-first SSE;
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
- owner-local Lane-bound Subagents sharing one durable Pi Session Entry DAG
  without per-Entry inherited-context references.
- Codex-style per-call Hosted Web Search activity for GPT and DeepSeek, plus
  stable-region Markdown rendering for citation-heavy streams.

## Current release gate

- [x] Internal conversation/admission module boundaries, shutdown admission
      regression and unified-Projector handoff tests; no new service or protocol.
- [ ] Roll out this consolidation after restoring the deployment disk-headroom
      minimum; [verification and rollout status](reports/architecture-consolidation-20260910.md).

- [x] Idempotent opening recovery, real Child detail reads, message-level display
      coverage, framed snapshots and the maintained CI fault gate (ADR-0165).
- [x] Remove per-record signatures for trusted private deployment; keep PG opening,
      scope and ordered seal checks (ADR-0164).
- [x] Unify native history, live views and Tool routing in one Projector group;
      keep executor results owner-direct and remove Fact Gateway/channel leases.
- [x] Replace per-Step PG receipts with Kafka-acknowledged native Session writes;
      retain bounded cold restore and exact asynchronous PG projection.
- [x] Complete paid model/Cube, interrupted-prefix and process-fault acceptance
      for the native append cutover; [evidence](reports/kafka-native-session-cutover.md).
- [x] Bound Producer/Broker transport under slow downstreams, align capacity
      configuration and measure native publication independently from model time.

- [x] Reuse native Kafka Tool Results as raw-response delivery acknowledgements;
      retire the duplicate execution cache and preserve no-replay semantics.

- [x] Route Agent Tool commands from the Kafka Projector to Broker; retain native Session
      checkpoints, result redaction, duplicate protection and explicit UNKNOWN.
- [x] Commit the seal/terminal once and update the local view directly;
      preserve successor ordering without a second Kafka notification.
- [x] Use positioned execution seals, demand-driven partition tails and bounded
      recovery offsets; remove the shared consumer queue and free-Slot claim storms.
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

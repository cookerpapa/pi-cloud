# Implementation roadmap

## Completed foundation

- multi-tenant Web Coding Agent using Pi SDK;
- PostgreSQL Run authority, same-Lane ordering, physical Pi Session
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
- role-free neutral Subagents with explicit task/context/compute/cwd/Tool settings
  and lazy Cube activation on the first local Tool call.
- owner-local Lane-bound Subagents sharing one durable Pi Session Entry DAG
  without per-Entry inherited-context references.
- Codex-style per-call Hosted Web Search activity for GPT and DeepSeek, plus
  stable-region Markdown rendering for citation-heavy streams.

## Current release gate

- [ ] Ephemeral Tool log preview via Broker HTTP → Projector SSE; final-only
      Kafka replies, no observation history or background-service log follower.

- [x] Source-side whole Pi Tool execution, native Kafka replies and monotonic
      commit-before-dispatch; no result GET/cache or PG operation ledger.
      [Luna/Cube, Subagent, browser and crash acceptance](reports/native-remote-tools-acceptance-20260924.md).

- [x] Provider-phase-aware assistant display: complete GPT commentary, streaming
      final answers and native-history/reconnect consistency. DeepSeek remains
      unclassified until its early phase contract is reliable.
      [Real Luna/Sol/DeepSeek, Cube and browser acceptance](reports/assistant-phase-acceptance-20260921.md).

- [x] Model Gateway upload revocation/count admission, HTTP-only Steer, dormant
      accounting removal, concrete runtime package boundaries and fewer projection/
      environment SQL exchanges. [Regression and real GPT/Cube acceptance](reports/review-repair-20260921.md).

- [x] One Run execution identity, Session-lease native writer and Worker-local
      capacity; ordinary input/admission SQL reduced from 24 to 18 exchanges.
      [Migration, real Luna/Cube, child-Lane and process-fault acceptance](reports/run-identity-acceptance-20260919.md).

- [x] Durable Lane readiness and bounded family closure; consolidate admission
      from 41 to 24 SQL exchanges, preserving atomic authority and ordered seals.
      [Real Luna/Cube, child-Lane, cancellation and process-fault acceptance](reports/ready-admission-20260919.md).

- [x] Atomic admitted/running state and first-record recovery without a standalone
      opening; [real Luna/Cube comparison, shared-Lane and process-fault acceptance](reports/first-record-admission-20260919.md).

- [x] Precompiled server event validation with unchanged rules/errors and strict
      browser CSP; [Kafka comparison and real Luna/Cube acceptance](reports/compiled-validation-acceptance-20260919.md).

- [x] Commit-triggered seal relay wake-up and transaction-local settlement SQL;
      [matched real-Luna comparison and failure checks](reports/terminal-wake-acceptance-20260918.md).

- [x] Bounded Pi-native context-overflow recovery without replaying Tools or input;
      [unchanged-threshold real Luna acceptance](reports/context-overflow-recovery-20260918.md).

- [x] Bounded two-way Worker claims, conservative pending capacity and retained
      queue notifications; [matched GPT comparison and correctness](reports/parallel-claims-20260918.md).

- [x] Atomic Worker claim/lease/publication admission, exact COMMIT confirmation
      ([original acceptance](reports/atomic-admission-20260918.md)); startup failure
      now requires closure under ADR-0178 rather than output-free pre-start retry.

- [x] Bounded warm PG connections, single candidate selection, claimed metadata
      reuse and fewer lifecycle-write round trips; [GPT acceptance](reports/startup-optimization-20260917.md).

- [x] ADR-0171: shared-Volume temporary compute and explicit cwd; real Git
      worktree coding/local merge, nested compute and same-port home-Volume previews.
      [Acceptance](reports/subagent-compute-20260915.md).

- [x] Log-driven Subagent starts, messages and cancellations; Cube-only workflow
      scripts and Worker-native Lanes; [paid acceptance and boundaries](reports/log-driven-subagents-20260913.md).
- [x] Internal conversation/admission module boundaries, shutdown admission
      regression and unified-Projector handoff tests; no new service or protocol.
- [x] Roll out the consolidation after approved PiCloud build-cache cleanup
      restored the disk-headroom minimum;
      [verification and rollout status](reports/architecture-consolidation-20260910.md).

- [x] Idempotent projection recovery, real Child detail reads, message-level display
      coverage, framed snapshots and the maintained CI fault gate (ADR-0165).
- [x] Remove per-record signatures for trusted private deployment; keep PG admission,
      scope and ordered seal checks (ADR-0164).
- [x] Unify native history, live views and Tool routing in one Projector group;
      remove Fact Gateway/channel leases. Tool replies now use the boot-scoped
      Kafka transport under ADR-0183.
- [x] Replace per-Step PG receipts with Kafka-acknowledged native Session writes;
      retain bounded cold restore and exact asynchronous PG projection.
- [x] Complete paid model/Cube, interrupted-prefix and process-fault acceptance
      for the native append cutover. Current repetitions follow the
      [validation matrix](EVALUATION.md).
- [x] Bound Producer/Broker transport under slow downstreams, align capacity
      configuration and measure native publication independently from model time.

- [x] Whole native Tools execute in Cube; Pi callbacks receive bounded native
      final results through Kafka, without completed-result caches or GET.
      Dispatch commits precede effects; projection replay never re-executes Tools.

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
      an active Run without replaying its Agent Loop.
- [ ] Repeat the clean one-host installer on a fresh machine.
- [ ] Validate autoscaling and persistent storage on at least three physical nodes.

Every performance or availability claim must name the tested revision,
topology, workload and observed result.

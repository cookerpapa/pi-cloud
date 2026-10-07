# Implementation roadmap

## October 7 review repairs

- [x] Review all 22 workspaces at `7a5fc603`; record
      [findings and evidence](reports/repository-review-20261007.md).
- [x] Repair submission identity, guest provenance, paginated history counts,
      Volume concurrency and the stale cancellation comment. See
      [source verification](reports/review-repair-20261007.md) and
      [ADR-0234](adr/0234-volume-gateway-shared-access.md).
- [x] Deploy the [matched application/migration 182 release](reports/review-release-20261007.md)
      and verify browser retry, concurrent uploads, Luna Tools/images and cold Worker recovery.

## Cube template cleanup

- [x] Diagnose and repair stale node-address routing under
      [ADR-0233](adr/0233-template-cleanup-node-routing.md). Matched Cube release,
      148 template tests, real MySQL failure/reference checks and removal of 55
      old templates pass [live acceptance](reports/template-cleanup-20261007.md).

## Post-Durable whole-repository review

- [x] Review `aace21a8` against pinned Pi Durable 1.0.0 and
      `pre-pi-durable-1.0`, covering all 22 workspaces and delivery boundaries.
      [Findings and verification](reports/repository-review-20261006.md).
- [x] Implement and verify R06/Q06/O06 under ADR-0231/0232.
      [Repair and validation evidence](reports/review-repair-20261006.md).
- [x] Complete the [matched schema 181 release](reports/review-release-20261006.md)
      and owned Luna/Cube/browser acceptance, including native Fork context,
      Subagent interactions and image recovery on another Worker.

## Complete Tool call publication

- [x] Implement and deploy [ADR-0230](adr/0230-complete-tool-call-publication.md):
      incomplete Tool arguments remain in Worker memory, text keeps streaming,
      and complete calls retain the native validation/intent boundary. Native
      recovery contracts, 190 fault cases and real Luna/Cube/PG acceptance pass.

## Pi Durable 1.0 evaluation

- [x] Implement and deploy the native Durable runtime/storage migration under
      [ADR-0229](adr/0229-native-durable-runtime.md), with product/recovery
      [verification and matched cutover](reports/pi-durable-migration-20261006.md).
- [x] Execute isolated storage, Kafka/PG, crash and actual Cube Tool verification
      under ADR-0228. [Results and migration boundaries](reports/pi-durable-evaluation-20261005.md).
      The owner subsequently approved native adoption under ADR-0229; the evaluation
      alone was not a deployment.

## October 5 whole-repository follow-up review

- [x] Review `5c2fcab4`: current 22 workspaces, pinned Pi/Cube, recovery,
      cancellation, storage/assets, product flows and delivery.
      [Findings, reproductions and evidence](reports/repository-review-20261005.md).
- [x] Repair R05-01–04 and correct R05-05 under ADR-0227, widen large replies to
      eight and retain owner fencing/physical evidence. Matched rollout and
      [verification](reports/review-improvements-20261005.md) include real Luna,
      Volume, cancellation, Worker image recovery and development-machine takeover.

## October 4 whole-repository review

- [x] Review `8d8ee837`: lifecycle/recovery, pinned Pi behavior, ordered execution,
      storage/assets, product paths and deployment. [Report and evidence](reports/repository-review-20261004.md).
- [x] Resolve R04-01–07 and Q04-01 under ADR-0224/0225/0226, including matched
      native protocol 7 rollout and owned live acceptance.
      [Repair evidence](reports/review-repair-20261005.md).

## Recoverable VM allocation

- [x] Deliver [ADR-0223](adr/0223-recoverable-vm-allocation.md): stable physical
      allocation, queryable creation, irreversible closure and matched recovery
      acceptance without resetting business data.
      [Deployed verification](reports/vm-allocation-20261004.md).

## Historical paused input after Stop

ADR-0229 supersedes this queue policy: unconsumed input now returns to the composer.

- [x] Deliver [ADR-0222](adr/0222-paused-inputs-after-stop.md), including durable
      pause, fresh-input bypass, explicit continuation and browser/recovery tests.
      [Verification and release](reports/paused-inputs-20261004.md).

## Pi Tool cancellation

The original-result waiting policy below is historical; ADR-0229 adopts native Durable abort settlement.

- [x] Deliver [ADR-0221](adr/0221-pi-tool-cancellation.md): ordered cancellation,
      original-result settlement, bounded UNKNOWN and foreground/background isolation.
      [Regression, fault and matched live acceptance](reports/pi-tool-cancellation-20261004.md).

## Agent Stop correction

- [x] Implement and verify [ADR-0220](adr/0220-agent-stop-is-not-process-control.md):
      the chat Stop button interrupts the Agent Loop while accepted VM commands
      retain their independent lifetime. Its detach-only semantics are superseded
      by ADR-0221. [Historical verification](reports/agent-stop-correction-20261004.md).

## Completed follow-up review

- [x] Review `3dbf49fb` across all workspaces, pinned Pi, lifecycle/recovery,
      deployment and validation paths. [Findings and evidence](reports/repository-review-20261003-r2.md)
      include default-test failures and separate the Cube capacity decision from
      local fixes. [Approved implementation and verification](reports/review-repair-20261004.md)
      follow ADR-0218/0219, including the matched release and live recovery,
      cancellation and image-queue acceptance.

## Completed review repairs

[ADR-0216](adr/0216-review-data-path-bounds.md) and
[ADR-0217](adr/0217-declarative-cube-release.md) implement the approved October 3
review repairs. [Tests, measurements and rollout status](reports/review-repair-20261003.md)
record the deployed matched release; existing storage and execution authorities remain.

## Completed foundation

- [x] [ADR-0215](adr/0215-unlimited-product-quotas.md): no default resource/product
      quotas, streamed uploads, renewable claims and matched Cube completion
      contracts. [Elastic/machine/browser/Luna acceptance](reports/unlimited-quotas-20261003.md).

- [x] [ADR-0214](adr/0214-unified-self-hosted-k3s.md): one K3s self-hosted runtime,
      native Service discovery and owner-approved business-data reset.
      [Tool/image and Pod/crash recovery acceptance](reports/k3s-migration-20261003.md).

- [x] [ADR-0200](adr/0200-workspace-uploads-and-user-image-input.md): chat uploads
      into Workspace, native user image content, immutable Session image sources,
      queue/steer/history support and matched schema/Guest rollout.
      [Browser, fault and real Luna acceptance](reports/user-input-attachments-20260929.md).

- multi-tenant Web Coding Agent using Pi SDK;
- PostgreSQL Run authority, same-Lane ordering, physical Pi Session
  Worker ownership and shared Worker queue;
- Pi Durable public `Storage` PostgreSQL adapter with one self-contained
  native commit log per physical Session and native Compaction;
- control-plane publication ingress under a PG-issued identity, ordered seals and producer fencing;
- lossless PostgreSQL queue wake-up and background fail-closed execution-plane readiness;
- Kafka `acks=all` AcceptedFact log keyed by Session;
- one partitioned Session Projector group and cursor-free snapshot-first SSE;
- CubeSandbox KVM-only Tool execution and persistent Workspace Volumes;
- bounded-warm elastic Cubes and user-owned development machines with SSH;
- same-Session FIFO, concurrent cross-Session Agent Loops and one Workspace-owned
  Cube with independently fenced concurrent Tool bindings;
- Control-plane-independent development-machine runtime with running-state-preserving takeover;
- conversation trees, Fork, Steer, recursive Subagents and Workspace rebinding;
- Unified self-hosted K3s deployment and distributed Kubernetes/KEDA manifests;
- non-exclusive GitLab Issue claims and private-project
  Issue-to-Run execution choices;
- ordinary user-owned Git worktrees with user-directed commit, push and
  provider delivery;
- versioned Agent definitions with Run/Worker routing and Runtime-native Session Storage.
- Provider-native Web Search on the verified OpenAI Codex and DeepSeek Responses routes,
  frozen with each issued model runtime, retained as Codex-shaped Pi transcript
  items and kept outside sandbox management.
- Provider → model → reasoning selection with GPT request-scoped Fast mode,
  Session desired settings and immutable Turn snapshots.
- composer-level cascading Provider/model/reasoning selection, with new Web
  conversations starting on GPT-6 Sol, medium reasoning and Standard service.
- role-free neutral Subagents with explicit task/context/compute/cwd/Tool settings
  and lazy Cube activation on the first local Tool call.
- owner-local Lane-bound Subagents sharing one durable Pi Session Entry DAG
  without per-Entry inherited-context references.
- Codex-style per-call Hosted Web Search activity for GPT and DeepSeek, plus
  stable-region Markdown rendering for citation-heavy streams.

## Implemented: publication and sandbox authority

[ADR-0209](adr/0209-control-plane-publication-and-sandbox-authority.md) and
[ADR-0210](adr/0210-cube-execution-handoff-and-scoped-stop.md) are implemented.
[Publication acceptance](reports/publication-ingress-20261001.md) and the
[Cube execution acceptance](reports/cube-execution-authority-20261001.md) cover
PG/Kafka fencing, native execution, scoped stopping, image delivery, Worker
canonicalization and matched image/deployment contracts. The [production rollout](reports/cube-execution-rollout-20261001.md) is complete,
including real Luna, browser, Worker replacement and control-plane SIGKILL tests.
Single-host acceptance does not establish independent-node availability.

## Current release gate

- [x] Complete the [October 2 whole-repository review](reports/repository-review-20261002.md)
      at `6c74c653`, including README/current-topology corrections, isolated PG
      measurements and recovery/ownership characterization. Confirmed repairs
      and accepted optimizations are deployed under ADR-0213; [matched verification,
      budget measurements and real-model recovery acceptance](reports/control-recovery-repair-20261003.md)
      are complete. The newly observed Docker/K3s transport-discovery limit is
      recorded in BACKLOG.

- [x] [ADR-0212](adr/0212-ordered-control-read-models.md): remove hot binding reads,
      replace queued-input polling with owner views, and drive Session-local
      Subagent read/pending state from ordered changes with recovery acceptance.
      [PG/Kafka, browser, Luna and process-restart evidence](reports/ordered-control-views-20261002.md)
      records the matched rollout and retained original VM/history.

- [x] [ADR-0211](adr/0211-execution-path-and-runtime-probes.md): extend existing
      Session probes through active Cube bindings and the Worker reply mailbox;
      unify direct VM execution probes, bounded health scheduling and lifecycle
      reconciliation. [Fault, scheduling, real Luna/Cube and browser acceptance](reports/execution-probes-20261002.md)
      includes controlled process replacement and preserved original history.

- [x] Complete the [September 30 whole-repository review](reports/repository-review-20260930.md)
      against pinned Pi, current ADRs and original design rationale; record
      reproducible findings, coverage and verification limits.
- [x] Restore the workspace/dependency gates and repair the review's confirmed
      runtime/data-boundary findings. The separately approved architecture
      cutover is tracked above.

- [x] ADR-0203: direct Steer uses the durable pending-input queue, canonical
      consumption and sealed-target restoration. [PG, browser and real Luna acceptance](reports/direct-steer-acceptance-20260930.md)
      covers lost replies, Worker loss, cancellation and preserved original history.

- [x] ADR-0202: recover missing Workspaces using owned cloud development machines
      and selected directories. [PG, browser and real Luna acceptance](reports/workspace-rebind-acceptance-20260930.md)
      confirms preserved history/model settings and execution in the selected directory.

- [x] ADR-0201: independent PG-time expiry sweeps, persistent runtime activity
      and quiet-Session path probes. [Fault, browser and real Luna/Cube acceptance](reports/runtime-status-acceptance-20260930.md)
      includes Projector replacement, cancellation and Worker loss/recovery.

- [x] ADR-0199: isolate proved unpublished rejections, share cold projection waits,
      bound native/seal SQL work and reduce transaction-local exchanges.
      [PG, fault, timing and matched Luna/Cube acceptance](reports/runtime-polish-acceptance-20260928.md).

- [x] ADR-0198: combine fixed remote Tool intent and dispatch in one Kafka record;
      preserve native validation/hooks, cancellation and commit-before-dispatch.
      [Fault, matched rollout and real Luna/Cube acceptance](reports/tool-invocation-acceptance-20260928.md).

- [x] ADR-0197: indexed native log, independent Fork copies and bounded current
      operation state; old Entry/Record/COW tables removed, with matched schema/app
      rollout and [Pi, fault and real Luna acceptance](reports/indexed-native-log-acceptance-20260927.md).

- [x] Complete the approved [D1/D3/D4 follow-up](reports/repository-review-followup-20260927.md):
      bounded Subagent results, batched lease observations and narrower runtime/Guest
      dependencies, with matched rollout and real Luna acceptance.

- [x] Complete the [September 27 repository review](reports/repository-review-20260927.md)
      cleanup rollout and real Luna/Cube/browser acceptance: final-only native Tool
      transport, callback failure isolation, Pi text-read parity, image metadata/cleanup,
      shared management contracts and single-statement snapshots.
      The approved D1–D5 follow-ups are completed in the entries above.

- [x] ADR-0191 amendment: restore selectable Flash with its requested search
      declaration and hide Pro. [Gateway, browser and real Tool-image acceptance](reports/flash-catalog-20260926.md)
      confirms the matched rollout; Responses search remains ignored upstream.

- [x] ADR-0194: editable pending messages, cancellation, ordering and promotion
      to active steer; matched schema/API/Worker/Web rollout completed.
      [Admission races, fault checks and real Luna/browser acceptance](reports/queued-inputs-20260926.md).

- [x] ADR-0193: native input closure, per-Step retries, compaction usage freshness
      and Run-local backoff cancellation. [Regression, fault and Luna acceptance](reports/cloud-agent-runtime-repair-20260926.md).

- [x] ADR-0191/0192: GPT-6 Luna Tool/vision/search, immutable image references,
      cold recovery, cleanup faults and matched local rollout.
      [Acceptance](reports/image-attachments-20260926.md).

- [x] Complete ADR-0190's GitLab note-sync migration and local rollout: real PG
      concurrency, controlled HTTP faults, lost replies, late writes, independent
      Issue admission and bounded shutdown.
      [Acceptance](reports/gitlab-note-sync-20260926.md).

- [x] Complete the matched local rollout acceptance for the September 26
      [Pi-alignment repairs](reports/pi-alignment-repair-20260926.md): native
      Record/invocation semantics, guest file behavior, eligible Tool concurrency,
      sampling/retry boundaries, conversation discovery and guest build identity.
      The subsequently approved image slice is tracked under ADR-0192.

- [x] Ephemeral Tool log preview via Cube completion HTTP → Projector SSE; final-only
      Kafka replies, no observation history or background-service log follower.
      [Luna/Cube/browser and process-restart acceptance](reports/tool-progress-acceptance-20260925.md).

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
- [x] Bound publication/handoff transport under slow downstreams, align capacity
      configuration and measure native publication independently from model time.

- [x] Whole native Tools execute in Cube; Pi callbacks receive bounded native
      final results through Kafka, without completed-result caches or GET.
      Dispatch commits precede effects; projection replay never re-executes Tools.

- [x] Route Agent Tool commands from the Kafka Projector to Cube; retain native Session
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

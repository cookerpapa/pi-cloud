# Implementation roadmap

## Kafka replies → Worker callback review

- [x] Review boot reply consumption, operation matching, image restoration,
      cancellation and the return to pinned Pi's native Tool task.
- [x] Verify with existing tests, isolated failure probes and a disposable RF3
      Kafka reassignment test. Record [findings and repair directions](reports/kafka-worker-reply-review-20261017.md).

The subsequent [ADR-0254 repair plan](adr/0254-worker-reply-admission-and-settlement.md)
records the owner's thin-admission direction. W1–W3 are implemented in source,
retaining boot-local replies and native unsafe Tool recovery.
[Verification and release](reports/worker-reply-repair-20261017.md) record passing
source/transport/fault gates; host KVM currently blocks matched deployment.

- [x] W1: local reply-consumer admission health; remove provider HEAD startup/
      periodic admission gates; keep active waits under their existing bounds.
- [x] W2: same-boot volatile reply progress across reassignment.
- [x] W3: execution receipt separate from image restoration and native settlement.
- [x] Required source/transport/fault checks.
- [ ] Restore host KVM, finish the scanned matched release, relevant Luna/Cube/
      browser recovery acceptance and confirmed fixture cleanup.

## Cube completion → Kafka replies and UNKNOWN continuation

[ADR-0253](adr/0253-tool-reply-uncertainty-and-continuation.md) records the approved
direction and current-hop source findings. U1–U5 are implemented and deployed as
`tool-unknown-791a6ed0`. The [verification record](reports/tool-reply-continuation-20261016.md)
separates passing source/live cases from failed samples, the repaired startup
Stop races and the remaining conservative Volume-reference recovery limit.
The owned crash fixture was cleaned only after operator-confirmed detach;
automatic recovery of unknown Volume references remains a separate backlog item.

- [x] U1: trusted failure classification and hard-stop precedence.
- [x] U2: reuse the existing bounded execution probe through a runtime port.
- [x] U3: native UNKNOWN settlement with conditional inspection and repeated-uncertainty guard.
- [x] U4: per-invocation reply deadlines, obsolete-branch removal and verification.
- [x] U5: matched deployment, real Luna/Cube/browser/recovery evidence and confirmed cleanup.

No Codex-style process polling, result outbox/cache, new PG health rows or Pi loop
patch is included. Probe success never changes the original UNKNOWN into success
or grants execution authority; missing probes never authorize VM destruction.

## Guest → Cubelet result audit

- [x] Review guest final/progress framing, raw PTY receipts, native output draining
      and execution cleanup against the exact maintained Cube patches/containerd.
- [x] Reproduce receipt-loss cleanup and oversized preview loss with isolated
      guest/PTY/native-driver probes; record [evidence and repair boundaries](reports/guest-cubelet-result-review-20261016.md).

The review made no runtime/deployment change. The owner approved
[ADR-0252](adr/0252-tool-receipt-and-ephemeral-preview.md) consolidates the repair
and subsequent preview discussion, with an ordered implementation plan:

- [x] R1: distinguish receipt-only failure from local execution/settlement failure,
      including native final/deadline races and stop-helper receipts.
- [x] R2: source-side bounded terminal-aware previews, independent of final output.
- [x] R3: revision-bound edits/resets through guest I/O, HTTP coalescing and SSE/browser.
- [x] R4: required source/live acceptance and a drained, matched protocol rollout.

R1–R3 are implemented in source; the [delivery record](reports/tool-receipt-preview-repair-20261016.md)
records passing source/native/fault gates and eleven scanned artifacts. Windows
rollback restored KVM and matched deployment completed as `tool-preview-325f0ebd`.
All required live suites pass, including native input/dual-process recovery and
the full Cube multi-round/Volume checks. The report retains failed TLS attempts,
the measured SSE recovery/test-budget correction and verified cleanup. The
pre-existing external AnyTLS-path issue remains a separate operational backlog item.

## Cubelet → guest execution audit

- [x] Review native process startup, guest framing/attachment, fixed Tools,
      output, cancellation and cleanup against pinned Cube/containerd/Pi source.
- [x] Run existing suites and isolated path/deadline probes; record evidence,
      existing design choices and bounded repair proposals in the
      [review](reports/cubelet-guest-execution-review-20261015.md).

The review itself made no runtime or deployment change. The owner subsequently
approved all four repairs under [ADR-0251](adr/0251-guest-attachment-and-execution-bounds.md).

- [x] G1: bound native cleanup and refuse Start after known expiry/cancellation.
- [x] G2: align guest Read path semantics and subsequent path checks with pinned Pi.
- [x] G3: replace per-Tool initialization bodies with the strict attachment contract.
- [x] G4: required gates, matched guest 6 release, live acceptance and cleanup.

Deployed as `guest-execution-5536fc73`; the
[delivery record](reports/cubelet-guest-execution-repair-20261015.md) separates
successful acceptance, failed samples and confirmed cleanup.

## Projector → Cube handoff audit

- [x] Review dispatch commit, memory routing, takeover ACK, partition/Boot changes
      and failure handling against the pinned Cube source; record isolated probes.

The owner approved [ADR-0250](adr/0250-cube-handoff-outcomes-and-runtime-admission.md)
after the [review](reports/projector-cube-handoff-review-20261015.md). The
[repair record](reports/projector-cube-handoff-repair-20261015.md) records the
completed `handoff-6ab91bb7` deployment, source/live gates and confirmed cleanup.

- [x] H1: independent failure notification/quarantine settlement and explicit effect evidence.
- [x] H2: exact binding lookup with the existing ownership/closure guards.
- [x] H3: native catalog admission serialized with confirmed-absence cleanup.
- [x] H4: native concurrent-read upgrade contract; no batch-position protocol expansion.
- [x] H5: required gates, matched release, relevant live acceptance and fixture cleanup.

## Projector publication and presentation simplification

The owner approved [ADR-0249](adr/0249-compact-projector-publication.md), following
the [October 15 review](reports/projector-envelope-review-20261015.md).
[Implementation progress](reports/projector-repair-20261015.md) distinguishes
source slices from matched deployment and live acceptance.

- [x] A1/A2: minimal prefix state and whole-writer cleanup; prepared/indexed dispatch.
- [x] A3: one compact Kafka envelope, no standalone cancellation/old wire fallback.
- [x] A4: same-commit Tool presentation without copied argument/result bodies.
- [x] A5: fixed/workflow request separation and matched guest contracts.
- [x] A6: required gates, matched rollout and complete relevant live acceptance.

Deployed as `projector-compact-bf55d9bd`, schema 189 / topic v17 / guest protocol 5.
The repair record separates complete native-input/browser/Cube passes, focused
child checks, rolling child recovery, failed samples and confirmed cleanup.

## Idle Worker reconnect and compatible Control Plane updates

The owner accepted the reconnect direction after the October 14 outage evidence.
[ADR-0248](adr/0248-idle-worker-management-reconnect.md) consolidates the morning
discussion and separates the immediate implementation slice from later handoff work.

- [x] Reconcile observed behavior, stable Service discovery, WebSocket registration
      and the timeout retirement cause; record the decision before runtime changes.
- [x] A1: distinguish idle connection expiry from Boot retirement across every entry path.
- [x] A2: preserve new-Boot fencing and atomic claim/reconnect admission.
- [x] A3: cover transport, credential, lease and PG concurrency failures.
- [x] A4: deploy the matched change and verify 60/90-second outages with both idle
      and busy Workers, new intake and confirmed fixture cleanup.

Dispatch handoff, surviving-peer address caches and interactive connections remain
separate follow-ups before a maintained compatible Control Plane-only release path.
The reconnect change is deployed as `worker-reconnect-5b6ba003`, schema 189;
[delivery evidence](reports/idle-worker-reconnect-20261014.md) records passing
repository/outage/SIGKILL gates, the acceptance-discovered receipt read repair,
complete native-input/Cube/browser acceptance and confirmed fixture cleanup.

## Session execution, native Subagents and Tool dispatch

The owner agreed to clarify cloud Run as root work and let one Session Harness
manage its ordinary child Conversations. The
[consolidated plan](adr/0247-session-work-and-tool-dispatch.md) replaces the earlier
ADR-0246 proposal. The migration is deployed as `session-work-6ac697f9`;
source, transport, live recovery and rolling-replacement acceptance are complete.
See the [progress report](reports/session-work-implementation-20261013.md).

- [x] Reconcile current source, the native public APIs and October 13 decisions;
      define scope, deletion targets, failure gates and matched-cutover requirements.
- [x] P0 / R13S-01: prove child creation, input, ownership, wait/blocked, cancellation
      and recovery without cloud child Runs, retaining the current product behavior.
- [x] P1 / R13T-01: unify same-commit dispatch and final Kafka replies with a common
      Worker proxy; verify mixed effect classes and replay/offset boundaries.
- [x] P2 / R13S-02: remove child Run claims and duplicated command/state bodies;
      migrate model, resource, input, UI/history and recovery consumers to native identity.
- [x] P3 / R13K-02: replace per-child Run seals with native completion and one
      physical-writer closure; preserve root-work readiness and exact recovery proof.
- [x] P4 / R13K-01: implement direct Session producers only after real PG/Kafka
      authorization, takeover and ambiguous-commit tests and same-load resource comparison.
- [x] P5 / R13U-01: complete one matched cutover and full Luna/Cube/browser acceptance,
      then verify compatible Control Plane updates during continuously active work.

The matched schema 188 / topic v16 / reply v3 release has no dual-writer or
legacy child-Run fallback. The report distinguishes tested handoff from arbitrary
cross-version/schema upgrades and records the observed text-update gap.

## Native Kafka fencing research

- [x] Research native transactions, PG authority and delayed initialization;
      execute six isolated Kafka/PG schedules, active-producer resource samples
      and the two maintained ingress transport tests.
      [Findings and scope](reports/kafka-native-fencing-20261013.md).
- [x] Assess the direct-Worker change and refine it into
      [ADR-0247](adr/0247-session-work-and-tool-dispatch.md). The delayed-initialization
      availability problem and resource measurements remain explicit acceptance gates;
      primitive experiments do not prove the complete replacement protocol.

## Kafka assistant-text deduplication

- [x] Inspect native commit preparation, post-adoption display callbacks,
      publication ordering and history/SSE coverage. Record the proposed
      [same-commit design](adr/0245-native-commit-text-presentation.md).
- [x] Implement and verify Worker-owned display descriptions that reference text
      in the same native publication; remove the duplicated text publisher.
- [x] Validate ordering, replay, partial recovery, parent/child isolation and
      browser behavior; measure bytes/record counts and deploy matched artifacts.

## Native live-state retention

- [x] Prepare [ADR-0244](adr/0244-kafka-backed-native-live-state.md) from native
      Pi/storage and existing replay/closure code; owner approval is recorded.
- [x] Implement PG boundary/handoff checkpoints, retained small commit headers,
      current live reads and Kafka recovery references under schema 186.
- [x] Verify live reads, mixed commits, multi-Conversation replay references,
      checkpoint/closure atomicity, safe Kafka cleanup and quiescent asset recovery.
- [x] Complete measured storage/failure, native Luna/image/multi-Conversation
      acceptance and matched deployment.
      [Verification and release record](reports/native-live-state-20261012.md).
- [x] Complete the broad Cube production check on the deployed release. The
      October 12 follow-up passed without a runtime/configuration change;
      earlier upstream TLS failures remain a separate operational finding.

## Native input current state

- [x] Record owner-approved [ADR-0243](adr/0243-native-input-current-state.md).
- [x] Implement current Inbox/input/Submission persistence and atomic consumption.
- [x] Complete storage, API, recovery/export, fault and repository acceptance.
- [x] Deploy matched schema 185 and exercise real Luna/native-input/browser recovery.
      [Release evidence](reports/native-input-current-state-20261012.md) includes
      actual Worker SIGKILL, preserved configuration and confirmed fixture cleanup.

## Native log design review

- [x] Compare maintained open-source storage patterns, inspect current Pi adapters,
      and execute isolated retention, cold-read and rebuild experiments.
      [Review and evidence](reports/append-only-storage-review-20261011.md).
- [x] Repair R11L-01 reconstruction integrity under ADR-0243.
- [ ] Address O11L-01 cold-read reuse; discuss the remaining D11L-01 streaming/Task
      retention policy. Keep existing execution authorities.

## Publication registration rejection

- [x] Reuse the existing in-memory identity/closure checks before PG registration
      reads; preserve PG authorization and post-read checks under ADR-0209.
- [x] Verify zero queries for known rejected identities, ordinary/cold registration,
      sealing races and owner replacement in repository and RF3/PG checks.
- [x] Deploy `publication-admission-c39a78f8` and complete native-input/Stop and
      Control Plane SIGKILL acceptance with preserved configuration and cleanup.
      [Evidence](reports/publication-admission-20261011.md).

## Worker claim schema cleanup

- [x] Implement approved R10C-01–04 under
      [ADR-0242](adr/0242-worker-claim-schema-cleanup.md), retaining all ownership boundaries.
- [x] Verify indexed history reads, migration guards and identities, shared-family
      admission, Worker registration/retirement, native recovery and repository gates.
- [x] Deploy matching schema 184/application artifacts and complete
      [Luna/native-input/browser/Worker-recovery acceptance](reports/worker-claim-repair-20261010.md).

## Missing working-directory Tool results

- [x] Implement [ADR-0241](adr/0241-missing-working-directory-tool-errors.md):
      classify confirmed user-directory loss before execution as a native Tool error.
- [x] Reproduce the old guest failure and verify directory replacement, running
      command survival, explicit restoration, completion and Harness continuation.
- [x] Complete full source/fault gates and deploy `working-directory-889279b2`.
      [Real Luna/Cube, native input and browser acceptance](reports/working-directory-20261010.md)
      verify continuation, restoration, unchanged VM identity and physical cleanup.

## Input-admission read reuse

- [x] Implement [ADR-0240](adr/0240-transaction-scoped-input-admission.md): reuse
      Session and initial-request facts only while their intake transaction remains open.
- [x] Verify eight initial-intake queries, two retry queries, concurrent duplicate
      requests, model-change ordering, rollback, Workspace deletion and tenant isolation.
- [x] Complete all repository gates and deploy `input-admission-db0548b8`;
      [real HTTP retry, Luna/Cube/browser and preservation checks](reports/input-admission-20261010.md) pass.

## Projection query and replay writes

- [x] Implement [ADR-0239](adr/0239-projection-query-and-replay-writes.md): one
      combined Run/writer read with ordered locks, conditional display coverage
      and shared monotonic partition-progress writes.
- [x] Verify real PG lock waits, replay tuple stability, stale-owner rejection,
      native-byte conflicts, deletion and unchanged recovery floors.
- [x] Complete the source regression gates and record their
      [results and limits](reports/projection-sql-20261009.md).
- [x] Deploy the optimization and commentary animation as schema 183
      `projection-b14c3777`; [Luna/Cube/browser acceptance and fixture cleanup](reports/projection-release-20261009.md) pass.

## Native human input and Session/Run consolidation

- [x] Implement [ADR-0238](adr/0238-native-input-queue-and-run-record.md): merge
      Turn storage into Run and remove reviewed unused fields without a compatibility view.
- [x] Route running-session follow-up/steer to the native durable inbox with
      confirmed submission identity; no placeholder Run or cloud payload queue.
- [x] Preserve durable edit/order/cancel/promotion, Stop/return, attachments and
      multiple consumed user messages inside one cloud Run.
- [x] Complete native, PG, API/browser and recovery verification; document
      deployment status separately from source completion.

[Source verification](reports/native-input-run-consolidation-20261009.md) is complete;
the [matched deployment](reports/native-input-release-20261009.md) and real
Luna/Cube/browser acceptance are also complete.

The [reading checkpoint](READING_PROGRESS.md) covers PG input acceptance, queue
notification, atomic Worker claim/Session-lease admission, native Harness/context
opening, Storage publication through ingress, and Kafka commit/fencing.
The focused
[claim-table review](reports/worker-claim-schema-review-20261010.md) is complete;
its approved repairs are implemented and deployed under ADR-0242. The next hop is
Kafka consumption by Projector; provider requests remain a separate walkthrough.

## Architecture evidence and private-use readiness

The [October 7 design review](reports/architecture-evidence-review-20261007.md)
retains the implemented core. The approved readiness slice now provides a
[matched release workflow](MATCHED_RELEASE.md), consistent Run/Stop/Storage
semantics, [pilot criteria](PRIVATE_PILOT.md), and an independently exercised
[conversation/image restore](ASSET_RECOVERY.md) into new Workspaces. It changes
operator tooling/docs, not runtime authorities. The [matched deployment](reports/readiness-release-20261007.md)
and real Luna/Cube/browser acceptance are now complete. The owner deferred backups of
current disposable data; the actual pilot has not started. Fresh-machine delivery,
fleet capacity and physical-node HA remain separate acceptance items.

## October 7 recovery and boundary review

- [x] Review all 22 workspaces at `1e7e21eb` against pinned Pi Durable 1.0,
      current cloud authorities and deployment/verification contracts.
      [Coverage, findings and evidence](reports/repository-review-20261007-r3.md).
- [x] Complete the previously interrupted real Luna multi-Run/cold-VM gate and
      isolate new recovery, Read parity, logging and document-query observations.
- [x] Implement the approved R07R3-01/02/03 repairs, O07R3-01 query optimization
      and scoped cleanup under [ADR-0236](adr/0236-recovery-input-identity-and-tool-diagnostics.md).
      [Source verification](reports/review-repair-20261007-r3.md) records recovery,
      browser, native parity and query-cost evidence. R07R3-04 is owner-deferred.
- [x] Deploy the matched Tool Worker protocol 4 guest/application artifacts and
      updated returned-input API/browser. [Release acceptance](reports/review-release-20261007-r3.md)
      covers real Stop/return/image resend, canonical Read diagnostics, native VM
      contracts and the complete Luna/cold-VM gate; owned resources are cleaned.

## October 7 post-release review

- [x] Review all 22 workspaces at `59541389`, including recent repairs, pinned
      Durable recovery, transport, resource lifecycle, storage, UI and delivery.
      [Findings and bounded verification](reports/repository-review-20261007-r2.md).
- [x] Implement the four confirmed findings under the
      [approved repair plan](reports/review-repair-plan-20261007-r2.md) and
      [ADR-0235](adr/0235-upload-staging-recovery.md).
      [Source verification](reports/review-repair-20261007-r2.md) covers browser,
      RF3, process loss, new guest code and 217 fault cases.
- [x] Deploy [matched application/Gateway and guest-protocol-4 artifacts](reports/review-release-20261007-r2.md)
      after drain, with owner-authorized destructive cleanup. Same-partition
      dispatch redesign and cold-host restore diagnosis remain separately scoped work.

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

ADR-0245 is deployed as `native-text-c9b8b2a3`, schema 187 / topic v15: one
native Kafka publication supplies assistant text and display descriptions.
[Verification and rollout](reports/native-text-presentation-20261012.md) cover
source checks, real recovery and cumulative live scenario acceptance, including
upstream TLS interruptions. No new durable store or runtime authority was added.

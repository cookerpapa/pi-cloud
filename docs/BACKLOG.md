# Maintained backlog

Only unfinished work for the PostgreSQL + Kafka + Pi SDK + Cube Volume
architecture belongs here. Implemented contracts live in the
[architecture](ARCHITECTURE.md), [current ADRs](adr/README.md) and versioned
acceptance evidence. Superseded plans and completed-task journals remain in Git.

The [September 15–17 audit](reports/repository-audit-20260915.md) is complete:
maintained-file review, paid combination tests, process faults, browser paths,
latency analysis, isolated load gates and scoped cleanup. Its bounded measurements
do not establish enterprise-scale capacity or physical multi-node HA.

The [September 30 review](reports/repository-review-20260930.md) is complete at
`5fd6159f8a0ec0cc5d4ebc0dc24071c29b82028d`. It adds eight confirmed findings,
three decisions to discuss and scoped cleanup candidates. The subsequent
[repair record](reports/repository-review-repair-20261001.md) records all eight
confirmed repairs, the accepted deletion/interruption decisions, bounded cleanup
and passing combined verification. The subsequent
[authority and Cube execution implementation](reports/cube-execution-authority-20261001.md)
and the [production cutover](reports/cube-execution-rollout-20261001.md) are
complete. The owner confirmed dsh-cloud is retired; it no longer constrains
PiCloud deployment. Remaining operational limits are listed below.

The repeated Cube template-cleanup timeouts are resolved under
[ADR-0233](adr/0233-template-cleanup-node-routing.md): cleanup used obsolete Pod IPs
instead of current addresses for the same stable node. The
[deployed repair](reports/template-cleanup-20261007.md) removes 55 unused templates
and their artifacts, preserving all four current templates and historical UNKNOWN
VM records. The bounded release-time cleanup budget remains for unavailable nodes.

## Reliability and capacity

The [October 7 post-release review](reports/repository-review-20261007-r2.md)
is complete at `59541389`. Its four confirmed findings are implemented and
source-verified in the [repair record](reports/review-repair-20261007-r2.md),
following the [approved plan](reports/review-repair-plan-20261007-r2.md).

- [x] R07R2-04: scope composer submission identity across ordinary send and Steer;
      an intervening successful submission must not cause a fresh identical draft
      to replay an older request. Preserve unchanged retry and late-ACK behavior.
- [x] R07R2-02: remove multi-partition progress-lock coupling without weakening
      monotonic dispatch commits, group fencing or commit-before-effect.
- [x] R07R2-01: reclaim abandoned upload staging after process loss, preserving
      concurrent transfers, atomic finalization and shared Volume admission.
- [x] R07R2-03: apply EXIF orientation before image resizing/encoding for both
      user-image preparation and Tool reads.
- [ ] Deploy matching application/Gateway and guest-protocol-4 artifacts after
      draining old uploads. Preserve managed Cube protocol 7 / Tool Worker 3 and
      use the current template identity/provenance checks (ADR-0235).

The same review distinguishes measured same-partition handoff blocking from the
cross-partition lock defect. Native template restore passed in two owned cases;
the earlier host-restart `SetGuestDateTime` failure remains unreproduced and needs
correlated cold-recovery evidence before changing timeout/retry policy.

The [October 7 whole-repository review](reports/repository-review-20261007.md)
is complete at `7a5fc603`. The [approved repairs](reports/review-repair-20261007.md)
implement its findings; the [schema 182 rollout](reports/review-release-20261007.md)
and owned live acceptance are complete:

- [x] R07-01: retain ordinary-send request identity across a lost response;
      unchanged retries must admit one Run, including attachment/first-message cases.
- [x] Q07-01: reconcile guest content-identity reuse with release provenance;
      retain the original image source revision and verify matching build inputs/digest.
- [x] O07-02: page Session headers before counting visible Turn history; preserve
      cursor/visibility semantics and verify plans with substantial isolated history.
- [x] O07-01: implement ADR-0234 shared access and narrow credential exclusion,
      preserving initialization/deletion/process-loss guarantees.
- [x] N07-01: correct the Projector's obsolete original-Tool-result waiting comment.
- [x] Deploy the October 7 source repairs with migration 182 and a drained
      Gateway Recreate upgrade; run owned live acceptance after rollout.

Partition head-of-line blocking, the Cube patch maintenance boundary and internal
lifecycle/UI cohesion are documented discussion items. Measure or define their
contracts before treating structural changes as authorized repairs.

The [October 6 post-Durable review](reports/repository-review-20261006.md) is
implemented and source-verified. [Repair evidence](reports/review-repair-20261006.md)
records the native request/event fixes, filesystem exclusion, bounded navigation,
SQL/dependency reductions and restored delivery checks. The
[matched production release](reports/review-release-20261006.md) is deployed.
It also updates stale Debian pins and the affected OS/Go dependencies, and aligns
image evidence with the actual versioned build and guest identity. Eleven release
images pass the documented fixable HIGH/CRITICAL gate; raw unfixed findings remain
visible in the evidence.

- [x] R06-01: restore Compaction summarize/retry identity under the new PG grant.
- [x] R06-02: correlate overflow/retry events and query executing Tools beyond
      display coverage without exposing uncovered assistant text.
- [x] R06-03: adopt filesystem-held exclusion under ADR-0231, including process
      loss, PG disconnect, replaced-inode and actual credential/GC tests.
- [x] R06-04: select navigation bodies through the native index; stream complete
      Fork prefixes in bounded batches under ADR-0232.
- [x] R06-05: reconcile current cancellation/queue/partial guidance and date the
      superseded evaluation/queue behavior.
- [x] O06-01/02: batch native metadata/revisions and use fixed indexed selector
      keys; single-delta SQL drops from ten to eight in the measured fixture.
- [x] O06-03: remove the CLI dependency from guest truncation; keep a licensed
      pinned helper subset with 1,100 upstream-output cases and bundle closure tests.
- [x] Q06-01: migrate and pass the native Subagent RF3 fixture, validate Tool
      identity before publication, and include the isolated transport gate in CI.
- [x] Q06-02: pin patched source-map-js and pass the audit without exceptions.
- [x] Deploy the matched schema 181 / Control Plane / Worker / Volume Gateway /
      guest release after drain and backup. Luna Tool, native Fork/prune, five
      Subagent scenarios, browser uploads and cold-Worker image recovery pass.
      The two historical UNKNOWN records retain their original identities.

- [x] Deploy [ADR-0230](adr/0230-complete-tool-call-publication.md): incomplete
      Tool calls stay outside Kafka/PG at the public Models port. Streaming text,
      payload-free activity and native complete-intent execution are preserved.
      Abort/truncation/reopen contracts, 190 fault cases and real Luna write/Bash
      acceptance pass; its initial Worker image was `complete-tools-af011ea46133`,
      superseded by the matched release above.
- [x] Verify Pi Durable 1.0 commit, recovery and remote Tool contracts under
      [ADR-0228](adr/0228-pi-durable-evaluation.md). The
      [executable evaluation](reports/pi-durable-evaluation-20261005.md) proves
      transport seams and records cancellation/recovery/queue mismatches.
- [x] Deploy the owner-approved [Pi Durable adoption](adr/0229-native-durable-runtime.md):
      native Harness/Storage, numeric Conversations, authorized same-Run recovery,
      ordered abort/Tool cancellation and queue return. [Release evidence](reports/pi-durable-migration-20261006.md)
      includes 186 fault cases, real Luna/Cube/browser/image/Steer recovery and
      matched schema 180 / execution-topic v14 artifacts. Automatic background
      Compaction remains outside the current cloud admission lifetime.

The [October 5 follow-up review](reports/repository-review-20261005.md) is complete
at `5c2fcab4`. Its original characterization tests are archived at `13344042`.
The [approved improvements and release evidence](reports/review-improvements-20261005.md)
record the matched implementation under ADR-0227.

The [proposed improvement slices](reports/review-improvement-plan-20261005.md)
specify executable POSIX recovery, bounded owner transactions/renewal, and shared
Tool outcome classification. Read concurrency was widened from two to eight as
requested; streaming image transport remains a separate future change.

- [x] R05-01: make failed Attach recovery executable through the actual POSIX
      Volume plugin, retaining pending-cleanup and shared-holder protection.
- [x] R05-02: bound lifecycle resource-lock waits so one resource cannot prevent
      controller-owner renewal; retain PG-time fencing and retirement serialization.
- [x] R05-03: preserve confirmed `not_started` replies during Agent Stop instead
      of relabeling them as an unconfirmed UNKNOWN outcome.
- [x] R05-04: apply infrastructure-failure classification and sampling refusal
      consistently to Workflow and fixed Tool paths, preserving business Tool errors.
- [x] R05-05: correct old Volume delta/co-commit comments and the migration's
      misleading `additive` description; document matched metadata/binary rollback.
- [x] Batch cold native-writer sweeps, collect Volume locks and wait for the
      desired Cubelet image before release checks. Preserve reference checks and
      the existing read/ownership authorities.
- [ ] Measure mixed fleet load before replacing the widened Read gate with
      actual-image streaming/backpressure; source sizing and transfer buffering
      remain distinct concerns.

The [October 4 whole-repository review](reports/repository-review-20261004.md)
is complete at `8d8ee837`. R04-01–07 and Q04-01 are implemented and deployed
under ADR-0224/0225/0226. [Repair and release evidence](reports/review-repair-20261005.md)
covers paused release, staged adoption, PG authorization/time, Fast Compaction,
structured Tool failures, Volume reference recovery and the restored browser gate.

[ADR-0223](adr/0223-recoverable-vm-allocation.md) is deployed: creation identity
precedes the physical effect, lost replies recover the original allocation,
closure excludes delayed creation, and unconfirmed node outcomes remain held.
[Verification](reports/vm-allocation-20261004.md) includes 178 fault cases, real
creation/closure races, Luna with Control Plane SIGKILL, and dedicated-machine
takeover, pause/resume and Volume release. Historical untracked allocations and
physical-node recovery limits remain in the operational items below.

[ADR-0222](adr/0222-paused-inputs-after-stop.md) was deployed before ADR-0229: Stop paused
pending human inputs; new input runs independently and explicit Send/Continue
queue resumes old input. [Verification](reports/paused-inputs-20261004.md) includes
172 fault cases and real Luna/browser/Worker-replacement acceptance.

[ADR-0221](adr/0221-pi-tool-cancellation.md) is implemented and deployed: ordered
operation cancellation, original native Tool settlement, bounded UNKNOWN and
durable abnormal retirement. It supersedes ADR-0220's detach-only semantics.
[Verification](reports/pi-tool-cancellation-20261004.md) includes PG/RF3 Kafka,
166 fault cases and real Luna/shared-VM normal and unavailable-API cancellation.

The [follow-up review at `3dbf49fb`](reports/repository-review-20261003-r2.md)
repairs are implemented under [ADR-0218](adr/0218-review-boundary-repairs.md) and
[ADR-0219](adr/0219-ordered-cube-admission.md): composed input budgets, PG clocks,
fair cleanup, explicit PG tests, isolated Kafka fixtures, scoped Subagent reads,
Run-directory verification, terminal dimensions and ordered Cube closure.
[Verification and release evidence](reports/review-repair-20261004.md) tracks completion.

The [October 3 review](reports/repository-review-20261003.md) repairs are deployed
under [ADR-0216](adr/0216-review-data-path-bounds.md) and
[ADR-0217](adr/0217-declarative-cube-release.md).
[Verification and rollout status](reports/review-repair-20261003.md) records the
upload/cancellation/reminder fixes, paged asynchronous queue views, scoped Lane
reads, streamed image normalization and one rendered Cube release.
Cancellation scanning now excludes pending admissions and already-cancelling
local Runs; ordinary active Runs retain the one-second missed-notification fallback.

- [ ] Measure cross-Worker Run-queue notification fan-out and ordinary active-Worker
      negative cancellation reads at fleet scale before changing the recovery cadence.
- [ ] Measure mixed API/image/queue load after the bounded read/stream changes before
      deciding whether the shared Control Plane needs process separation.
- [ ] Evaluate upstreaming/narrowing the pinned Cube native execution extensions;
      declarative release management does not eliminate their maintenance responsibility.

[ADR-0215](adr/0215-unlimited-product-quotas.md) is deployed: default resource and
product quotas were removed, uploads stream with verified identity, and matched
Cube/Worker contracts passed [unit, fault and live acceptance](reports/unlimited-quotas-20261003.md).

The [K3s cutover](reports/k3s-migration-20261003.md) is complete: old business
state was reset as requested; real Tool/image execution survived PG/Kafka/S3
Pod replacement and a Control Plane crash. Deferred Cube template-cache cleanup
and physical-node HA remain outside that acceptance.

The October 2 R02-01–04 repairs and accepted O02-01–05 slices are deployed under
[ADR-0213](adr/0213-control-recovery-and-propagation-budgets.md).
[Final source, budget, fault and production evidence](reports/control-recovery-repair-20261003.md)
records 1,650 assertions, 133 fault cases, real Luna/VM/browser tests and preserved
original history. Preview tunnel reuse and shared-resource invalidation remain
separate design questions, not an implicit part of the completed query merge.

- [x] Implement and validate [ADR-0212](adr/0212-ordered-control-read-models.md)
      in complete slices: binding publication/revocation, queued-input views,
      then Subagent directory and pending-work reconciliation. Preserve PG
      authority, owner takeover and shared-VM stopping boundaries.
      [Deployed acceptance](reports/ordered-control-views-20261002.md) records
      measured read counts, real-model/browser/failure checks and preserved assets.

- [ ] Measure ADR-0211 probe scheduling lag and false-unconfirmed rate on actual
      multi-node fleets before raising concurrency or claiming fleet-wide detection
      deadlines. [Current acceptance](reports/execution-probes-20261002.md) proves
      160-target scheduling and single-host real execution, not physical fleet scale.
- [ ] Separate provider first-token latency from phase-aware first-display latency
      in future timing comparisons. Complete commentary waits for its provider
      text block; that interval must not be labelled entirely as internal relay time.

- [ ] Audit historical untracked Cube Volume references independently. ADR-0226
      repairs managed cleanup-reply loss using durable node state; it cannot
      fabricate missing historical node/store identity. The
      [older observed drift](reports/run-identity-acceptance-20260919.md) is not
      blanket evidence that every legacy count is safe to clear. Preserve guards
      until the recorded physical state is independently verified.

- [ ] Discuss drain/completion durability before any further boundary merging.
      [Terminal wake and transaction-local SQL](reports/terminal-wake-acceptance-20260918.md)
      are implemented; shared-row/WAL tails remain. The [ready-admission acceptance](reports/ready-admission-20260919.md)
      still saw a 353ms terminal tail, concentrated between settlement and seal
      publication; its exact wait was not sampled. Do not remove the drained
      output proof or weaken seals merely to reduce commit count.

- [ ] Attribute remaining cold-start and Node callback/CPU tails after
      [two-way admission](reports/parallel-claims-20260918.md). Four-concurrent
      startup median improved 213→194ms in the bounded comparison, but cold
      requests can still exceed 400ms. Some query spans include client-side
      delay after PG is already idle; do not label all elapsed time as WAL I/O.

- [ ] Isolate the remaining host-storage tail below the confirmed PG `WalSync`
      wait. The [approved NVMe A/B/A trial](reports/nvme-power-trial-20260918.md)
      did not eliminate >100ms tails, and original host settings were restored.
      [Native-host comparison](reports/native-storage-tail-20260918.md) also
      reproduces the tail on the SSD hosting WSL, while a second SSD did not in
      these samples. Distinguish competing I/O, device/driver and power behavior;
      no specific fault is established. The [Lenovo standard-mode A/B/A trial](reports/legion-performance-trial-20260918.md)
      reduced typical real-GPT startup from 119ms to 63ms, returning to 117ms
      after restoration, but >100ms storage tails survived. Original mode/plan
      are restored; no laptop-specific deployment default is justified. Durability stays on.
- [ ] Keep the [unexplained historical SSE opening](reports/stream-reopen-investigation-20260909.md)
      distinct from intentional stale-snapshot replacement. The final 200 browser
      checks have no unexpected openings; that does not identify the old root cause.
- [ ] Validate executor/node loss beyond ADR-0210's implemented boot-scoped
      admission and cgroup stopping. The earlier
      [generation study](reports/cube-execution-generation-study.md) remains historical
      evidence, not a statement that scoped fencing is absent today. Durable
      cross-boot process/result recovery and ordinary shell effects remain UNKNOWN.
- [ ] Validate PostgreSQL/PgBouncer failover, Cube compute-node drain and shared
      Volume attachment on actual independent machines.
- [ ] Measure producer latency across Session counts, canonical projection
      throughput/WAL and live-tail memory with 2,000/10,000 SSE connections.
- [ ] Validate KEDA and Kafka partition sizing against the intended enterprise
      workload, not only a single-host synthetic producer benchmark.
- [ ] Measure the shared Session writer/Projector across growing active and historical
      Lane counts; unlimited product defaults do not establish sustainable capacity.

## Deployment operations

- [ ] Investigate Cube standard-template snapshot restoration returning
      `reset guest time failed` despite READY status. Recreating the same-image
      template restores boot and image-queue acceptance, but the upstream failure
      mechanism is not established. Preserve creation uncertainty and node-absence
      requirements; no forced quota release or identity fabrication for failed
      allocations lacking a recorded VM/node. [Original evidence](reports/review-repair-20261004.md).
      The two legacy records/Volumes were removed during the owner's explicit
      [October 7 development cleanup](reports/review-release-20261007.md), after
      quiescence and confirmed managed Volume deletion; this does not establish
      the snapshot-restore failure's underlying cause.


- [x] Resolve the historical Cube node template-cleanup timeouts through current
      node discovery. [Acceptance](reports/template-cleanup-20261007.md) covers
      replica/artifact routing, retained failures, shared references and actual
      cleanup of the accumulated 55 candidates without weakening pinning.

- [ ] Investigate the 4GB Cube template restore failure seen after a WSL reboot:
      CubeShim's `SetGuestDateTime` RPC timed out twice before guest tools started.
      Rebuilding that specification from the same image restored creation, but
      the underlying snapshot/vsock failure is not yet established. No automatic
      template replacement, Tool retry or weaker readiness was introduced.
- [ ] Run the one-host installer on a genuinely clean machine; current K3s
      cutover tests do not establish that broader claim.
- [ ] Reconcile Cube Volume node references after host/guest loss; template cleanup
      via stable node identity is completed separately under ADR-0233.
- [ ] Decide a local Cube MySQL binlog retention policy. Earlier disk cleanup
      did not change its 30-day default. [Evidence](reports/environment-reset-20260910.md).
- [ ] Add deployment-specific Kafka TLS/SASL/ACL examples and wire real on-call
      notification destinations into Alertmanager.
- [ ] Validate deployment-owned coordinated PG/Kafka/Cube backup and restoration.
      The unsupported whole-system archive CLI is removed, not replaced by a
      claimed disaster-recovery product.
- [ ] Repeat GitLab project credentials, private clone, multi-user non-exclusive
      claims and elastic/machine Issue execution against an external TLS instance.
- [ ] Design GitHub user authorization before restoring App onboarding; current
      support is limited to already-bound integrations and environment Git credentials.

## Deliberately deferred capabilities

- [ ] Decide whether large text/structured Tool results need general attachments.
      Current Subagent results use ADR-0196's explicit bounded admission; image
      attachments do not imply unbounded ordinary result storage.

- [ ] Define project text-resource discovery separately from executable extensions
      if that feature is requested. Automatic AGENTS.md loading (review PI-06) was
      not an existing promise; the repair preserves pure chat without Cube and the
      code-owned Runner boundary. Trusted native hook composition does not itself
      implement durable user approval.

- [ ] Recheck DeepSeek's early assistant phase before enabling final-only streaming.
      The current route revises a Tool preamble from final_answer to commentary
      at completion; GPT's phase-aware presentation must not be copied blindly.
- [ ] Benchmark Standard/Fast on enabled GPT models before changing the default.
- [ ] Replace PiCloud's hosted-item adapter when pinned Pi has a backend-conformant
      native contract. Recheck Flash's Responses search when upstream support
      changes: Flash is selectable with the owner's requested `web_search`
      declaration, but September 26 probes still return no search on that route.
      Anthropic Messages search works; changing protocols or adding a substitute
      search tool remains a separate slice.
- [ ] Add generated-image results only with native storage,
      Compaction and cross-Worker/provider recovery contracts.

These are not authorizations for a new architecture or feature. Changes to
ownership, persistence, execution or recovery semantics require owner discussion.

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

## Cube completion → Kafka replies and UNKNOWN continuation

The owner-approved direction and implementation plan are recorded in
[ADR-0253](adr/0253-tool-reply-uncertainty-and-continuation.md). Source inspection
confirms a uniform seven-minute fixed-Tool reply wait, unconditional UNKNOWN
sampling interruption and three orphaned error recognizers. The preceding
receipt/preview repair is deployed; this new slice is implemented in source with
[verification and rollout pending](reports/tool-reply-continuation-20261016.md). Keep Pi final-result semantics and the accepted
volatile-result loss boundary; reuse the existing internal execution probe.

- [x] U1: distinguish effect uncertainty, explicit interruption conditions and
      fixed-Tool failures eligible for a readiness check; retain native Stop,
      Workflow interruption, publication fencing and controller-owned recovery.
- [x] U2: bounded fresh probe through the existing Session/guest/boot-reply path,
      with current binding/owner checks, coalescing and no native/context/PG sample.
- [x] U3: commit UNKNOWN then permit inspection only with confirmed readiness;
      interrupt repeated uncertainty and preserve single settlement/late-reply rules.
- [ ] U4: invocation-specific wait budget plus existing transport allowance;
      remove orphaned error branches and complete source/transport/fault gates.
- [ ] U5: scanned matched release and owned Luna/Cube/browser/input/recovery
      acceptance, proving one original effect and confirmed fixture cleanup.

## Guest → Cubelet result review

The [October 16 review](reports/guest-cubelet-result-review-20261016.md) is complete
against `06559532`, with isolated guest/PTY/native-driver evidence and passing
existing suites. It changes no runtime or deployed protocol.
The subsequent discussion and approved repair are recorded in
[ADR-0252](adr/0252-tool-receipt-and-ephemeral-preview.md). Source implementation
adds incremental display/reset semantics and terminal-aware previews. The
[delivery record](reports/tool-receipt-preview-repair-20261016.md) tracks source
verification and the pending matched deployment/live acceptance. All source/native/
fault gates and eleven artifact scans pass. The owner-authorized Windows rollback
and reboot restored KVM; actual VM creation and all four new templates pass.
`tool-preview-325f0ebd` is deployed with Ready application workloads. Continuous
previews, one Control Plane replacement and receipt-only loss preserving the
result/background server/sibling process pass. Complete targeted/native-input/
browser/full-Cube acceptance subsequently passes. The empty-Session recovery
probe measured 30 seconds, explaining the old 25-second test deadline; the corrected
fixture retains all assertions and records actual recovery. Earlier external
AnyTLS-path failures remain a separate backlog item below. The release operator checks KVM device
availability on every Cube compute node before draining.
The Windows-local web-entry gap found after reboot is repaired with a standard
systemd socket proxy in the local WSL deployment adapter; direct Windows/Linux
HTTP checks and removal/reinstallation pass.

- [x] R16R-01: distinguish receipt-only transport failure from unfinished or
      unsafe execution. A complete valid result plus confirmed local settlement
      must not be discarded or trigger operation-cgroup cleanup solely because
      the reverse receipt failed. Preserve the bounded receipt, UNKNOWN for
      missing evidence and Control Plane lifecycle ownership; record the revised
      termination contract in an ADR before implementation.
- [x] R16R-02: bound encoded preview data at the guest transport boundary and
      remove repeated arguments/truncation text from observations. Preserve final
      native results and lossy HTTP/SSE semantics; test large/escaped output and
      ordinary final-result delivery. Deliver revision-bound edits plus bounded
      resets across every coalescing boundary; cover missing bases, reconnect,
      owner changes and final completion overtaking observations.
- [x] R16R-03: interpret CR/ANSI progress updates before forming display edits;
      current stripping concatenates successive progress labels. Evaluate the
      pinned headless terminal behind the preview port, keeping ordinary pipe
      execution and final result collection independent. Verify bounded parser
      overload, Unicode, split controls and actual guest/browser rendering.

## Cubelet → guest execution review

The [October 15 review](reports/cubelet-guest-execution-review-20261015.md) is complete
against `c3837bdb`, with existing suites and reproducible isolated evidence.
The owner-approved repairs under [ADR-0251](adr/0251-guest-attachment-and-execution-bounds.md)
are deployed as `guest-execution-5536fc73`, guest protocol 6. The
[delivery record](reports/cubelet-guest-execution-repair-20261015.md) covers passing
CI and live acceptance, first-attempt streaming uncertainty, the extra startup
failure during injected dual crash, preserved configuration and confirmed cleanup.

- [x] R15G-01: bound the final cleanup-helper Kill after its parent budget expires.
      Preserve UNKNOWN/unsafe outcomes, operation scope and Control Plane lifecycle ownership.
- [x] R15G-02: align custom Read path interpretation with pinned Pi and native
      Edit/Write, including alias/Unicode and ambiguous-name contract cases.
- [x] O15G-01: separate ordinary Tool attachment parameters from full VM
      initialization; remove unused recipe/seed fields through an explicit matched protocol change.
- [x] O15G-02: recheck expiry before issuing native Start; do not call an
      already-issued or ambiguously acknowledged Start definitely unexecuted.

## Projector → Cube handoff review

The [October 15 handoff audit](reports/projector-cube-handoff-review-20261015.md)
reviews `93635d37` and the exact pinned Cube patches. It preserves confirmed
dispatch-before-effect and UNKNOWN semantics. Source/isolated probes pass; this
review does not change runtime behavior or count as new live fault acceptance.

The owner approved [ADR-0250](adr/0250-cube-handoff-outcomes-and-runtime-admission.md).
[Repair progress](reports/projector-cube-handoff-repair-20261015.md) distinguishes
source changes, checks and matched delivery. D15H-01 is a pinned-Pi upgrade check;
no batch-position protocol extension is included in this repair.
The repair is deployed as `handoff-6ab91bb7`; source/native gates, full Cube,
native-input/browser/child recovery, configuration preservation and cleanup pass.

- [x] R15H-01: keep takeover failure notification independent of quarantine
      success; preserve lifecycle reconciliation and never replay committed Tools.
- [x] R15H-02: classify endpoint rejection code and effect evidence separately.
      Preserve definite pre-execution refusals; unknown semantics stay UNKNOWN.
- [x] R15H-03: make removed-VM admission and position cleanup share the native
      lifecycle boundary. A delayed Submit must not recreate historical position
      state after confirmed absence. Cover the check/admission/deletion race.
- [x] O15H-01: use the existing exact binding key for ordinary Tool/cancel lookup,
      retaining owner/tenant/closure checks and explicit enumeration where needed.
- [x] D15H-01: preserve the current native parallel-read intent grouping as a Pi
      upgrade contract test. No runtime batch restriction or position field is
      added. Revisit the protocol only if a real producer path needs multiple
      Cube effects in one record; ordinary concurrent tools do not imply that.

## Projector message and decoding review

The [October 15 focused review](reports/projector-envelope-review-20261015.md)
audits baseline `c3aca045`. Its 89 existing contract tests pass; isolated probes
reproduce retained child prefixes after writer closure, duplicated Tool display
bodies and repeated intent lookups. That review did not change runtime protocols;
the approved implementation follows below.

The owner subsequently approved implementation under
[ADR-0249](adr/0249-compact-projector-publication.md). The
[repair record](reports/projector-repair-20261015.md) records verified source and
the matched `projector-compact-bf55d9bd` deployment, real acceptance and cleanup;
the review evidence above remains tied to its baseline.

- [x] R15P-01: replace the internal full-text prefix with the minimum sequence
      state and clear every child view on forced writer closure. Preserve missing
      prefix detection, handoff positions, conflict checks and the public live view.
- [x] O15P-02: reuse validated per-record dispatch preparation and bounded native
      write lookup; remove repeated expansion without changing batch order,
      identity checks, projection transactions or commit-before-effect.
- [x] O15P-03 / C15P-01: deliver a matched compact envelope: inherit shared writer
      identity, derive aliases, share the original Boot reply target, and remove
      the unused standalone cancellation publisher. Separate wire facts from
      expanded commands; preserve self-contained control-tool recovery metadata.
- [x] O15P-01: extend same-commit presentation references to duplicated Tool
      input/result display bodies, keeping native interpretation in Worker and
      final results after Pi processing. Do not recreate a second result store.
- [x] O15P-04: separate fixed Cube request fields from workflow context checks
      and remove unused fixed-Tool context hashes. ADR-0249, matched guest protocol 5
      and fencing/cancellation/output-budget acceptance are complete.

## Reliability and capacity

The [October 14 complete Control Plane outage check](reports/control-plane-outage-20261014.md)
passes same-Run/Worker/lease/VM continuation, Kafka buffering and idempotent new
intake after 65 seconds at zero replicas. This is same-version recovery evidence,
not a new deployment operator or a guarantee for every active transport.

- [x] Implement [ADR-0248](adr/0248-idle-worker-management-reconnect.md) A1–A4:
      idle connection expiry/re-registration, atomic Boot/claim admission,
      failure tests and matched deployment/live acceptance. It is deployed as
      `worker-reconnect-5b6ba003` / schema 189; repository checks, 60/90-second
      outages and actual SIGKILL pass. [Delivery evidence](reports/idle-worker-reconnect-20261014.md)
      records full native-input, Cube, browser and final-patch outage acceptance,
      the input receipt read repair, preserved configuration and physical cleanup.
- [ ] Verify the dispatch-commit/Cube-handoff window and interactive workflow,
      terminal and preview connections before claiming fully transparent Control Plane updates.
- [ ] Test owner-address cache invalidation when one surviving Control Plane keeps
      forwarding to an exited peer; the zero-replica check restarts all such caches.
- [ ] After the handoff gates, provide a maintained compatible Control Plane-only
      image-replacement procedure with readiness, graceful exit, measured recovery
      and recorded rollback. The full matched-release operator still drains work;
      do not apply the lighter procedure to schema/Worker/Pi/Cube contract changes.
- [ ] Evaluate renewal of the existing 24-hour Boot registration credential before
      claiming long-lived Workers can reconnect indefinitely across Control Plane updates.
      Expired/revoked credentials still fail closed; management reconnect does not renew them.
- [x] Align the security-update download path with the existing Debian mirror
      policy after a proxied Debian download returned 502. The final release keeps
      exact security package versions and passes all artifact scans.
- [ ] Have the full Cube production driver invoke the existing owned-tenant purger
      after physical cleanup; it currently leaves its temporary account metadata.
      This delivery explicitly purged its three exact fixture identities, with
      the original account/configuration counts and digests restored.

The [October 13 consolidated plan](adr/0247-session-work-and-tool-dispatch.md)
is deployed as `session-work-6ac697f9`, schema 188 / execution-topic v16 / boot
reply v3. The [implementation evidence](reports/session-work-implementation-20261013.md)
records source, transport, recovery and rolling-replacement gates.

- [x] R13S-01 / P0: prove the public Pi APIs can manage native child creation,
      input identity, wait/blocked, supervisor exchanges, cancellation and recovery
      without a cloud child Run; freeze identity and completion mappings first.
- [x] R13T-01 / P1: co-commit ordinary cloud Tool dispatch with native intent;
      move trusted Tool business logic to handlers and unify final Kafka replies.
      Preserve Cube execution, dynamic workflow calls, mixed-record offset safety,
      long waits, typed failures, cancellation and native final settlement.
- [x] R13S-02 / P2: keep only root cloud work in Run admission. Migrate child
      models, resources, input/Stop, display/history, attachments and cleanup to
      root Run plus native identity. Remove child claims and duplicated command
      bodies/state only after every existing subagent action has a working replacement.
- [x] R13K-02 / P3: separate native child outcomes and ordered root-work completion
      from Session writer closure. Remove per-child seals/unsealed-count dependencies
      without weakening input races, history/SSE coverage or old-owner recovery proof.
- [x] R13K-01 / P4: implement direct Session producers with fresh post-init PG
      admission, control ordering, bounded fencing recovery and same-load resource
      measurement. Six RF3/PG primitive probes and two current ingress tests are
      baseline evidence. The direct publisher is wired; RF3/PG takeover, delayed
      initialization and same-Run recovery tests pass. Repository, real-model recovery
      and rolling-replacement gates pass.
- [x] R13U-01 / P5: complete the matched destructive cutover, retained-configuration
      checks and Luna/Cube/browser acceptance. Then prove compatible Control Plane
      handoff during active root work with Worker/Pi/Cube and protocol contracts fixed,
      instead of waiting for an entire Agent family to finish.

- [ ] Attribute and reduce Control Plane handoff latency before setting a user-visible
      availability target. The final image/stream case observed a 13.833-second Pod
      replacement and a 35.368-second maximum text-update gap; model generation,
      SSE reconnect and projection recovery need separate timings. Also measure
      native Session producer threads/FDs at larger concurrency before capacity claims.

[ADR-0243](adr/0243-native-input-current-state.md) is deployed with schema 185 as
`native-input-current-e82d00b7`. [Source and live acceptance](reports/native-input-current-state-20261012.md)
cover current Inbox/Submission values, checked reconstruction, actual Worker SIGKILL,
Stop/return, images and full Luna/Cube use. Configuration is preserved and fixtures
are physically cleaned. [ADR-0244](adr/0244-kafka-backed-native-live-state.md)
is deployed as `native-live-1370d871` under schema 186. Streaming live retention,
actual dual-process recovery and live acceptance are tracked in its
[report](reports/native-live-state-20261012.md).

The [native-log research/review](reports/append-only-storage-review-20261011.md)
compares pinned Pi, Maka, Marten, Pekko and Temporal. It retains the current four
storage tables and Session-local sequence; no runtime change was deployed.

- [x] R11L-01: validate retained journal counts/checksums and latest required
      current state during reconstruction, under ADR-0243. Missing/changed bodies
      fail with transactional index rollback; quiescent reconstruction and real
      asset restore preserve current values.
- [ ] O11L-01: reuse already-scanned document metadata in the bounded cold-read
      cache. One measured 512 KiB document read uses three SELECTs; the isolated
      reuse prototype uses two with identical content. Preserve cache invalidation.
- [ ] D11L-01: discuss retention of superseded native Task checkpoints and
      current-only document history beyond ADR-0243 input state. Streaming pi.live
      Kafka-only retention is deployed under
      [ADR-0244](adr/0244-kafka-backed-native-live-state.md). It retains small commit
      headers and verifies current reads,
      handoff, multi-Conversation replay references and attachment safety. Task
      reclamation remains separate work.
- [x] R12T-01: [ADR-0245](adr/0245-native-commit-text-presentation.md) uses
      same-commit assistant display descriptions without a copied text publication.
      Deployed as `native-text-c9b8b2a3`, schema 187 / topic v15. Source/fault checks,
      live input/Stop and dual-process recovery, browser/image, all multi-Conversation
      scenarios and full Cube acceptance have passing evidence. Interrupted
      upstream-TLS attempts and focused reruns are distinguished in the
      [report](reports/native-text-presentation-20261012.md).

- [x] Localize the intermittent model TLS failure: the
      [October 12 investigation](reports/model-egress-tls-20261012.md) reproduces
      the same three-second EOF directly through v2rayN/sing-box, without PiCloud
      or model requests. The pinned AnyTLS acknowledgement deadline matches the
      timing; a separate node TCP-connect timeout is confirmed by proxy logs.
- [ ] Resolve the external AnyTLS-path instability using node-side evidence or an
      operator-selected alternate path. The acknowledgement-timeout mechanism
      remains an inference until correlated with the node/runtime. The unchanged
      full Cube suite passed at 05:23 UTC; that closes the acceptance gap without
      proving intermittent connectivity fixed. Preserve the failed samples and
      keep Pi as the single model retry owner.

The approved [publication-registration optimization](reports/publication-admission-20261011.md)
is deployed as `publication-admission-c39a78f8`: known stale/closed identities
are rejected before PG, while potentially successful registration retains PG
authorization and closure/replacement guards. Source, RF3/PG, real Luna input/Stop
and Control Plane SIGKILL acceptance pass; owned fixtures are physically cleaned
and original accounts/configuration are preserved.

The owner approved R10C-01–04 from the
[Worker-claim table review](reports/worker-claim-schema-review-20261010.md).
[ADR-0242](adr/0242-worker-claim-schema-cleanup.md) implements bounded index access,
Run history indexing, removal of unused physical-Session metadata and Worker
database naming. [Source verification and matched deployment](reports/worker-claim-repair-20261010.md)
are complete as `worker-claim-5c803cc5`, schema 184. Real Luna/native-input/browser
and Worker failover/crash recovery pass; owned fixtures are cleaned and original
configuration fingerprints are preserved. Existing Run/lease/closure authorities remain.

[ADR-0241](adr/0241-missing-working-directory-tool-errors.md) is deployed as
`working-directory-889279b2`. [Source, fault and live acceptance](reports/working-directory-20261010.md)
verify known directory errors, same-Run continuation, explicit restoration and
preserved VM identity. The matched images include required Go/x-net security
updates; owned resources are cleaned and original configuration is preserved.

- [ ] Reassess long model output if the large-Read fixture recurs after its
      exact-short-label prompt. October 12 evidence located the delay in active
      model text streaming after Read (HTTP 200, 3.4 MB over 234 seconds), not an
      idle transport. The bounded repeat passed; no provider timeout or Tool-byte
      assertion was weakened. [Evidence](reports/native-input-current-state-20261012.md).

The [input-admission release](reports/input-admission-20261010.md) is deployed as
`input-admission-db0548b8` on schema 183. Initial intake uses eight business SQL
statements, and same-key retry uses two. Source/fault and real HTTP/Luna/Cube/browser
checks pass; original configuration is preserved and owned fixtures are removed.

The preceding [projection and commentary release](reports/projection-release-20261009.md)
deployed `projection-b14c3777` on schema 183. ADR-0239's SQL optimization
and shared text animation pass source and real Luna/Cube/browser acceptance;
owned fixtures are cleaned and original accounts/configuration remain intact.

[ADR-0238](adr/0238-native-input-queue-and-run-record.md) is implemented and
verified in source: two core Session/Run records, native follow-up/steer/editing,
confirmed native intake and removal of holding Runs/reconciliation. R08T-01–05
are complete in that slice, including unused columns, Worker naming and
first-position-only native projection writes. See the
[implementation evidence](reports/native-input-run-consolidation-20261009.md).

The [schema 183 matched release](reports/native-input-release-20261009.md) is
deployed as `native-input-a71a4807`; native queue, real Luna/Cube/browser and
configuration-preservation checks pass. Owned fixtures are physically cleaned.

The [architecture evidence review](reports/architecture-evidence-review-20261007.md)
prioritizes one bounded handoff/operability slice over another broad runtime
rewrite. The owner approved this slice; current source implementation includes:

- [x] D07-01: make the existing matched upgrade and its targeted live acceptance
      reproducible from maintained sources; remove caller-umask dependence from
      source verification and make fixture configuration restoration explicit.
      Preserve artifact checks, scoped cleanup and the serving release on preflight failure.
- [x] D07-02: mark superseded Run/Stop/Storage clauses in ADR-0161/0209/0219 and
      reconcile them with ADR-0229/ARCHITECTURE, without changing runtime behavior.
- [x] D07-03: define [bounded pilot criteria](PRIVATE_PILOT.md), intervention
      accounting and stop conditions. Actual pilot results remain unmeasured.
- [x] D07-04: add the optional [cold asset procedure](ASSET_RECOVERY.md) and real
      PG/two-store restore drill under ADR-0237. New Workspaces and fresh grants
      replace old execution/resource authority; exact native history and images survive.

The [matched release procedure](MATCHED_RELEASE.md) is maintained in source.
The [matched rollout](reports/readiness-release-20261007.md) now exercises this
workflow on the existing cluster. Operator driver fixes cover queued-image
visibility and cleanup after Stop; the final live acceptance passes. No new
runtime authority or protocol was introduced.
[Implementation and verification](reports/private-readiness-repair-20261007.md).

The same review proposes a small private-use pilot with agreed outcome/intervention
criteria before expanding infrastructure. Existing fresh-machine, fleet-load and
whole-deployment recovery items below remain separate claims. The owner explicitly
deferred backups of current disposable data; no backup or pilot was started.
Off-machine retention remains necessary before relying on irreplaceable history.
R07R3-04 remains owner-deferred.

The [recovery and boundary review](reports/repository-review-20261007-r3.md)
is complete at `1e7e21eb`, covering all 22 workspaces. Its new characterizations
leave product behavior unchanged. The subsequently approved repairs follow
[ADR-0236](adr/0236-recovery-input-identity-and-tool-diagnostics.md) and the
[source verification record](reports/review-repair-20261007-r3.md):

- [x] R07R3-01: distinguish cancelled, unstarted queue inputs from later actual
      executions when recovering a failed Session. Preserve exact exit/seal and
      stale-owner guards; verify both proof orderings with Stop queue return.
- [x] R07R3-02: end the matching uncertain submission identity when stopped input
      returns to the composer, so resending admits new work. Preserve newer
      post-Stop intents, unchanged retries, late ACKs and attachments.
- [x] R07R3-03: align oversized-line Read content and continuation diagnostics
      with pinned Pi 1.0 while preserving bounded source reads and image support.
- [ ] R07R3-04: remove CubeMaster's full configuration dumps and verify that
      startup/validation/reload logs exclude synthetic credential canaries.
      Explicitly deferred by the owner on 2026-10-07 for private deployment.
- [x] O07R3-01: avoid cold document-revision SQL when the acknowledged overlay
      contains the complete requested base/suffix. Retain native historical,
      version, checkpoint and eviction semantics and measure materialization cost.
- [x] Remove the unused Pi 0.84 model-stream classifier and simplify overlapping
      README release narratives while preserving versioned design evidence.
- [x] Deploy matched Tool Worker protocol 4 artifacts and the updated returned-input
      API/browser after draining old writers. No old-protocol compatibility mode.
      [Matched rollout and cleanup](reports/review-release-20261007-r3.md) preserve
      29 accounts/tenants and 30 model profiles; all owned live acceptance passes.

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
- [x] Deploy matching application/Gateway and guest-protocol-4 artifacts after
      draining old uploads. [Release evidence](reports/review-release-20261007-r2.md)
      records destructive development cleanup, preserved configuration, matched
      protocol 7 / Tool Worker 3 artifacts and live acceptance (ADR-0235).
- [x] Rerun the additional whole-production multi-Run/cold-VM gate. The
      [new review's live evidence](reports/repository-review-live-20261007-r3.json)
      passes 21 Luna requests, preview/background reuse and fresh-VM Volume
      restoration without product changes. The prior model-proxy HTTP 500 cause
      remains unconfirmed; its historical failed runs are not relabeled as passing.

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
      in future timing comparisons. Native partial-commit coalescing, transport
      and browser animation contribute separate delays; they must not all be
      labelled as internal relay time.

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

- [ ] Wait for current Cube node registration/health before template creation
      after native replacement. In the October 15 matched release, Kubernetes
      readiness preceded Master discovery of the new Cubelet address; template
      creation failed while Master still polled the old Pod IP. A second apply
      of the same scanned artifacts passed after registration and complete
      zero-VM inventory. Add a bounded native-readiness gate and a replacement
      regression; retain fail-closed cutover and physical cleanup requirements.
      [Evidence](reports/projector-repair-20261015.md).

- [ ] Reconcile the build host's Docker daemon proxy with its current proxy
      endpoint. October 10 uncached pulls needed a temporary loopback relay;
      it was removed after building and is not a runtime component. Host service
      configuration was not changed by that release.

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
      claimed disaster-recovery product. ADR-0237's bounded conversation/image
      restore is verified separately; it excludes old Kafka work, VMs and Workspace
      files and does not establish physical-node HA or a full-deployment restore.
- [ ] Repeat GitLab project credentials, private clone, multi-user non-exclusive
      claims and elastic/machine Issue execution against an external TLS instance.
- [ ] Design GitHub user authorization before restoring App onboarding; current
      support is limited to already-bound integrations and environment Git credentials.

## Deliberately deferred capabilities

- [ ] If a second sandbox backend is selected, evaluate its public execution,
      cancellation/output-retention and lifecycle contracts against
      [the October 8 source study](reports/sandbox-result-portability-20261008.md).
      Record an ADR and run the same failure/isolation acceptance before enabling
      it. The study does not authorize a backend migration or new execution authority.

The [October 7 Flash acceptance](reports/deepseek-flash-acceptance-20261007.md)
passes ordinary text, file/Bash tools, high-thinking follow-up and image input.
It leaves the hosted-search investigation below unchanged and adds no runtime
or model-configuration change.

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

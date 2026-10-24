# Documentation map

The [Preview answer-link delivery](reports/preview-answer-delivery-20261024.md)
is deployed as `preview-answer-16f8f8b5`, schema 198. It removes separate application
cards, retains expandable Tool details and verifies actual live/cold named-link
navigation. The matched dependency updates and both restored applications are recorded.

The [initial-message handoff repair](reports/input-handoff-delivery-20261024.md)
is deployed as `input-handoff-2a5a2ffd`, retaining schema 198. Missing input metadata
no longer renders as placeholder user text, and service-start instructions permit
readiness checking within the same Bash invocation. Original assets are preserved.

The [composer and pending-queue delivery](reports/composer-queue-delivery-20261023.md)
publishes configurable Enter behavior and a compact native-input queue through the
Web component path. Pi execution/input timing and backend contracts are unchanged.

[ADR-0273](adr/0273-resource-intent-and-machine-recovery.md) is deployed as
`resource-intent-cad5487a`, schema 198. PG retains resource intent and lifecycle
completion; Cube supplies disposable physical observations. Dedicated machines
keep their product identity across confirmed allocation replacement. Direct
lifecycle calls use Cube management; Session bindings retain their Kafka path.
[Delivery evidence](reports/resource-intent-delivery-20261023.md) records source,
370 fault cases, matched artifacts, real pause/owner/VM recovery, retained child
previews and original asset preservation.

The [elastic retention decision](adr/0272-cube-owned-elastic-retention.md)
lets Cube own finite idle expiry. Silent active
Sessions renew through the existing Kafka path; long Tools and human activity
have explicit coverage. The owner accepts expiry after a prolonged renewal-path
outage. It was first deployed as `elastic-retention-03ce2f23`, schema 197. The
[delivery record](reports/elastic-retention-delivery-20261023.md) covers source,
12-image evidence, real default-window expiry, native recovery and asset preservation.
Dedicated-machine recovery follows ADR-0273 above.

[ADR-0271](adr/0271-local-upstream-proxy-configuration.md) and the
[proxy command](CONFIGURATION.md#provider-egress) provide one local upstream
address for host builds, Docker, the model Relay and Cube egress. The October 22
switch to port 12450 is applied; repeated application preserves process/Pod
identities and the PG revision. The [delivery record](reports/guest-browser-delivery-20261022.md)
distinguishes successful configuration checks from transient upstream TLS failures.

[ADR-0270](adr/0270-guest-browser-and-tool-result-actions.md) adds a preinstalled
guest Playwright/Chromium stack and consistent live/cold Tool-result metadata.
Its October 24 presentation amendment removes separate Preview cards in favor
of named answer links, without answer inspection or fallback actions. The guest capability is
deployed as `guest-browser-bd03f7a6`, schema 197. Real Luna guest interaction,
screenshot vision and live/cold preview navigation pass; it introduces no browser
service or new execution authority. The owner-authorized old Workspace deletion
is complete and its conversation remains available.

The [Subagent wait investigation and Ultra proposal](reports/subagent-wait-review-20261021.md)
records the authorized Stop, successful delayed child result, model/environment
costs and the corrected single-picker Ultra proposal (provider Max plus delegation).
The consolidated plan uses native Pi instruction sections, retains explicitly
requested delegation outside Ultra, and sequences egress/capability repair,
compact child progress and execution-owned tool-catalog delivery. Tool updates use
complete effective lists rather than a cache-preserving loading protocol; parent
details stay collapsed until opened. The [delivery](reports/runtime-capabilities-delivery-20261021.md)
is deployed as `runtime-capabilities-5d39828d`, schema 197. It records the native,
browser, model and catalog checks, authorized Workspace deletion and the separate
rolling-owner admission gap. Single-controller compatible updates use the
existing stop-old/lease-closure/start-new order.

The [Run status presentation update](reports/run-status-presentation-20261021.md)
keeps phases and warnings visible while collapsing diagnostic ages. It is deployed
through the existing operator's Web scope, preserving backend/VM identities.

[ADR-0267](adr/0267-scoped-releases-and-model-catalog.md) and the
[component release procedure](COMPONENT_RELEASE.md) are deployed on schema 196.
[Delivery evidence](reports/component-release-20261021.md) verifies independent
provider/catalog updates during native work, immutable Run snapshots, unchanged
Worker/VM identities, actual model capabilities and confirmed cleanup.

The [GPT-6.1 Sol amendment](adr/0191-gpt6-model-catalog.md) updates the reviewed
model catalog and future Sol settings under schema 195. It is deployed as
`gpt61-sol-8827da09`; [delivery evidence](reports/gpt61-sol-20261021.md) records
passing Standard-mode model/native-Tool acceptance and cleanup. Effective Fast
routing remains an explicit follow-up. Historical model evidence and other
provider routes are retained.

The [October 20 resource/interaction repair plan](reports/resource-interaction-repair-plan-20261020.md)
organizes the 16 findings and follow-up discussion into six repair slices.
It prioritizes live VM holders and supervisor quiescence, then proposes native
delegation recovery/discovery, evidence-based Volume cleanup, attachment
lifetimes and terminal/preview teardown. [ADR-0264](adr/0264-subagent-recovery-and-discovery.md)
is owner-approved for the child contract, including separate safe/unsafe Tool
registrations and current-owner reply delivery. All six source slices are deployed
as `resource-repair-1cdccb80`, schema 194 / Session topic v18. The
[delivery record](reports/resource-interaction-repair-20261020.md) records passing
source/artifact, recovery, long-work, browser, upload and Cube gates plus scoped
cleanup. The unchanged combined 6/6/25 MB model/cold-recall gate also passes
after the proxy-node change. Earlier upstream timeouts and one incorrect
model answer remain recorded separately; single-image 24.2 MB recovery passes too.

The [October 20 combined resource/interaction review](reports/resource-interaction-review-20261020.md)
completes all four agreed branches and prioritizes 16 findings. The final
[terminal/preview slice](reports/terminal-preview-review-20261020.md) records
redirect, handshake, pending-connect cancellation and shutdown races, supported
by 70 existing cases and four isolated transport characterizations. The combined
report separates confirmed defects, design discussion and evidence gaps.
These are historical review records; the subsequent deployed fixes are linked above.

The [October 20 upload/attachment review](reports/upload-lifecycle-review-20261020.md)
is the third resource/interaction slice. It records premature permanent pins,
late PUT/GC inventory loss for long uploads, missing image-read cancellation and
early-refusal source cleanup. Existing and isolated tests are distinguished from
live S3/Cube acceptance. The review itself made no runtime change; its deployed
repair is linked above.

The [October 20 Subagent lifecycle review](reports/subagent-lifecycle-review-20261020.md)
is the second resource/interaction slice. It records four runtime findings, a
direct-child discovery design gap, seven-SQL repeat reconciliation and documentation
drift. Five real-PG probes and a bounded result-reachability experiment distinguish
confirmed behavior from the earlier live model's repeated delegation. No fix or
deployment is included; the subsequent reviews are linked above.

The [October 20 Workspace/Volume lifecycle review](reports/workspace-volume-lifecycle-review-20261020.md)
starts the agreed resource/interaction branch reviews. It confirms in-use compute
retirement, terminal-only duplicate adoption, nonconverging unknown Volume references
and admission lock-order findings, plus two simplification opportunities. Existing
tests and isolated PG/native probes are recorded separately; no runtime repair or
deployment is claimed. The subsequent branches are now complete as linked above.

The [October 19 model request/response review](reports/model-request-response-review-20261019.md)
and [approved repair](reports/model-request-response-repair-plan-20261019.md) are
complete. [ADR-0263](adr/0263-model-response-and-work-lifetimes.md) is deployed as
`model-runtime-058925bb`, schema 192: no overall Agent deadline, owner-bound model
grants, bounded Worker retirement and one public Models response adapter. Native
retry, early phases, completed hosted content and semantic outcomes retain one
owner; Gateway remains HTTP transport.
[Delivery evidence](reports/model-runtime-repair-20261020.md) records source/artifact,
real 16-minute work, graceful handoff, hosted/native/browser/child/outage/image/Cube
acceptance and cleanup. It retains the first failed child sample, its model-issued
second delegation and the unchanged passing repeat.
[Reading progress](READING_PROGRESS.md) records the completed main-message walkthrough.

The [October 19 replacement Worker → Pi Harness review](reports/worker-harness-recovery-review-20261019.md)
checks native cold open, pending input, child rebinding, unsafe Tool non-replay and
Stop during restoration. 110 existing tests, seven isolated behavior cases and
six cost samples pass. It records unbounded Worker data reads, dropped read
cancellation, per-child metadata round trips and repeated image hydration.
The subsequent historical-growth check adds missing Submission-status access
paths: completed receipts can increase filtering work despite a constant SQL count.
The [proposed repair plan](reports/worker-harness-recovery-repair-plan-20261019.md)
records bounded/cancellable reads, existing closure-based retry, status indexes,
native child reattachment and conditional scoped image reuse.
[ADR-0262](adr/0262-native-recovery-read-lifetimes.md) deploys the read,
status-index and child reattachment repairs as `native-recovery-8c00826a`, schema 191.
The image check retains per-decode validation because Pi's public hooks run after
context has already been read.
[Implementation and verification](reports/worker-harness-recovery-repair-20261019.md)
record source/artifact, native/browser, actual child Worker recovery, Control Plane
outage, unchanged 6/6/25 MB image cold recall and full Cube acceptance. Physical
cleanup and original configuration preservation are confirmed. The architecture
still uses one Session owner and Pi's native scheduler; the subsequent model-branch
review is recorded above.

The [October 19 Kafka seal → Projector → PG review](reports/seal-projection-review-20261019.md)
checks exact handoff checkpoints, atomic closure/release, duplicate seals and
successor admission. 175 existing tests, five isolated characterizations and four
query-cost cases pass. Findings cover unbounded outer PG waits, a retained live
cache after lost COMMIT return, lifetime header scanning and a duplicate locked
Run read. The review itself changed no runtime.
The owner-approved [ADR-0261 repair](adr/0261-session-seal-projection-boundaries.md)
is deployed as `seal-projection-0de1fe7f`; [verification and delivery](reports/seal-projection-repair-20261019.md)
record 1,937 workspace tests, nine RF3 cases, 323 fault cases and eleven artifact
scans. Native/browser/child/outage/full-Cube gates and physical cleanup pass.
That release's large-image cold recall remained unaccepted after model
response-header timeouts; the current release passes the unchanged gate.
Original configuration is preserved. Initial fixture/artifact and
upstream failures are retained separately. Replacement Worker/Harness bootstrap
is reviewed and repaired above.

The [October 19 Outbox → Kafka seal review](reports/seal-publication-review-20261019.md)
checks persisted requests, retries, PG authority reads, producer takeover and
publication retirement. Forty-six existing tests, six isolated characterizations
and one real RF3/PG integration case pass. Findings cover unbounded PG waits,
consumer lifetime during background restart and a stale peer route already
deferred in the backlog. Three authority reads straddle different actions; the
measured no-binding local path uses six SQL statements. This is review-only;
Kafka → Projector closure and successor bootstrap remain the next walkthrough.
The approved [ADR-0260 repair](adr/0260-session-seal-publication-lifetimes.md)
is deployed as `seal-publication-8d9e7bc2`.
[Verification and delivery](reports/seal-publication-repair-20261019.md) record
the bounded publication pool, reader retirement and peer rediscovery, 1,924
workspace tests, nine RF3 cases, 311 fault cases and eleven artifact scans. Relevant
live gates and physical cleanup pass with original configuration preserved.
Initial upstream TLS/timeout failures and the unchanged repeat after the owner's
proxy-node switch remain explicit.

The [October 18 Control Plane → PG expiry review](reports/control-plane-expiry-review-20261018.md)
explains timed scans, locked rechecks and atomic seal-request admission. Fifty
existing tests and six isolated characterizations support lock-wait coupling,
failed-Worker retirement gaps and a default-window starvation case with eleven
Workers. SQL traces show two idle-scan statements and unnecessary growth with
healthy Sessions. Probe corrections and the current two-Worker scope are explicit;
no runtime or deployment changes are included.

The approved [ADR-0259 repair](adr/0259-control-plane-expiry-progress.md) is deployed
as `control-expiry-c9d8112d`, schema 190. [Verification and release](reports/control-plane-expiry-repair-20261018.md)
record 1,912 distinct workspace tests across the original run and focused correction,
79 helpers, nine RF3 cases, 311 fault cases and eleven artifact scans. Native,
browser/image, child, Control Plane outage and full Cube acceptance pass. Original
configuration fingerprints match and owned fixtures are physically cleaned; the
initial test failures and retained upstream TLS sample are explicit.

The [October 18 Worker → PG Session lease review](reports/worker-session-lease-review-20261018.md)
checks direct renewal, local authority observation, SQL/lock boundaries and
management reconnect. 123 existing tests and four isolated characterizations
pass. It finds pending-I/O deadline enforcement, quarantine-before-local-abort
ordering and cross-Session renewal lock coupling. Ordinary renewal remains three
business SQL statements for one or eight Sessions. No runtime or deployment
changes are included; forced closure/successor recovery is the next walkthrough hop.
The owner-approved [repair](adr/0258-bounded-session-lease-renewal.md) is deployed as
`session-lease-079dbddc`. [Verification and delivery](reports/session-lease-repair-20261018.md)
record 1,897 workspace tests, 302 fault cases, eleven artifact scans, live Worker/
image/child recovery and 65-second control-independent renewal. Original configuration
checksums match and owned fixtures are physically cleaned; the initial type/fixture
corrections and upstream TLS sample remain documented.

The [October 18 Projector → browser review](reports/projector-browser-review-20261018.md)
checks canonical history/live-tail composition, SSE and browser presentation.
117 existing tests, the real-browser gate and four isolated characterizations
pass. It finds stale observation revisions across same-Run Worker replacement,
count-only slow-reader buffering, obsolete commentary compaction rules and stale
25 ms text-buffer documentation. Repair directions preserve the current
execution/storage authorities; no runtime repair or deployment is included.
The approved [repair](adr/0257-browser-observation-and-buffer-boundaries.md)
uses the existing execution generation for status frames, a pending-byte budget
and same-message commentary compaction. It records why forcing a transcript
refresh at a recoverable seal is broader than the status fix. The repair is
deployed as `browser-delivery-205e6ac0`; the
[delivery record](reports/projector-browser-repair-20261018.md) records 1,884
workspace tests, 79 helper tests, nine RF3 transport cases, 294 fault cases and
eleven artifact scans. Same-SSE Worker recovery, browser, image, child and full
Cube acceptance pass. Owned fixtures are physically cleaned and original
configuration fingerprints match. The first CI failure and Go test-directory
correction remain documented separately from the final passing run.

The [October 18 Session publication/completion review](reports/session-publication-completion-review-20261018.md)
rechecks direct Kafka submission and whole-Run retirement after the recent
changes. It reproduces a missing normal-terminal replay notification and a
proved pre-send refusal interrupting the native owner; it also measures repeated
Run reads and identifies obsolete lifecycle guidance. 157 existing tests and
three isolated characterizations pass. The record preserves two initial RF3
transport failures and their passing diagnostic repeats without declaring the
full suite clean. This review changes no runtime or deployment.
The owner-approved [ADR-0256 repair](adr/0256-session-publication-and-completion-boundaries.md)
is deployed as `session-completion-6e74fd5b`.
[Delivery evidence](reports/session-publication-completion-repair-20261018.md)
records terminal replay, native refusal handling, one locked Run read instead of
three, 1,865 workspace tests, nine RF3 transport tests, 288 fault cases and eleven
artifact scans. Native input/Stop/dual-process recovery, browser, image, child and
full Cube acceptance pass. Failed TLS/short-output samples are retained; the final
streaming fixture uses substantive output with unchanged recovery assertions.
Owned resources are physically cleaned and original configuration is preserved.

The [October 18 Worker → Pi settlement review](reports/worker-harness-settlement-review-20261018.md)
checks native final-result processing, atomic task settlement and the committed
observer. It reproduces control-result truncation below the admitted budget,
redundant cold body/image reads for sequence lookup, and a malformed-content
validation gap. 109 existing tests and seven isolated characterizations pass;
this review changes no runtime or deployment. Repair directions retain Pi's
public APIs and the existing storage/execution authorities.
The owner-approved [repair](adr/0255-native-tool-result-boundaries.md) chooses
native 50 KiB/2,000-line coordination results, metadata-only sequence reads and
strict content contracts. [Delivery evidence](reports/worker-harness-settlement-repair-20261018.md)
records the deployed `tool-settlement-20ac9696` release, 1,855 workspace tests,
279 fault cases, eleven artifact scans and complete relevant live acceptance.
Owned fixtures are physically cleaned and original configuration is preserved.

The [October 17 Kafka → Worker reply review](reports/kafka-worker-reply-review-20261017.md)
records missing reply-consumer admission health, attachment-restoration failure
attribution and retained-prefix replay on same-boot reassignment. Isolated probes,
96 existing tests and a real RF3 reassignment check support the findings. This is
a review only; no production implementation or deployment changed.
The approved [repair](adr/0254-worker-reply-admission-and-settlement.md) is implemented
in source: thin local admission, separate receipt/attachment settlement and volatile
reply resume. [Delivery evidence](reports/worker-reply-repair-20261017.md) tracks
1,817 workspace tests, 77 helper tests, nine real transport cases and 270 fault
cases. Host recovery cleared the KVM blocker; `worker-reply-b1f67dba` is deployed
with all eleven artifact scans and required Luna/Cube/browser/recovery checks
passing. Three large image replies also survive cold Worker recovery. The record
retains the early-ending model fixture and confirms physical/configuration cleanup.

The approved [Tool reply continuation plan](adr/0253-tool-reply-uncertainty-and-continuation.md)
consolidates the Cube completion → Kafka walkthrough and subsequent UNKNOWN,
Pi/Codex timeout and internal-probe discussion. It distinguishes accepted result
loss from current wait/classification issues. [Implementation and acceptance](reports/tool-reply-continuation-20261016.md)
are complete as `tool-unknown-791a6ed0`: bounded continuation, idle completion
recovery and startup Stop settlement pass source and real Luna/Cube/browser checks.
The record preserves failed samples and the operator-confirmed cleanup required
by ADR-0226's conservative unknown Volume references after Cubelet loss; automatic
reconciliation remains in the backlog. The October 17 owner-requested cleanup
confirms no remaining Volume/VM or Workspace bytes and removes obsolete records,
images and deployment history. WSL expansion and original configuration
preservation are verified.

The [October 16 guest → Cubelet result review](reports/guest-cubelet-result-review-20261016.md)
records receipt loss incorrectly triggering operation-scope cleanup and oversized
progress being discarded. [Isolated evidence](reports/guest-cubelet-result-review-20261016.json)
uses actual guest/PTY behavior and patched native I/O with substituted process
services; it does not claim live VM destruction. No runtime or deployment changes
are included; proposed repair boundaries are tracked in the backlog.
The subsequently approved [repair](adr/0252-tool-receipt-and-ephemeral-preview.md)
covers receipt-only outcomes, incremental previews, terminal control sequences
and matched acceptance. Its [adoption note](research/tool-preview-rendering-20261016.md)
records the pinned parser choice and isolated package checks. Source changes and
the remaining matched/live gates are tracked in the
[delivery record](reports/tool-receipt-preview-repair-20261016.md). Source/native/fault
gates and all eleven artifact scans pass. Windows rollback restored host KVM and
the October 16 matched release `tool-preview-325f0ebd` is deployed. Continuous
previews, real receipt-loss/background preservation, native input/dual-process
recovery, browser/image/Read behavior and full Cube acceptance pass. The report
retains earlier external TLS failures and the measured recovery that corrected
a too-short fixture deadline. Windows localhost web access is also restored.

The [October 15 Cubelet → guest execution review](reports/cubelet-guest-execution-review-20261015.md)
records a missing deadline in cleanup, native Read path drift, unused per-Tool
initialization fields and an expired-setup startup optimization. Its
[isolated evidence](reports/cubelet-guest-execution-review-20261015.json) includes
SDK comparisons and native driver fault injection. This review does not change
the deployed runtime.
The [repair record](reports/cubelet-guest-execution-repair-20261015.md) records
[ADR-0251](adr/0251-guest-attachment-and-execution-bounds.md), deployed as
`guest-execution-5536fc73` with guest protocol 6. Complete source/live checks,
actual `@`-path reads, child recovery, failed samples and cleanup are distinguished.

The [October 15 Projector → Cube handoff review](reports/projector-cube-handoff-review-20261015.md)
records failure-notification coupling, refusal evidence classification, late
removed-VM admission and a binding lookup optimization. Its
[evidence](reports/projector-cube-handoff-review-20261015.json) distinguishes
reproduced adapter/Manager behavior from the untriggered native multi-effect
contract concern. It makes no runtime or deployment change.
The subsequently approved [repair](reports/projector-cube-handoff-repair-20261015.md)
implements [ADR-0250](adr/0250-cube-handoff-outcomes-and-runtime-admission.md);
it is deployed as `handoff-6ab91bb7`, retaining schema 189 and topic v17. The report
separates passing source/live acceptance, fixture corrections, external TLS failures
and confirmed cleanup from the audit baseline.

The [October 15 Projector message review](reports/projector-envelope-review-20261015.md)
records field-by-field removal/retention guidance, repeated intent decoding,
duplicate Tool presentation bodies and a reproduced child-prefix cleanup gap.
Its [measurements](reports/projector-envelope-review-20261015.json) and baseline
probes accompany 89 passing existing contract tests. The baseline probes are
archived in Git and replaced by maintained regression tests. The subsequently
approved [repair record](reports/projector-repair-20261015.md) tracks compact
publication, Tool presentation, the matched rollout and live acceptance.

The [initial complete Control Plane outage check](reports/control-plane-outage-20261014.md)
holds the only Control Plane at zero replicas for more than a minute. The active
Worker keeps renewing its PG lease and writing Kafka, Cube completes accepted
work, and the same Run resumes dispatch after startup. Same-key intake retries
create one new Run. The report records startup timing, an idle Worker restart,
fixture corrections and the paths that remained untested. That initial check changed
no runtime images; the subsequent repair and release are described below.

The [idle Worker reconnect research](reports/idle-worker-reconnect-plan-20261014.md)
confirms the timeout retirement cause and distinguishes same-image restart,
compatible Control Plane replacement and full matched release.
[ADR-0248](adr/0248-idle-worker-management-reconnect.md) records the accepted
direction and ordered implementation/acceptance plan. It is deployed as
`worker-reconnect-5b6ba003`, schema 189. [Delivery evidence](reports/idle-worker-reconnect-20261014.md)
records repository checks, preserved configuration, both original Worker Boots
across 60/90-second outages and actual Control Plane SIGKILL. Full native-input,
Cube and browser acceptance pass. The final patch also fixes a reproduced input
receipt read race without retaining historical queue versions.

The [Session execution and Tool-dispatch plan](adr/0247-session-work-and-tool-dispatch.md)
consolidates the October 13 discussion: root cloud work, native child Conversations
without child Run claims, same-commit Tool dispatch, shared Kafka replies,
Session writer closure and direct Worker publication. It replaces the unimplemented
ADR-0246 draft; the old draft remains in Git. It is deployed as
`session-work-6ac697f9`, schema 188 / execution-topic v16 / boot reply v3.
[Implementation and release evidence](reports/session-work-implementation-20261013.md)
records native children, direct publication, real recovery and rolling replacement.

The [native Kafka fencing study](reports/kafka-native-fencing-20261013.md) compares
direct Session producers with the current ingress. Isolated RF3/PG probes reproduce
delayed initialization displacing a newer PG-authorized producer; a post-init PG
check prevents stale data in the tested schedules but retains availability costs.
Fresh-process resource samples and the existing ingress fault tests are included.
That study itself changed no runtime; ADR-0247 implements the subsequently
approved migration and adds complete transport/live acceptance.

The [Kafka assistant-text simplification](adr/0245-native-commit-text-presentation.md)
keeps native text as the source and carries its display descriptions in the
same Kafka publication. Worker interprets Pi, Projector resolves references,
and preserves ordering/recovery/SSE coverage. It is deployed as
`native-text-c9b8b2a3`, matched schema 187 / execution-topic v15. The
[verification report](reports/native-text-presentation-20261012.md) records passing
source/live scenarios and the upstream TLS failures encountered during acceptance.

[ADR-0243](adr/0243-native-input-current-state.md) implements native input current
state under matched schema 185. Inbox/input metadata and Submission bodies replace
older values; retained history and current state jointly rebuild the query indexes.
[Verification and matched deployment](reports/native-input-current-state-20261012.md)
are complete, including native input/Stop, real Worker-crash recovery, browser/image
and full Luna/Cube acceptance.

The [native live-state retention change](adr/0244-kafka-backed-native-live-state.md)
is deployed as `native-live-1370d871` under schema 186. It keeps in-flight `pi.live` bodies
in Kafka and materializes PG state at native settlement or writer handoff.
[Verification and release status](reports/native-live-state-20261012.md) cover
current reads, multi-Conversation recovery references, retention and failures,
including actual loss of Worker and Projector memory during streamed output.
The full Luna/Cube follow-up now passes, including fresh-VM Volume restoration;
earlier intermittent upstream TLS failures remain recorded separately.

The [model TLS investigation](reports/model-egress-tls-20261012.md) reproduces
the three-second EOF directly through the local AnyTLS proxy, without PiCloud
or model payloads, and records a separate node-connect timeout. It distinguishes
observed failure boundaries from the inferred AnyTLS acknowledgement timeout.
The same note rechecks that `pi.live` streaming bodies stay out of PG while
native current state and recovery checkpoints remain available.

The [append-only storage research/review](reports/append-only-storage-review-20261011.md)
compares Pi, Maka, Marten, Pekko and Temporal against schema 184. Isolated experiments
retain the four-table/sequence design, identify rebuild integrity and cold-document
read improvements, and separate retention-policy discussion from implementation.
Only research artifacts and the old ADR's applicability note changed.

The [publication-registration optimization](reports/publication-admission-20261011.md)
is deployed as `publication-admission-c39a78f8`, retaining schema 184 and current
protocols. Known stale/closed registrations use zero SQL; potentially successful
registrations still verify PG. Repository, RF3/PG and real Luna/native-input/Control
Plane restart checks pass, with owned fixtures removed and configuration preserved.

[ADR-0242](adr/0242-worker-claim-schema-cleanup.md) is deployed as
`worker-claim-5c803cc5`, schema 184. [Source and live verification](reports/worker-claim-repair-20261010.md)
cover indexed claim/history reads, metadata cleanup, Worker naming, native input,
browser/Tool paths and same-Run recovery after Worker failure. Owned fixtures are
removed and original accounts/configuration are preserved.

[ADR-0241](adr/0241-missing-working-directory-tool-errors.md) is deployed as
`working-directory-889279b2`. [Source, fault and real Luna/Cube/browser evidence](reports/working-directory-20261010.md)
confirms native Tool errors and continued dialogue after directory loss, explicit
restoration and unchanged VM identity. Required Go security pins, one unreproduced
model wait, fixture cleanup and preserved configuration are recorded separately.

[ADR-0240](adr/0240-transaction-scoped-input-admission.md) scopes input-read reuse
to its existing PG transaction. The [source checks and matched rollout](reports/input-admission-20261010.md)
are complete: `input-admission-db0548b8`, schema 183. Ordinary intake is eight
business statements and retry is two; real HTTP/Luna/Cube/browser acceptance
passes, with original configuration preserved and owned fixtures removed.

The preceding [projection and commentary release](reports/projection-release-20261009.md)
deployed `projection-b14c3777`, schema 183. It combines Run/writer reads,
avoids unchanged replay updates and animates commentary text. Existing authority
locks remain. [Source verification](reports/projection-sql-20261009.md) and real
Luna/Cube/browser acceptance pass; fixtures are cleaned and configuration preserved.

The preceding [native input release](reports/native-input-release-20261009.md) deployed
`native-input-a71a4807`, schema 183. Real Luna/Cube and browser checks passed;
owned fixtures are removed and original accounts/configuration/credentials remain.
The report records the corrected model-egress endpoint and updated operator drivers.

The [reading checkpoint](READING_PROGRESS.md) reconciles the full hop-by-hop
walkthrough through ordered closure and replacement Worker/Harness recovery.
Tool execution/replies, normal Run completion, browser delivery and renewal are
covered. The final model request/response branch is also reviewed, with its
findings retained as separate repair work. The
[claim-table review](reports/worker-claim-schema-review-20261010.md)
preserves this ownership design and records two index-access issues, unused
physical-Session metadata and Worker naming debt. The owner-approved repairs follow
[ADR-0242](adr/0242-worker-claim-schema-cleanup.md).
[Full source verification, schema 184 rollout and live acceptance](reports/worker-claim-repair-20261010.md)
are complete.
[ADR-0238](adr/0238-native-input-queue-and-run-record.md)
is the approved native follow-up/editing and Session/Run consolidation slice;
implementation and deployment status are tracked separately.

The [Session/Turn/Run field review](reports/session-turn-run-review-20261008.md)
covers all 105 columns, current SQL dependencies and isolated acceptance/queue
checks. It identifies six initial cleanup candidates and duplicated Turn/Run
lifecycle fields. Its approved implementation is recorded in the
[native input and Run consolidation report](reports/native-input-run-consolidation-20261009.md);
source verification is followed by the matched deployment above.

The [sandbox result/portability study](reports/sandbox-result-portability-20261008.md)
compares current Cube coupling with official E2B, OpenSandbox, OpenShell,
SandboxFusion and Daytona interfaces. It separates execution, output retention
and delivery, and records Daytona's private-core transition. This is research,
not a second runtime implementation or an approved architecture change.

The [DeepSeek V4.1 Flash smoke check](reports/deepseek-flash-acceptance-20261007.md)
passes text, real file/Bash execution, multi-round high-thinking and direct image
input on the deployed readiness release. Search was explicitly not tested.

The previous [readiness release](reports/readiness-release-20261007.md) was deployed as
`pilot-ready-81392f7d` through the maintained matched workflow. Full Luna/Cube and
browser acceptance pass; original accounts/configuration remain, and owned test
resources are removed. The report records driver corrections and one upstream
TLS interruption separately from the successful final verification.

The approved readiness work adds a [matched release procedure](MATCHED_RELEASE.md),
an optional [conversation/image recovery drill](ASSET_RECOVERY.md), and a bounded
[private-use pilot](PRIVATE_PILOT.md). The owner has deferred backups of the current
disposable data. The pilot has not started; existing runtime authorities are retained.
The [implementation and verification record](reports/private-readiness-repair-20261007.md)
separates tested operator boundaries from a new deployment or actual-use evidence.

The [architecture value and evidence review](reports/architecture-evidence-review-20261007.md)
examines `4a27d28c` against the owner's question of justified complexity,
independent operation and a stopping point. It recommends retaining the core,
making the matched operating procedure reproducible, reconciling current ADR
semantics and running a bounded private pilot. It separates demonstrated recovery
from unproved fleet capacity and host-loss asset restoration; no runtime changed.

The [October 7 recovery and boundary review](reports/repository-review-20261007-r3.md)
covers all 22 workspaces at `1e7e21eb`. It reproduces a failed-Session recovery
interaction with withdrawn queued input, returned-input submission identity,
oversized-line Read drift from Pi 1.0,
and native configuration logging, and measures avoidable hot-document SQL.
The previously interrupted full Luna/cold-VM acceptance now passes. Product
repairs are implemented under [ADR-0236](adr/0236-recovery-input-identity-and-tool-diagnostics.md),
with [source verification and release boundaries](reports/review-repair-20261007-r3.md).
R07R3-04 is owner-deferred. The [matched Tool Worker protocol 4 rollout](reports/review-release-20261007-r3.md)
is deployed, with real browser Stop/return/image resend, native VM and full
Luna/cold-VM acceptance; original accounts and model configuration are preserved.

The [October 7 post-release review](reports/repository-review-20261007-r2.md)
audits `59541389` across all 22 workspaces. Four reproduced findings cover
cross-action composer identity, partition commit-lock coupling, upload staging
after process loss and EXIF orientation. It also records RF3 isolation/replay,
deep pagination and owned native template restore checks. These findings are
recorded for repair; product behavior is unchanged by this review.
The [approved repair plan](reports/review-repair-plan-20261007-r2.md) and
[source implementation](reports/review-repair-20261007-r2.md) define and implement
the four slices without changing runtime authorities. The
[matched rollout](reports/review-release-20261007-r2.md) deploys guest protocol 4,
repairs the declarative Cube plugin mounts and records destructive development
cleanup plus actual-image/browser/Luna acceptance.

The [October 7 whole-repository review](reports/repository-review-20261007.md)
audits `7a5fc603` across all 22 workspaces and the Pi/Cube/deployment boundaries.
It records ordinary-send retry duplication, a guest-reuse release-evidence
conflict, measured Volume-lock and conversation-query improvements, and a stale
Stop comment. The [approved source repairs](reports/review-repair-20261007.md)
implement all five under ADR-0234 and migration 182, with isolated/browser/fault
verification. The [matched schema 182 rollout](reports/review-release-20261007.md)
is deployed, including owner-authorized old-test cleanup and live acceptance.

The [October 7 template cleanup repair](reports/template-cleanup-20261007.md)
resolves obsolete Pod IP routing in Cube's template and rootfs cleanup. It records
the pinned source patch, retained-reference tests, native rollout and actual
removal of 55 old templates while the four current templates remain usable.

The [October 6 post-Durable whole-repository review](reports/repository-review-20261006.md)
audits `aace21a8` across all 22 workspaces, native Pi, Cube, product and delivery
boundaries. It records five findings, three measured optimization opportunities
and two failing delivery checks, with isolated reproductions and baseline live Luna acceptance.
The [approved source repairs](reports/review-repair-20261006.md) are implemented and
verified under ADR-0231/0232. The [matched production release](reports/review-release-20261006.md)
deploys schema 181 and records actual image checks and owned live acceptance.

[ADR-0230](adr/0230-complete-tool-call-publication.md) is implemented and deployed:
streaming local Tool call drafts stay in Worker memory, while complete successful
responses retain Durable's validation and execution-intent commits. The ADR links
native recovery contracts, the 190-case fault report and real Luna/Cube/PG evidence.

[ADR-0229](adr/0229-native-durable-runtime.md) is implemented and deployed:
Pi Durable 1.0 replaces the former runtime and storage, preserves PG cloud
ownership, resumes logical Runs after ordered owner closure, and returns
unconsumed stopped input to the composer. The [migration and release record](reports/pi-durable-migration-20261006.md)
contains the architecture changes, verification and current operational limits.

The [Pi Durable 1.0 evaluation](reports/pi-durable-evaluation-20261005.md) executes
the Kafka/PG commit and Cube Tool boundaries under ADR-0228. It records usable
interfaces and mismatched cancellation/recovery/queue semantics; it does not
upgrade the production runtime.

The [October 5 whole-repository follow-up review](reports/repository-review-20261005.md)
audits `5c2fcab4` across all 22 workspaces, pinned Pi/Cube, storage, UI and delivery.
It records four confirmed behavior findings, one documentation finding, isolated
reproducers and current SQL measurements. The [approved improvements](reports/review-improvements-20261005.md)
track implementation and matched release verification under ADR-0227.

The [October 4 whole-repository review](reports/repository-review-20261004.md)
audits `8d8ee837` across all 22 workspaces, pinned Pi/Cube, delivery and product
paths. It records seven defects, a browser-fixture gap, SQL measurements and
architecture tradeoffs. [The October 5 repair and release](reports/review-repair-20261005.md)
implements all seven fixes and restores the browser gate, with real Pi/Luna,
Cube Volume, controller/Worker replacement and cancellation acceptance.

[ADR-0223](adr/0223-recoverable-vm-allocation.md) adds stable VM allocation,
recoverable creation and irreversible closure. [Verification and matched release](reports/vm-allocation-20261004.md)
cover lost replies, late creation, Control Plane SIGKILL and dedicated-machine
lifecycle. PG retains lifecycle authority and Cube supplies the physical contract.

[ADR-0221](adr/0221-pi-tool-cancellation.md) introduced Pi-style Tool cancellation:
ordered operation interruption, original-result settlement and bounded UNKNOWN
outcomes. [Verification and matched release](reports/pi-tool-cancellation-20261004.md)
include normal and unavailable-executor Luna/Cube acceptance.
[ADR-0222](adr/0222-paused-inputs-after-stop.md) adds durable queue pause on Stop,
independent fresh input and explicit continuation.
[Verification and rollout](reports/paused-inputs-20261004.md) cover native input
consumption, real Luna/browser behavior and Worker replacement.
The earlier [detach-only acceptance](reports/agent-stop-correction-20261004.md)
records ADR-0220's superseded behavior at its named revision. ADR-0229 supersedes
ADR-0221's original-result waiting and ADR-0222's paused queue: native abort now
owns settlement, and unconsumed input returns to the composer.

The [October 4 repair record](reports/review-repair-20261004.md) tracks the approved
boundary fixes and the earlier Cube closure implementation (ADR-0218/0219);
its process-cancellation assertions describe that historical revision.

The [October 3 follow-up review](reports/repository-review-20261003-r2.md) covers
all 22 workspaces at `3dbf49fb`, with new input/time/cleanup findings, a Cube
capacity-isolation decision, query measurements and explicit test limitations.
It does not change the deployed runtime. Its unfinished work is in BACKLOG.

The [October 3 repository review](reports/repository-review-20261003.md) covers
all 22 workspaces at `4294c759`, distinguishes confirmed behavior issues from
optimization and architecture proposals, and includes isolated reproducers.
The subsequent [repair record](reports/review-repair-20261003.md) tracks the
approved fixes, data-path measurements and matched release verification.

The latest [quota removal and streaming-upload acceptance](reports/unlimited-quotas-20261003.md)
records 138 passing fault cases and seven real Luna Runs across elastic Workspace,
dedicated-machine and queued-image paths. The preceding [K3s cutover](reports/k3s-migration-20261003.md)
records native discovery, data reset and Pod/crash recovery.

The [control recovery repair and acceptance](reports/control-recovery-repair-20261003.md)
records ADR-0213's completed rollout, full-Turn cost comparison, 1,650 assertions,
133 fault cases and real Luna/browser/process-restart results, including limits.

Use documentation in this order:

1. [`README.md`](../README.md) — product, one-message path and deployment entry.
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) — maintained component and authority
   model.
3. [`RUN_LIFECYCLE.md`](RUN_LIFECYCLE.md) and
   [`STREAM_DURABILITY.md`](STREAM_DURABILITY.md) — Run, streaming and crash
   invariants; [`THREAT_MODEL.md`](THREAT_MODEL.md) — security boundaries.
   [`CUBESANDBOX_PROVIDER.md`](CUBESANDBOX_PROVIDER.md) defines the current Tool
   execution boundary.
   [`SUBAGENTS.md`](SUBAGENTS.md) defines delegation, scripts and communication.
   [`CHAT_ATTACHMENTS.md`](CHAT_ATTACHMENTS.md) defines Workspace uploads, native
   visual input and the attachment API.
4. [`CONFIGURATION.md`](CONFIGURATION.md),
   [`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md) and
   [`DISTRIBUTED_DEPLOYMENT.md`](DISTRIBUTED_DEPLOYMENT.md) — operations;
   [`OBSERVABILITY.md`](OBSERVABILITY.md) — metrics, alerts, traces and logs.
5. [`adr/README.md`](adr/README.md) — current decisions only.

`reports/` contains evidence tied to a named revision and topology. Development
research, conversations and superseded implementation logs remain in Git
history instead of the maintained tree.

The [October 2 whole-repository review](reports/repository-review-20261002.md)
evaluates the authority, recovery and control-view boundaries at its baseline.
Its four confirmed findings and accepted optimization slices were repaired in
[ADR-0213's rollout](reports/control-recovery-repair-20261003.md); the remaining
design and capacity questions are tracked in the maintained backlog.

The [October 2 ordered control views acceptance](reports/ordered-control-views-20261002.md)
records PG/Outbox/Kafka propagation into binding, queue and Subagent memory views,
measured query reductions, real Luna/browser/restart acceptance and the matched
v13 deployment with preserved original VM and native history.

The [October 2 execution-probe acceptance](reports/execution-probes-20261002.md)
records independent Projector/guest-return observations, direct physical-VM
probing, real Luna/browser/process-fault checks, and the deployment repairs and
asset-preservation verification.

The [September 30 repository review](reports/repository-review-20260930.md)
records the complete scope, eight confirmed findings, three discussion items
and historical boundary probes at its recorded baseline. The baseline had
workspace-test and security-gate failures.

The [October 1 repair record](reports/repository-review-repair-20261001.md)
records all eight confirmed repairs, the accepted deletion/interruption decisions,
code cleanup and passing combined verification. The
[authority and Cube execution acceptance](reports/cube-execution-authority-20261001.md)
records the implementation of [ADR-0210](adr/0210-cube-execution-handoff-and-scoped-stop.md);
the [production cutover](reports/cube-execution-rollout-20261001.md) records the
matched deployment, preserved user history and real-model/browser/failure acceptance.
The [Cube result-delivery study](reports/cube-result-delivery-study-20261001.md)
compares current upstream execution APIs with Broker-independent completion
delivery; it records the missing guarantees without changing the deployed runtime.

The [chat attachment acceptance](reports/user-input-attachments-20260929.md) records
Workspace uploads, native user ImageContent, queue promotion, browser preview and
real Luna recovery after Workspace modification and Worker replacement.

The [runtime status acceptance](reports/runtime-status-acceptance-20260930.md) records
independent lease sweeps, PG-time expiry selection, transient phases and quiet-Session
path probes, including real Luna/Cube/browser and process-failure checks.

The [Workspace recovery acceptance](reports/workspace-rebind-acceptance-20260930.md)
adds owned development-machine/directory selection after Workspace deletion,
with release-race, browser retry and real Luna history/Tool verification.

The [direct Steer recovery acceptance](reports/direct-steer-acceptance-20260930.md)
records durable acceptance, canonical consumption and unconsumed restoration,
including real Luna Worker loss and cancellation without Tool replay.

The [September 27 repository review](reports/repository-review-20260927.md) covers
Pi alignment, component boundaries, duplicated IO and removal of obsolete paths;
it tracks implemented repairs and subsequent approved architecture decisions.
The approved [D1/D3/D4 follow-up](reports/repository-review-followup-20260927.md)
repairs result admission and tightens lease/package/build boundaries without
merging durable acknowledgements or changing native history ownership.
The [native-log layout study](reports/native-log-layout-study-20260927.md) compares
indexed log reads with full and thin Entry/Record tables on isolated PostgreSQL;
the selected layout and its lifecycle contract are defined in
[ADR-0197](adr/0197-indexed-native-session-log.md).
The [indexed-log acceptance](reports/indexed-native-log-acceptance-20260927.md)
records its completed schema/app cutover, preserved history and Pi/fault/Luna checks.
The [atomic Tool invocation acceptance](reports/tool-invocation-acceptance-20260928.md)
completes D2: one post-validation intent/command publication, with native hooks,
fault recovery and real Luna/Cube Projector-restart verification.
The [runtime and SQL polish acceptance](reports/runtime-polish-acceptance-20260928.md)
records proved-rejection isolation, shared projection reads, phase attribution,
server-side projection budgets and measured SQL counts without weakening writer
or Tool-dispatch boundaries.

The [Pi-alignment review](reports/pi-alignment-review-20260926.md) records its named
baseline; the [repair and verification record](reports/pi-alignment-repair-20260926.md)
tracks its disposition. Current architecture remains defined by the documents and
ADRs above.

The [image and GPT-6 acceptance](reports/image-attachments-20260926.md) records
the subsequent attachment cutover, model migration and current DeepSeek search
protocol evidence.
The [Flash catalog amendment](reports/flash-catalog-20260926.md) records its later
return to selection with the owner's requested search declaration, Pro removal
from menus and real Flash Tool-image verification.

The [CloudAgentRuntime review](reports/cloud-agent-runtime-review-20260926.md)
compares the current execution boundary with pinned Pi and records reproducible
queue-settlement, retry, compaction and cancellation differences.
The [lifecycle repair](reports/cloud-agent-runtime-repair-20260926.md) records
their resolution, local Worker rollout and current follow-up/steer capabilities.
The subsequent [pending-input acceptance](reports/queued-inputs-20260926.md) records
editing, removal, reordering and promotion to steer, including admission races
and matched API/Worker/Web rollout with real Luna/browser verification.

Superseded ADRs and retired architecture documents are kept in Git history
instead of the current tree. This is intentional: repository-reading agents
should not have to infer which of several mutually exclusive production paths
is real.

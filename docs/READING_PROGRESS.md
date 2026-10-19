# Architecture reading checkpoint

Updated: 2026-10-19; runtime is `seal-projection-0de1fe7f`.

The owner asked to reconcile the complete hop-by-hop conversation with the
recorded reviews. The ordinary Tool execution loop, normal Run completion,
browser delivery, Worker renewal and Control Plane expiry admission have been
covered. The provider request branch was explicitly deferred during the October
12–15 walkthrough and has not received the same complete focused treatment.

Current checkpoint: **replacement Worker → Pi Harness opening and continuation**.
The [focused review](reports/worker-harness-recovery-review-20261019.md) is complete:
110 existing tests, seven isolated behavior cases and six cost samples. Latest-head
reads skip old history; current input, native children, unsafe Tool handling and
Stop retain the inspected ownership semantics. Worker data-read bounds and
cancellation need repair; child metadata batching and image hydration are recorded
optimization items. Runtime/deployment are unchanged by this review.
Next: native Pi → Worker-local Model Gateway → CLIProxyAPI → provider and response.
The earlier large-image cold-recall acceptance is still incomplete and belongs
in that transport investigation; duplicate object reads are not its proven cause.

The preceding **Kafka seal → Projector → PG checkpoint/closure/release**
[review](reports/seal-projection-review-20261019.md) and
[SPJ-01/02/O1/O2 implementation/deployment](reports/seal-projection-repair-20261019.md)
are complete, with the image acceptance limitation above retained.

For the preceding **PG Outbox → Control Plane seal publisher → Kafka** hop,
the [focused review](reports/seal-publication-review-20261019.md) and
[SP-01–03 repair/delivery](reports/seal-publication-repair-20261019.md) are complete.
Required live gates and physical/configuration cleanup pass; upstream failed
samples and the unchanged repeat after proxy-node switching remain recorded.
The preceding PG expiry
[review](reports/control-plane-expiry-review-20261018.md) and
[repair/release](reports/control-plane-expiry-repair-20261018.md) are complete.
Kafka seal acknowledgement is not yet PG-projected closure, a successor grant
or physical process-death evidence.

## Covered hops

| Hop or boundary | Walkthrough/review status | Evidence |
| --- | --- | --- |
| Browser → Control Plane → PG initial input | Explained, table/intake reviewed and repaired | [Session/Run fields](reports/session-turn-run-review-20261008.md), [intake](reports/input-admission-20261010.md) |
| PG queue → Worker claim and Session lease | Explained, focused schema/admission review and repair; later ownership migration accounted for | [Worker claim](reports/worker-claim-schema-review-20261010.md), [current Session work](adr/0247-session-work-and-tool-dispatch.md) |
| Worker → native Harness/Storage, context reads | Opening/context explained; storage layout and retention separately reviewed/redesigned | [Storage review](reports/append-only-storage-review-20261011.md), [current inputs](adr/0243-native-input-current-state.md), [live state](adr/0244-kafka-backed-native-live-state.md) |
| Pi Storage → Worker → Kafka | Explained; direct-publication migration and current implementation re-reviewed | [publication/completion](reports/session-publication-completion-review-20261018.md) |
| Kafka → Projector, PG/live projection and dispatch preparation | Explained and focused review/repair | [envelope review](reports/projector-envelope-review-20261015.md), [projection SQL](reports/projection-sql-20261009.md) |
| Projector → Cube API/Master/Cubelet acceptance | Explained as the handoff segment and reviewed | [handoff](reports/projector-cube-handoff-review-20261015.md) |
| Cubelet → guest fixed Tool execution | Explained, reviewed and repaired | [guest execution](reports/cubelet-guest-execution-review-20261015.md) |
| Guest result/progress → Cubelet | Explained, reviewed and repaired | [result reception](reports/guest-cubelet-result-review-20261016.md) |
| Cubelet completion → Kafka reply transport | Explained; waiting/UNKNOWN/probe discussion and repair complete | [continuation](adr/0253-tool-reply-uncertainty-and-continuation.md) |
| Kafka reply → original Worker callback | Explained, reviewed and repaired | [Worker replies](reports/kafka-worker-reply-review-20261017.md) |
| Worker Tool return → native Pi settlement | Explained, reviewed and repaired | [Harness settlement](reports/worker-harness-settlement-review-20261018.md) |
| Formal Tool Result commit and whole-Run normal completion | Loop closed; deliberately re-reviewed after recent changes | [publication/completion](reports/session-publication-completion-review-20261018.md) |
| Projector → browser, refresh/reconnect and Working state | Explained, reviewed and repaired | [browser delivery](reports/projector-browser-review-20261018.md) |
| Worker → PG lease renewal | Explained, reviewed and repaired | [renewal](reports/worker-session-lease-review-20261018.md) |
| Control Plane → PG expiry/seal admission | Explained, reviewed and repaired | [expiry](reports/control-plane-expiry-review-20261018.md) |
| PG Outbox → control seal publisher → Kafka | Explained, reviewed and repaired | [seal publication](reports/seal-publication-repair-20261019.md) |
| Kafka seal → Projector → PG checkpoint/closure/release | Explained, reviewed, repaired and deployed | [seal projection](reports/seal-projection-review-20261019.md) |
| Replacement Worker → native Harness continuation | Explained and reviewed; findings recorded, repair pending; current checkpoint | [Worker recovery](reports/worker-harness-recovery-review-20261019.md) |

These statuses distinguish walkthrough coverage from focused audit scope. Storage
research does not establish a complete new audit of every native recovery branch,
and an end-to-end acceptance pass does not mean every internal hop has been
independently reviewed. Old Worker → HTTP publication ingress descriptions are
historical; the maintained path is direct Worker → Kafka under ADR-0247.

## Remaining main walkthrough segments

1. **Native model request and response.** Pi → Worker-local Model Gateway →
   CLIProxyAPI → provider, and the streamed response back to Pi. Cover request
   construction/model settings, local model permits, credential boundaries,
   response parsing, incomplete local Tool calls, cancellation and transport
   failures. Context/token estimation, Compaction and TLS diagnostics have been
   discussed separately; this full branch was deferred and still needs its
   focused walkthrough/review. Include the incomplete large-image request/header
   timing evidence without presupposing a proxy, provider or attachment cause.

Replacement Harness continuation now has its focused review above. After the
remaining model branch, this main-message walkthrough has a bounded completion
point, followed by actual use and evidence-driven follow-up. Findings remain
separate repair work; reviewed does not mean every finding has been fixed.

## Related branches already discussed

Native steer/follow-up editing and durable Inbox ownership, Stop/late-result
semantics, image claim checks, native Subagents/shared ownership, VM/Volume
lifecycle and compatible Control Plane replacement all have prior discussion,
implementation reviews or acceptance evidence. They are not blank areas.

Workspace activation/binding propagation, Subagent control dispatch and
upload/terminal/preview flows can be separate future walkthroughs if needed.
That is a different scope from identifying the remaining main-message hops;
there is no standing plan to repeat every earlier whole-repository review.

## Earlier walkthrough notes through October 17

The following notes retain earlier decisions and links. The current checkpoint
and coverage list above supersede their historical "next hop" statements.

Previously covered **guest Tool process → Cubelet result reception**.
Explained structured final results over the existing native process output channel,
progress/final separation and the bytes-only `scope.received` acknowledgement.
The [October 16 focused review](reports/guest-cubelet-result-review-20261016.md)
confirmed receipt-loss cleanup and oversized preview loss with isolated evidence.
The subsequent discussion distinguishes disposable browser previews from guest
final-result collection, and identifies CR/ANSI display limitations. Accepted
[ADR-0252](adr/0252-tool-receipt-and-ephemeral-preview.md) records receipt repair,
incremental/reset preview delivery and a terminal-aware source adapter. The owner
approved implementation; source/native/fault gates and all eleven artifact scans
pass. The [delivery record](reports/tool-receipt-preview-repair-20261016.md) records
the successful KVM recovery and matched `tool-preview-325f0ebd` deployment.
Complete progress/receipt, native input/dual-process recovery, browser/image/Read
and full Cube acceptance pass. Earlier TLS failures and the measured SSE recovery
that corrected the fixture's deadline remain recorded. The reading checkpoint is
preserved in this document; the walkthrough has now advanced to reply publication.

Previously covered **Cubelet → the VM's fixed Tool execution process**.
Explained per-operation native process startup in a reusable VM, the root scope
launcher and unprivileged Tool process, working-directory attachment, Bash output,
ordinary process-group cancellation and stronger timeout/fault cleanup. Bash uses
the cloud guest adapter; the guest does not create a Pi Harness or model loop.
The [focused review](reports/cubelet-guest-execution-review-20261015.md) is complete.
All four approved [repairs](reports/cubelet-guest-execution-repair-20261015.md)
are deployed as `guest-execution-5536fc73`: bounded cleanup/startup, native Read
path parity and guest 6's smaller execution attachment. Source/live acceptance
and configuration preservation are verified; failed samples remain recorded.

Previously covered **Projector → Cube: dispatch and takeover acknowledgement**.
Explained confirmed dispatch offset before HTTP delivery, in-memory binding
lookup, bounded takeover ACK versus Tool completion, and the intentional UNKNOWN
window without automatic Shell replay. The actual vendor route is Cube API →
CubeMaster → Cubelet. The [handoff review](reports/projector-cube-handoff-review-20261015.md)
records implementation findings; the owner approved the
[repair](reports/projector-cube-handoff-repair-20261015.md) under ADR-0250,
now deployed and accepted as `handoff-6ab91bb7`.
Multi-operation-per-record remains a Pi upgrade check, without a protocol expansion.

Previously covered Kafka → Projector: one consumer per Control Plane process, partition
ownership/concurrency, the complete Tool execution-intent envelope, PG projection,
live presentation and dispatch-commit-before-Cube ordering. Kafka producer fencing
acts at submission; PG grant expiry alone does not instantly fence a producer.
The [focused review](reports/projector-envelope-review-20261015.md) records fields
that can be derived/shared, those required for native recovery and child identity,
and reproduced projection cleanup/duplication findings. The approved
[repairs](reports/projector-repair-20261015.md) are deployed as
`projector-compact-bf55d9bd`: compact envelope, same-commit Tool presentation,
indexed dispatch preparation and whole-writer prefix cleanup.

ADR-0247 removes the ordinary Worker publication ingress discussed before migration.
Covered HTTP idempotency keys, accepted versus executed input, atomic intake,
PG queue readiness and the difference between cloud control records and the
native append-only log. PG notifications wake Workers; they are hints, not task
payloads or execution ownership. The persisted Run survives a missed notification,
and periodic queries cover missed wakes. The Worker pulls eligible ready Runs;
`FOR UPDATE SKIP LOCKED` separates competing claims. Physical-Session ownership,
lease issuance and the Run's transition to running commit together before
Runner execution. Claim locks last only for the transaction, while leases/fencing
govern the subsequent execution. A pre-commit rollback leaves work queued;
post-commit loss requires the existing closure/recovery path, not blind replay.

Normal fresh-lease admission is 9 business SQL statements, plus BEGIN/COMMIT.
Child Conversations no longer enter this claim path; they use the root work's
existing Session ownership through the native Harness.
The [focused table review](reports/worker-claim-schema-review-20261010.md) retains
Run, physical-Session and lease boundaries. It records two query/index issues,
three unused physical-Session metadata columns and Worker naming debt.
The owner-approved repairs under ADR-0242 are verified and deployed as
`worker-claim-5c803cc5`, schema 184. Source/transport/fault tests and real Luna
input/browser/Worker-recovery acceptance pass.

After claim commits, the Worker verifies its PG grant and initializes a Kafka
producer with a stable physical-Session transactional ID. It verifies PG again
after initialization: a delayed stale initializer cannot publish under an expired
grant. Ordinary commits use that producer without HTTP or a new PG authority read.
Opening emits no native record. A forced seal closes the old incarnation without
incrementing its PG epoch; PG issues the higher epoch during a new lease claim
after ordered closure. Kafka seal durability and PG-projected closure are distinct.
Normal root work finishes through `work_finished`, after its native children settle.
The former ingress-registration optimization remains historical evidence in
[its release report](reports/publication-admission-20261011.md).

Native opening is Worker-local. A live physical Session lease incarnation shares
one Harness/Storage; a new incarnation opens fresh, and native family settlement
closes the idle owner. Storage first reads PG's latest native commit sequence/next ID,
then serves indexed records/documents as Pi requests them. Harness.open restores
live tasks before scheduling; cloud binding applies the admitted model/tools/cwd.
The initial native submission uses the logical Run ID for deduplication.
Pi derives model context at the sampling boundary from the visible tail and latest
Compaction/reset head, paging only that active range. With no head marker, the
whole visible history remains eligible. PG indexes locate the canonical native
log bodies; the cloud adapter does not invent its own transcript semantics.
Old-writer seal projection precedes cold replacement, while an active writer's
acknowledged overlay covers its own not-yet-projected commits.

Storage-layout follow-up: the owner approved ADR-0243 after the append-only review.
Inbox/input metadata and Submission current values remain Pi-owned and acknowledged
through the same Kafka commit. PG materializes them without intermediate bodies;
index rebuild uses retained history plus authoritative current state. Other native
records retain their existing policy.
[Implementation and matched schema 185 deployment](reports/native-input-current-state-20261012.md)
are complete, including current-state reconstruction and real Worker-crash recovery.

The owner approved [ADR-0244](adr/0244-kafka-backed-native-live-state.md) after
comparing Pi's latest-only live state with the earlier Kafka-text/PG-message split.
It is deployed as `native-live-1370d871` under schema 186: publications stay intact, PG keeps
small commit headers, and current live reads span Kafka-backed memory and PG
boundary/handoff checkpoints. Protected replay references span Conversation/Run
anchors. The [report](reports/native-live-state-20261012.md) records the matched
rollout and actual Worker/Projector crash recovery. Other documents retain their 64-delta read
accelerators; these are not model Compaction or whole-Session recovery snapshots.
The storage-layout discussion above did not itself advance the walkthrough.

Follow-up discussions established:

- Core Session/Turn/Run fields are consolidated under ADR-0238.
- A cloud Run can process multiple native human submissions.
- Native follow-up waits for the final boundary; steer uses the earlier native
  boundary. Pi Durable persists pending submissions and InboxDoc changes.
- Pending edits use Pi transactions and Kafka durability. ADR-0243 replaces
  their PG current values without retaining superseded edit bodies in history.
- Current UI model preference remains control state. Actual native Run model
  configuration is persisted when applied, not for every selector click.
- During a running Run, an unavailable Worker leaves the new draft unconfirmed
  in the browser; success requires native Kafka durability acknowledgement.
- ADR-0240 reuses Session/idempotency reads inside the same locked transaction:
  ordinary initial intake is eight business SQL statements and same-key retry
  is two. Normal authentication plus BEGIN/COMMIT bring initial intake to eleven.
- Ordered Kafka views speed downstream routing/display; mutable PG admission
  decisions still use current authority. This change adds no cross-request cache.
- The Workspace admission SELECT checks the PG resource and keeps its shared
  lock until Run registration commits. It does not stat a directory or probe a VM;
  concurrent deletion and Run intake remain serialized by the existing PG locks.
- Projector's binding view serves ordered Tool routing, with synchronous closure
  and recovery guards; it does not replace new-Run Workspace admission.
- The directory-deletion discussion found a separate guest classification bug.
  ADR-0241 returns known pre-execution user-directory failures as native Tool errors;
  it is deployed with same-Run Luna continuation, explicit directory restoration
  and unchanged VM identity. No intake SQL changes were required.

The walkthrough covers the commit envelope, scope checks, writer/closure ordering,
Kafka transaction ACK, known
pre-admission rejection versus ambiguous delivery, Session key/partition placement,
native seq versus Kafka offset, and Kafka producer fencing versus PG lease fencing.
Control publication remains a module inside Control Plane, sharing Projector
partition ownership. Native Worker commits bypass that module. Old and new
Control Plane instances can coexist during a compatible rollout.

The owner narrowed the update requirement to compatible Control Plane changes,
such as additional APIs or internal refactoring. Continuously active Runs must
not have to finish before such an update. Worker/Pi, Cube and protocol/data
contracts remain fixed. The [current acceptance record](reports/session-work-implementation-20261013.md)
tracks real overlapping-Pod handoff and the defects it exposed. The maintained
full matched release still drains work; arbitrary schema/Worker upgrades are not
covered by the compatible Control Plane handoff contract.

The October 14 follow-up verified a complete Control Plane outage: the existing
Worker/Session lease and VM survived, committed progress waited in Kafka, and a
new request retried with one identity was claimed after recovery. The
[report](reports/control-plane-outage-20261014.md) records the idle Worker restart
and remaining handoff/interactive-transport checks. The walkthrough checkpoint
is unchanged; no version-routing or query-service split was implemented.

The owner then accepted separating idle connection expiry from Worker Boot
retirement. [ADR-0248](adr/0248-idle-worker-management-reconnect.md) records the
morning recap, reconnect/registration/claim changes and verification sequence.
Service addresses stay fixed; a fresh WebSocket and registration acknowledge the
new connection. The change is deployed as `worker-reconnect-5b6ba003`, schema 189;
[evidence](reports/idle-worker-reconnect-20261014.md) confirms original idle/busy
Worker processes across 60/90-second outages and Control Plane SIGKILL.
Complete native-input/Cube/browser acceptance passes; a concurrent replay-receipt
read was repaired by using current metadata directly instead of reconstructing an
Inbox against a stale head. No extra query authority or historical queue copy was added.
At the end of that reconnect work, the walkthrough remained at Worker Storage → Kafka commit.

The [native Kafka fencing research](reports/kafka-native-fencing-20261013.md)
and its isolated experiments are complete. They do not authorize a Kafka fork,
direct-Worker migration, a second execution authority or a deployment.

The owner requested a direct-Worker assessment, then challenged independent child
seals and the need for cloud child Runs at all. Native ownership and an eight-test
Harness run confirm one shared writer, generation-owned children, and final
Assistant Entry/Submission done preceding descendant-aware idle. The cloud runner
waits for that idle boundary. These tests do not prove a replacement cloud protocol.

The October 13 discussion clarified:

- Pi's public Harness already manages multiple Conversations and their tasks;
  a custom subagent tool is an adapter into that capability.
- Fixed Cube tools already return prepared content. Worker tool proxies return
  it through execute; Pi applies hooks and commits the canonical result.
- The old separate start/wait commands and cloud child Runs are removed.
  Control tools and fixed Cube tools share boot-scoped Kafka replies. Pi processes
  the returned content before committing the canonical Tool Result.
- Source-derived dispatch must use validated native execution intent, not merely
  an assistant tool_call. Reconstruction never authorizes arbitrary effect replay.
- PG child-creation deduplication and native creation receipts handle repeated
  delivery. A repeatable notification is not permission to start another Agent.
- A cloud Run need not mean one agent loop. Session owns the renewable execution
  authority; the agreed direction is one root cloud work item with native descendants,
  without giving each descendant a separate cloud Run queue lifecycle.

[ADR-0247](adr/0247-session-work-and-tool-dispatch.md) consolidates the resulting
plan and replaces the earlier unimplemented ADR-0246 draft, retained in Git.
It covers native children, shared Tool dispatch/replies, ordinary work completion,
Session closure, direct Kafka publishing and compatible Control Plane updates.
The migration is deployed as `session-work-6ac697f9`. Real PG/RF3 tests
cover direct publication during Control Plane replacement, delayed initialization
and ordered same-Run recovery. The [progress record](reports/session-work-implementation-20261013.md)
tracks the source, live recovery and rolling-replacement evidence.

The subsequent October 15 walkthrough covered **Kafka → Projector: consuming one
committed record, projecting native state and preparing dispatch**. After discussing
the focused review above, resume with **Projector → Cube**. Keep the provider/model
request as a separate walkthrough hop.

ADR-0245 is implemented and deployed as `native-text-c9b8b2a3` (schema 187/topic v15). Pi still calls public
`Storage.commit`; PiCloud puts that complete commit and text display descriptions
into one acknowledged Kafka record. The old post-commit assistant-text publisher
is removed. Native interpretation stays in Worker, while Projector resolves
same-commit references and advances history/SSE coverage. The
[release report](reports/native-text-presentation-20261012.md) tracks deployment.
That implementation preceded the subsequent ingress/Kafka walkthrough recorded above.

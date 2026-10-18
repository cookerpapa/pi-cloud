# Streaming durability and recovery

The active publication path is Worker → Session Kafka producer → one Session
Projector group. Projector drives PG native storage, live views and Tool routing.
The public SSE proxy does not build another tail. Current contracts are defined
by [ADR-0244](adr/0244-kafka-backed-native-live-state.md),
[ADR-0245](adr/0245-native-commit-text-presentation.md),
[ADR-0247](adr/0247-session-work-and-tool-dispatch.md) and
[ADR-0256](adr/0256-session-publication-and-completion-boundaries.md).

## Persistence boundaries

Native `Storage.commit()` prepares one exact sequence/batch and publishes through
one transactional producer per active physical Session. Main and child
Conversations share that writer and lease. PG authorization runs before and
after producer initialization, not once per token or native commit. Only a
confirmed Kafka transaction permits the Worker to adopt that batch.

Complete native messages, tasks and retained document history are materialized
in PG. Inbox/input metadata and submissions retain authoritative current values.
In-flight `pi.live` text/thinking stays in Kafka and disposable memory; PG keeps
small commit headers and exact settlement/ordered-handoff checkpoints. Required
replay references protect that suffix across root Run anchors.

Display descriptions reference text in the same native commit rather than
publishing a second copy. Local Tool argument fragments remain in Worker memory
at the public Models port; only complete successful model responses expose
calls to native Storage. After native validation, an execute checkpoint and its
cloud dispatch description commit together before an external effect.

Images consumed by models are durable Session attachments. Upload completes
before an immutable reference enters Kafka; the Projector retains references in
the native transaction and never downloads image bytes during replay. Worker
Storage restores exact native images for reads. Missing/corrupt objects cause an
explicit failure. Workspace Volume bytes have their own lifecycle authority.

Disposable phase/Tool previews use bounded HTTP/SSE observations. They have no
Kafka/PG history or model-context role. ADR-0201/0211's bounded path probes are
an explicit exception on the existing Kafka path; they never become native
history, renew a lease or authorize VM cleanup.

A trusted no-send refusal becomes native `StorageRejected`, preserving the
previous acknowledged state while rejecting the new draft. Pi decides the
calling task's failure; this is not a retry promise or retained-result queue.
An uncertain ACK, producer fence or failure adopting an acknowledged batch
retires the writer through the existing ordered recovery path.

## Ordered projection and Tool effects

The physical Session ID fixes the Kafka key and partition. Partition count
cannot change within a Topic generation. Projector replicas share one group,
with disjoint partition ownership and read-committed consumption. Native
publication, control references and closure use the same Session partition.
Different producers still require PG admission and confirmed revocation/handoff
to establish causal order; sharing a key alone does not supply it.

PG native changes and projection progress commit in one transaction. The Worker
assigns native IDs and commit sequence; PG applies them unchanged and rejects
conflicting replay. The first native record also establishes its recovery floor.
Display/control-only first records persist their floor before visibility/effects.
PG transaction-local budgets bound lock/statement waits; failed records retry in
partition order without skipping or dispatching their commands early.

Before a new Tool command reaches Cube, Projector confirms its monotonic Kafka
dispatch commit. Read-only replay below that boundary cannot dispatch the command
again. A crash between commit and dispatch may omit execution and remains
UNKNOWN. Guest execution and its final reply are not awaited by this handler.
Operation cancellation is repeatable and travels with native abort through the
same ordered path. Cube retains its boot/operation/position checks.

Control changes use existing PG Outbox references and Projector-owned partition
publication. Binding views are rebuilt in assigned memory; the Tool route uses
that view. Synchronous routing revocation and external-effect admission checks
remain necessary before the delayed close record arrives. Control references
and wakeups may be delivered more than once; they do not grant a second effect.

## Completion and ownership handoff

Native descendant-aware idle and child publication cleanup precede root writer
drain. The Worker then commits `work_finished` through its Session producer.
Projector closes routing, validates the final native boundary and atomically
records the logical outcome, terminal event, recovery progress and normal writer
retirement. Session-locked readiness releases the next root work. There are no
cloud child Run claims, per-child seals or unsealed-Run counter.

The public terminal becomes visible only after its PG commit. If that commit's
return is lost, normal completion replay reads the exact stored terminal and
coverage. Existing live-view deduplication handles an already delivered copy.
Replay never invents another event ID/sequence or rewrites the winning outcome.
A browser ACK does not control readiness or lease release.

For unknown writes/owner loss, PG revokes the grant and records one Session seal
request. The control publisher takes over the same Kafka transactional producer
identity, rechecks its PG intent and commits under current group ownership.
Routing revocation precedes the successor boundary. A pending forced seal cannot
be replaced by voluntary retirement merely because `work_finished` arrives.

A recoverable seal closes the old incarnation and re-readies the same logical
Run without a fabricated public terminal. Durable resumes checkpoints under the
new PG lease. Unsafe interrupted Tools are not replayed; a committed result is
retained. Stop aborts native work and returns unconsumed inputs after reconciliation.
Writer closure never constitutes evidence that Cube processes have stopped.

## Snapshot-first browser delivery

SSE accepts no Kafka cursor or Last-Event-ID. Kafka group membership locates the
assigned Projector; another API replica proxies the authenticated request. On
ownership loss, subscriptions reconnect to the owner after assigned startup
replay completes.

The owner subscribes to live wakes, captures its immutable tail, then reads a
primary-PG snapshot. That snapshot cannot precede coverage already observed by
the captured tail. Canonical messages and uncovered spans merge into one view.
Complete message projection advances display/native coverage on the Run or
child view, so a refresh does not duplicate text already saved in history.

The Worker interprets native updates; Projector resolves same-commit text
references. Native stream commits coalesce at Pi's 100 ms boundary; Projector
immediately forwards their original display events. Its recovery cache can merge
adjacent commentary/final appends sharing one explicit message identity, without
delaying live delivery. The browser reveals both commentary and
final text progressively; snapshots/reduced-motion/background views apply already
received text directly. Presentation pacing changes no persistence boundary.

Large snapshots/events use bounded begin/part/end framing. A partial value is
discarded on disconnect. Slow network writes time out without blocking Kafka or
other viewers. SSE keepalives keep a connection open but do not poll PG for
missing events; idempotent terminal replay is therefore required.
Pending formal events per subscriber have both a 1,024-record and 16 MiB encoded-byte
budget. Overflow discards disposable delivery and closes for a replacement
snapshot. In-flight values and complete snapshots retain bounded framing; their
total size is not constrained by the pending-event budget.

Queue views and runtime observations have independent disposable delivery.
Terminal state wins over late Working/progress frames. Public activity/path/
execution observations require the existing execution `generation`. Newer
generations clear old phase/path/VM state in both SSE and browser views; older
generations are rejected. Same-generation cache eviction resyncs its readers.
Native queue changes
notify views through the same commit, and queued root/control changes through
ordered PG references. Reconnect rebuilds views; observations cannot schedule
or replay work.

## Failure and retention

| Failure point | Recovery |
| --- | --- |
| Before a batch reaches Kafka, with positive no-send classification | Native draft rejected; Session can remain usable |
| Kafka ACK unknown or post-ACK adoption fails | Interrupt writer; ordered closure and fresh PG grant |
| PG transaction rolls back | Retry the same Kafka position; no early effect admission |
| Native PG commit return lost | Idempotent replay preserves original sequence/content |
| Completion PG commit return lost | Replay returns the stored terminal/coverage |
| Worker lost with a Tool executing | Native unsafe interruption; inspect effects, no automatic shell replay |
| Control Plane replacement | Worker may continue direct publication; projection/dispatch/display can pause |
| Browser disconnects | Replacement snapshot combines canonical history and uncovered live tail |

Kafka time/size expiry is disabled. Reclamation stays behind PG progress, every
unclosed prefix and live replay reference, plus grace. Missing progress or PG
failure stops deletion; a missing required prefix is operator-visible. Kafka is
not lifetime transcript storage or an unlimited outage buffer.

PG remains control/cold-history authority, Kafka the acknowledged active commit
transport, and Cube Volume the Workspace byte authority. Worker/Kafka/PG are
trusted private infrastructure; tenant checks and Tool fencing remain. No second
broker, native writer, per-Step receipt or operation-result ledger is added.

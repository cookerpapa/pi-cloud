# Architecture

Conversation commands follow [ADR-0277](adr/0277-model-event-waiting-and-conversation-commands.md),
deployed as `commands-514e2b0f`, schema 199.
`/usage` reads native committed usage and the active context head/suffix, without
acquiring a Worker or starting a VM. `/compact` routes to the current owner and
creates Pi's exported CompactionTask and an idempotent receipt in one native
transaction. When idle, `runs.operation_kind=compact` uses the existing claim,
lease, writer and recovery path. The receipt points to native Task/Submission
state; summary generation and summary placement remain distinct. No fabricated
user prompt, independent task queue or compaction scheduler is introduced.
Task-scoped public registry instrumentation keeps overlapping normal generation
and compaction model requests separate, including resumed phases. The Models
adapter measures 300 seconds of valid-event inactivity and uses Pi's five native
retries; the Gateway retains only a 15-second connection-establishment bound.

[ADR-0276](adr/0276-scoped-control-plane-releases.md) adds a scoped Control Plane
release for ordinary Tool implementation/registration changes, deployed as
`control-final-35d715ae`. A local expiring projection hold
waits for control handlers and non-replayable native settlement, then parks new
records before projection/dispatch. Planned replacement retains Worker and Cube
identities and uses existing PG owner leases; no second scheduler, execution lease
or browser update mechanism is introduced.
[Delivery evidence](reports/control-plane-release-delivery-20261025.md) verifies
positive old-owner closure, unchanged active Run/Worker/VM identities and updated
tool definitions in the next request of the same Run.

[ADR-0273](adr/0273-resource-intent-and-machine-recovery.md) is deployed as
`resource-intent-cad5487a`, schema 198. PG retains resource intent and lifecycle
completion; Cube supplies disposable physical observations. Dedicated machines
keep their product identity across confirmed allocation replacement. Direct
lifecycle calls use Cube management; Session bindings retain their Kafka path.
[Delivery evidence](reports/resource-intent-delivery-20261023.md) records source,
370 fault cases, matched artifacts, real pause/owner/VM recovery, retained child
previews and original asset preservation.

[ADR-0272](adr/0272-cube-owned-elastic-retention.md) moves elastic
VM idle deadlines to Cube, renewed by typed retention intents on the existing
Session Kafka path. It is deployed as `elastic-retention-03ce2f23`, schema 197,
managed Cube protocol 8 / guest protocol 7. Cubelet's allocation journal and
existing maintenance loop own expiry; the controller idle timer and warm-count
eviction are removed. [Delivery evidence](reports/elastic-retention-delivery-20261023.md)
covers default-window expiry with Control Plane offline, retained files and native
continuation. Dedicated-machine recovery follows ADR-0273 above.

[ADR-0270](adr/0270-guest-browser-and-tool-result-actions.md), deployed as
`guest-browser-bd03f7a6` on schema 197, adds pinned guest Playwright/Chromium with
CJK fonts. Bash starts the browser only when needed; Read uses existing screenshot attachment transport.
No browser service or additional Tool executor is introduced. Native Tool display
descriptions reference bounded `details` in the same commit and resolve structured
`{content, details}` output, matching cold history. The October 24 presentation
amendment uses the Agent's named answer link for application navigation. Preview
parameters/results remain in expandable Tool details; no separate action card,
answer-link detection or fallback is added. The Tool still returns the verified
platform path as text and structured metadata.
[Delivery evidence](reports/guest-browser-delivery-20261022.md) records guest
interaction, screenshot vision and live/cold preview navigation.
[ADR-0271](adr/0271-local-upstream-proxy-configuration.md) synchronizes one local
upstream address to existing host, provider and Cube configuration authorities;
it adds no runtime proxy or configuration database.

[ADR-0268](adr/0268-runtime-capabilities-and-delegation.md) and
[ADR-0269](adr/0269-execution-owned-control-tool-catalog.md) are deployed in
`runtime-capabilities-5d39828d`, schema 197:
credential-free capability snapshots reuse Worker management, native Pi sections
describe network/delegation policy and child progress stays disposable. Ordinary
Control Tool definitions and handlers have one execution-side registry; Workers
update Pi's Registry for subsequent requests. Focused parent views load child
summaries independently of child history. Compatible single-controller updates
use the existing complete-outage replacement order and PG owner-lease boundary.
[Delivery evidence](reports/runtime-capabilities-delivery-20261021.md) records
source/live checks and the remaining overlapping-owner admission issue.

[ADR-0267](adr/0267-scoped-releases-and-model-catalog.md) is deployed on schema 196.
[Current delivery](reports/component-release-20261021.md) validates independent
provider/catalog publication, frozen Run model capabilities, stable Worker/VM
identity during active work and preserved configuration. Native execution/storage
protocols and authorities are unchanged.

The [resource/interaction repair plan](reports/resource-interaction-repair-plan-20261020.md)
and [accepted ADR-0264](adr/0264-subagent-recovery-and-discovery.md) are deployed as
`resource-repair-1cdccb80`, schema 194 / Session topic v18.
[Slices 1–6](reports/resource-interaction-repair-20261020.md) implement shared-holder retirement, supervisor quiescence,
recoverable direct delegation/discovery, retained Volume cleanup evidence,
attachment lifetime reconciliation and connection teardown. They retain the
existing PG/Session/Kafka authority. Source/artifact, native recovery, long-work,
browser, S3 cancellation and full Cube gates pass with original configuration
preserved. Single-image 24.2 MB and combined 6/6/25 MB model/cold-recall
acceptance pass. Earlier upstream timeouts and one incorrect model answer are
retained as separate failed samples; they are not counted as passing checks.

[ADR-0263](adr/0263-model-response-and-work-lifetimes.md) was deployed as
`model-runtime-058925bb`, schema 192. Agent work has no total duration ceiling;
model grants follow existing execution ownership instead of a fixed TTL. Worker
retirement has an independent bounded drain/closure path. Pi's public Models port
owns response phases, completed hosted content, native retry classification and
semantic outcome; the local Gateway owns HTTP transport. Required acceptance and
cleanup are recorded in the [delivery report](reports/model-runtime-repair-20261020.md),
including a real 16-minute Run, graceful handoff and the retained first failed
child-delegation sample. One Session lease/writer and native scheduling remain.

[ADR-0262](adr/0262-native-recovery-read-lifetimes.md) is deployed as
`native-recovery-8c00826a`. Worker native data reads use a separate
four-connection direct-PG pool with 30-second per-operation bounds. Native read
Context/owner cancellation reaches SQL and attachment reads, while User Stop
retains abort/queue settlement and acknowledged commits are still adopted.
Transient `native_storage_unavailable` failures use existing ordered Session
closure and a five-second PG queue delay before same-Run re-admission.
Schema 191 adds the native Submission status index. Existing child reattachment
uses persisted agent configuration and the original Submission, with batched
cloud view/cursor reads and no initial-prompt lookup or redundant configuration
commit. The private execution envelope accepts `{input:{kind:"resume"}}` only
for existing child views; root PG admission still uses prompt input. The family
effect barrier remains. Image hydration keeps per-decode validation because
pinned public hooks do not encompass context reads.

PiCloud is a private/self-hosted multi-tenant Coding Agent. Pi Durable 1.0.0 owns the Harness,
native tasks, model context, input placement, Tool selection and Compaction. PiCloud owns cloud intake confirmation,
execution authority, distributed placement, output projection and Cube lifetimes.
CubeSandbox KVM is the only untrusted execution backend.

This document describes ADR-0247 Session ownership and ADR-0248 management reconnect
with ADR-0249's deployed publication contract, ADR-0250's handoff repair and
ADR-0251's guest attachment/lifetime repair, ADR-0252's receipt/preview repair,
ADR-0253's bounded UNKNOWN continuation, ADR-0254's Worker reply repair,
ADR-0255's native result/metadata boundaries, ADR-0256's publication/completion repair
and ADR-0257's browser observation/buffer repair, ADR-0258/0259's bounded lease/
expiry maintenance, ADR-0260's publication/reader retirement repair and
ADR-0261's bounded projection/writer-view cleanup, ADR-0262's native recovery reads
and ADR-0263's model semantics/unbounded work, ADR-0264's recoverable delegation,
ADR-0265's retained Volume evidence, ADR-0266's attachment lifetimes and ADR-0267's
runtime catalogs/scoped releases, ADR-0272's Cube-owned retention and ADR-0273's
resource intent/recovery (schema 198 / topic v18 / boot reply v3 / guest
protocol 7, adapter startup 3).
The [preceding resource delivery record](reports/resource-interaction-repair-20261020.md)
records the October 21 `resource-repair-1cdccb80` deployment, completed combined
acceptance and retained failed upstream/model-answer samples. Physical
cleanup and original configuration preservation are confirmed; these samples
are not a multi-day SLA.
The [preceding projection repair](reports/seal-projection-repair-20261019.md)
deployed `seal-projection-0de1fe7f`. Projection uses bounded
direct-PG I/O, confirmed closure clears the exact old writer's live view, latest
hash proofs use pending replay ranges, and recovery reuses its locked Run.
Source/artifact and native/browser/child/outage/full-Cube gates passed. Its large-image
cold recall remained unaccepted after model response-header timeouts. Physical
cleanup and original configuration preservation are confirmed; failures remain explicit.
The [preceding publication repair](reports/seal-publication-repair-20261019.md)
deployed `seal-publication-8d9e7bc2`. Publication/binding metadata
uses bounded PG I/O, reader disposal joins group transactions, and failed peer
routes are rediscovered on existing immutable-Fact retries. Required acceptance
and physical cleanup pass; original configuration is preserved. Retained model
TLS/response-timeout samples are distinguished from these runtime repairs.
The [preceding browser delivery record](reports/projector-browser-repair-20261018.md)
records the October 18 `browser-delivery-205e6ac0` release. Source,
artifact and relevant live gates pass: native input/Stop, dual-process recovery,
browser/image/Read, child control replies across replacement and the complete
Cube multi-round/Volume suite. Real Worker recovery keeps one SSE connection and
accepts new-generation activity from revision 1, including fresh Cube evidence.
Pending delivery has a byte budget and commentary compacts by message identity.
The [preceding completion repair](reports/session-publication-completion-repair-20261018.md)
recovers the stored terminal on replay;
definite pre-send refusal stays with native Pi, and completion uses one locked Run
read instead of three. Rejected Tool Results are not automatically retained/retried.
The [preceding settlement record](reports/worker-harness-settlement-repair-20261018.md)
verifies complete coordination JSON, explicit overflow errors and supervisor replies.
The [preceding Worker reply record](reports/worker-reply-repair-20261017.md)
records local admission, receipt separation and same-boot reply resume.
The [preceding preview record](reports/tool-receipt-preview-repair-20261016.md)
covers terminal-aware previews and receipt loss on `tool-preview-325f0ebd`. A measured
30-second SSE recovery exposed a too-short 25-second test deadline; the corrected
fixture records actual recovery and retains all assertions. Earlier external
proxy TLS failures remain documented separately from this passing release.
[Previous acceptance evidence](reports/cubelet-guest-execution-repair-20261015.md)
identifies the preceding guest-6 release `guest-execution-5536fc73`; the
[handoff evidence](reports/projector-cube-handoff-repair-20261015.md) records
`handoff-6ab91bb7` and the
[publication repair evidence](reports/projector-repair-20261015.md) records the
preceding `projector-compact-bf55d9bd` baseline.
[Reconnect delivery evidence](reports/idle-worker-reconnect-20261014.md) identifies
`worker-reconnect-5b6ba003`; the [Session migration evidence](reports/session-work-implementation-20261013.md)
records the earlier `session-work-6ac697f9` baseline.

The [post-Durable review](reports/repository-review-20261006.md) records the audited
baseline. The [repair record](reports/review-repair-20261006.md) distinguishes current
implementation verification from deployment and remaining operational limits.

## One message

Current meanings (older ADR clauses explicitly defer to ADR-0229):

| Question | Current contract |
| --- | --- |
| What survives Worker replacement? | The logical Run and native pending progress. A fresh PG grant is required after ordered old-writer closure; there is no RunAttempt. |
| What does Stop mean? | Native Durable abort plus ordered operation cancellation at the guest Tool/process-group boundary. A cancellation ACK does not prove physical completion; late replies cannot replace a committed native abort. |
| Where is native history saved? | The Worker uses public Durable `Storage`, publishes directly to Kafka and waits for transaction ACK. PG materializes the native state and retained history for cold reads. There is no separate Tool ledger or lifetime JSONL replay. |
| What does an asset restore mean? | A cold PG/image recovery point, with old execution authority removed and new Workspaces. It is separate from resuming an interrupted Run in the same live deployment (ADR-0237). |

```text
Browser → Control Plane → PostgreSQL accepted Run
                            ↓ root work ready → atomic claim + Session lease
                         Pi Worker
                         ├─ native Harness / concurrent Conversations
                         ├─ Model Gateway → CLIProxyAPI → Provider
                         └─ Session producer → Kafka transaction ACK
                                                        ↓
                                             Session Projector group
                                             ├─ PG semantic projection
                                             ├─ live view / SSE
                                             ├─ Subagent admission / delivery → Worker Lanes
                                             └─ Tool command routing
                                                       ↓
                                             Cube native executor
                                                       ↓
                                                 native reply → Kafka reply topic → Worker/Pi

Normal completion → Worker work_finished → Kafka → PG root outcome + writer retirement
Forced closure → PG binding close + Outbox → control publisher / same Kafka partition
  → routing revocation + Projector binding view
  → final Kafka seal → PG terminal/native closure → next Run eligible
Chat Stop → durable PG request → Worker Agent.abort()
  → native abort + tool cancellation → same Session Kafka → Projector → Cube
  → native abort settlement → work_finished; physical cancellation is independently delivered
```

The Projector currently runs in the Control Plane process. Its modules remain
separate from authentication, resource APIs and the Agent Loop. There is one
execution-log consumer group, not separate canonical, live and Tool groups.
Native append and seal **projection** transactions have PostgreSQL-local lock/statement
budgets; timeout rolls back without advancing offsets or admitting a Tool. Failed records
retry in partition order. Phase metrics and payload-free slow-record diagnostics
locate waits without introducing another consumer or a skip/dead-letter path
([ADR-0199](adr/0199-bounded-publication-and-projection.md)).
The source repair under [ADR-0261](adr/0261-session-seal-projection-boundaries.md)
adds a dedicated 12-connection direct-PG projection pool with 30-second acquisition
and checkout bounds. It covers projection/cold boundary/replay/retention metadata,
while the SQL-local budgets remain. Duplicate closure retires the exact old
writer's disposable view after PG confirmation, preserving successor views and
generation/object guards. Latest-hash proof reads start at each existing replay
reference; recovery reuses its transaction-local locked Run. No storage authority
or protocol changes. [Delivery](reports/seal-projection-repair-20261019.md) is deployed
as `seal-projection-0de1fe7f`; source/artifact and native/browser/child/outage/full-Cube
gates passed; its large-image limitation is resolved by the current unchanged gate.
The [Worker recovery repair](reports/worker-harness-recovery-repair-20261019.md)
adds a separate bounded, cancellable read pool for native cold open and image
metadata. Projector and lease-pool budgets remain separate from those data reads.
Under [ADR-0260](adr/0260-session-seal-publication-lifetimes.md), control publication
uses a separate four-connection direct-PG pool with five-second acquisition and
checkout budgets for Outbox/authority/binding metadata. Reader retirement joins
all group transactions before disposal; a failed cached peer is rediscovered on
the existing immutable-Fact retry. [Delivery](reports/seal-publication-repair-20261019.md)
and relevant acceptance are complete; execution/storage authority and wire formats
are unchanged.
Worker admission reads Kafka partition availability and validates the fixed Topic's
replication policy and in-sync replicas. It does not depend on a Control Plane
publication endpoint. The availability mask filters the existing PG claim query;
the PG grant and initialized Session producer still decide write admission.
Control publication retains Projector assignment and installed-view checks.
Readiness is an admission hint, not an additional lease or execution authority.
The boot reply consumer's local readiness also gates new Runs; provider HEAD
startup/admission gates are removed under
[ADR-0254](adr/0254-worker-reply-admission-and-settlement.md). Existing Runs retain
their original wait/ownership bounds. [Delivery evidence](reports/worker-reply-repair-20261017.md)
records source verification, the matched deployment and live acceptance.

Binding bootstrap loads assigned partitions in primary-key pages of 256. Each
owner retains at most 65,536 entries and 64 MiB of serialized binding metadata;
other owners' payloads do not count against that budget. The generated PG Session
hash matches the existing Kafka function; ownership and partition count are not
stored as another authority. PG may scan hashed metadata to filter an assignment;
this bounds transferred payloads and memory, not all database work.

Image bytes travel over Cube's native execution transport and a private S3 attachment
port. The trusted Cube completion adapter externalizes image parts before Kafka replies; Worker restores them
before native Tool completion. The Session append codec externalizes the final
after-hook content too. PG native-log rows retain references; native Storage
reads reconstruct the exact native images. PG plus retained attachments is the
lossless native history (ADR-0192), while Cube Volume remains Workspace authority.
Each decode fetches an identical immutable image reference once, preserving
tenant/metadata/integrity checks; bytes are not cached between decode operations.
The old Fact Gateway, Fact WebSocket, secondary channel lease/progress store,
independent projection service and execution-committed notification are removed.
Historical migrations/reports describe their named revisions, not alternate modes.

Seal/control-reference insertion emits an empty commit-time PG notification. One session-affine
LISTEN connection per Projector wakes the shared Session Outbox claimant;
A one-second idle fallback still covers missing hints and reconnects; known retries
retain their earlier deadline. Sixteen independent sends preserve entity-head
ordering without waiting for an entire batch. Control-reference cleanup has its
own bounded drain loop and does not block publication. Hints delivered during
an empty scan are retained by generation, and cannot bypass publication backoff.
Repeatable input-queue/Subagent directory references coalesce within one PG
transaction, retaining the last version and stable Fact ID. Command notifications
follow successful mutation, so duplicate upserts emit none. Published facts stay
immutable. Input references that add held Steer work carry an additive wake hint;
owned-scope recovery retains ACKed inputs until canonical consumption or sealed
restoration. Other Session events do not issue empty reconciliation reads. A
bounded held-scope index falls back to scoped reconciliation on overflow.
Control Tool waits wake on native generation/input outcomes and ordered supervisor
changes. Reassignment rebuilds references from native commit metadata and current
Tasks; there is no separate Subagent command table or queue consumer.

Chat Stop uses the existing durable PG request to abort the native Conversation.
The fixed remote adapter co-commits the native abort mark and operation-scoped
cancellation through the same Session writer/Kafka path. Projector forwards
its ordered position to Cube; acceptance means the signal was requested, not that
process exit was proved. The fixed guest delivers it to that Tool's AbortController.
Bash cancels its process group. Completed operations, completed background launches
and independent setsid groups are not cancelled retroactively.

Pi Durable owns native abort settlement. The Run need not retain the original Tool
reply waiter or run after-Tool hooks on a late reply; results committed before abort
remain, while uncommitted late physical replies cannot replace the native terminal.
The cancellation API's grace period bounds outer Run interruption, not a promised
window for preserving cancelled Tool output. Missing physical confirmation never
means success or authorizes shell replay. Abnormal binding retirement retains its
immutable target/run/writer in the existing control Outbox, without a process-stop
receipt table or per-Tool PG ledger. See ADR-0221 as amended by ADR-0229.

Cube retains one source identity and per-partition progress per physical VM;
active operation fingerprints disappear after bounded delivery. Boot changes,
confirmed VM absence and shutdown remain distinct. Controller lease loss alone
preserves capsule-backed VM state and bindings for verified takeover. Adoption
and retirement of already-revoked bindings commit Outbox references without
waiting for notification transport. Registration and revocation retain their
publication barriers; pending propagation never substitutes for physical failure.
Read-only probes do not advance admission. See [ADR-0219](adr/0219-ordered-cube-admission.md).

No browser payload or authority moves through NOTIFY. Drain proof and completion
remain separate durable boundaries (ADR-0177).

Within Control Plane, `ConversationReader` owns tenant-scoped history/list reads;
Run admission and resource mutations stay in `ControlPlaneStore`. A conversation
snapshot, inherited history and display coverage still share one repeatable-read
transaction. This is an internal code boundary, not another service or database.
Tree navigation also uses one repeatable-read snapshot and each native Entry's
persisted Turn binding; it never pairs prompts and answers by message count.
Its thin navigation index selects user/final-assistant records before reading bodies.
Reads use 64-record pages and the existing tree response budget; Tool payloads do
not travel through the ordinary navigation query. Prune validates navigation anchors.
Independent Forks separately stream the full prefix through the selected anchor and
copy it in bounded batches inside the same quiescent PG transaction (ADR-0232).
Human Fork copies preserve that binding in their self-contained log.
Canonical Turn reads select its actual execution Session, excluding inherited
copies in independent Fork logs.

Delegated details expose a bounded text-context preview from their frozen anchor.
The read stops at native Compaction or 65 ancestors; summary, retained messages
and recent suffix are presented with explicit truncation when needed. The public
preview references Compaction members by Entry ID plus messageIndex and is not
used to construct Worker model context (ADR-0205).

## Durable input and scheduling

PostgreSQL owns cloud execution admission and leases. The two core business
records are `sessions` (conversation configuration and cloud state) and `runs`
(initial input, frozen execution configuration and one execution lifecycle).
The public root `turnId` remains in the Run as a presentation/provenance identity;
there is no `turns` table or second lifecycle. Session leases, control receipts,
native log/indexes and Workspace ownership still have their own bounded roles
([ADR-0238](adr/0238-native-input-queue-and-run-record.md), schema 183).

For an idle Session, the API atomically persists the initial input and Run before
returning `kind:run`. For an active Run, Enter defaults to native follow-up. A browser-local,
account/tenant-scoped preference in the personal menu can select native steer.
The primary button follows that same choice when text or attachments exist;
only an empty active composer shows Stop. Shift+Enter inserts a newline; IME
confirmation and empty Enter never send or stop. Escape in the composer requests
Stop without clearing its draft; menus and queue editors handle their own Escape.
Both input modes use the Worker's authenticated HTTP management endpoint.
`kind:input` success means that Pi Storage received its existing RF3 Kafka commit
acknowledgement. It does not mean consumed or answered. No placeholder Run,
PG input-payload queue or background redelivery reconciler is created. When the
Worker cannot confirm acceptance, the browser keeps the draft and idempotency
key for retry. WebSocket still carries registration and heartbeats.

Initial intake now reuses the locked Session and freshly read Run idempotency
metadata inside one Store-owned transaction. Routing and insertion share those
facts; the bound insertion action expires when its callback ends. The Run lookup
remains a separate statement after the Session lock, so a concurrent committed
request is visible after waiting. Normal initial intake uses eight business SQL
statements, and same-key retry uses two, excluding authentication and BEGIN/COMMIT.
Workspace/model/environment checks and post-transaction Worker authority checks
remain. No cross-request cache is introduced
([ADR-0240](adr/0240-transaction-scoped-input-admission.md),
[deployed acceptance](reports/input-admission-20261010.md)).

Durable `submission` records and public `pi.inbox` own pending membership and
consumption. Follow-up is consumed when the Agent would otherwise finish;
steer enters at the native interruption boundary before another model request.
Both remain inside the same cloud Run. Code-owned `pi-cloud.human-inputs`
documents retain original text, upload references, initial request fingerprints
and mutation receipts, keyed by Run. Native `history:latest` preserves this
metadata across navigation; a fork starts with fresh metadata. It is not an
independent execution queue. Pre-submission metadata alone is not acceptance.

The Worker serializes human input through its existing input line. A stable
Session/idempotency-derived native request ID resolves lost responses, including
after later edits or a Worker replacement. Intake saves metadata, calls public
`Conversation.submit()`, then associates its native submission ID before replying.
Edits, adjacent moves, individual cancellation and promotion use one public
`Conversation.commit()` against InboxDoc and metadata. Native consumption and
queue edits therefore use the same commit boundary. Consumed inputs reject edits;
promotion changes the existing submission's mode. Original acceptance identity
never changes, and a retry never restores an obsolete draft over an edit.

An unclaimed initial Run can still be edited or withdrawn in PG, with a bounded
`kind:queue` control receipt. Session and Run locks retain the existing claim
race protection. Active-run model/environment/credential configuration remains
frozen; continuation inputs inherit it. Pending inputs have no product count
quota. Queue reads combine native state with unclaimed initial Runs in one
repeatable-read snapshot. Edit revisions cover queue membership, order and
saved revisions, independently of model-output progress.

The Runner rechecks native queues after a successful Agent continuation and
closes input admission synchronously with its last empty-queue decision. Final
native writes occur after that close; late control delivery returns the existing
target-unavailable error. Input delivery rechecks closure after asynchronous
authority/deduplication reads (ADR-0193).

`queued` means accepted, not necessarily dispatchable. Input acceptance freezes
the model/configuration and writes the initial Run and mailbox advancement together;
`ready_at` is set only for a root work head whose predecessor has closed. Otherwise
work-finished or forced-seal projection promotes it in the closure transaction. Both paths hold the
product Session row lock, so racing input and closure cannot lose readiness.
Native child preparation runs inside the current Harness without a queue claim.
Unchanged environment versions use a shared read. Only an image-version change
locks the Project for update and re-reads the current version; ordinary input
does not serialize unrelated Sessions on that Project.

Workers claim only ready root `runs` with `FOR UPDATE SKIP LOCKED`. Local
pending/active family reservations decide capacity. PG locks physical Session
ownership, requires the previous lease to be closed/released, and issues one
lease for the whole root work. Child Conversations are not candidates. No
unsealed-run counter or per-child lease/claim remains.
One materialized candidate supplies the startup context without a second queue
scan. Immutable Session kind and Workspace seed kind travel in the internal
execute command; downstream preparation does not re-query them.
Mutable pending input text is read in a fresh statement after the candidate Run
lock, avoiding a stale joined value from the original statement snapshot. This
adds one `input_snapshot` admission read, never a per-Step query.
Session lease binding, publication scope and running state commit together in
one Run update; rejected admission leaves input queued without another execution
identity. The Runner
prepares and executes immediately after that commit, without separate started/
running transactions or an opening append. An uncertain admission COMMIT can
resume only its exact confirmed record; a post-admission failure requires a seal,
not a pre-start requeue (ADR-0180). Transaction-local locked facts flow into
lease issuance and one conditional running write, which checks database time
after all locks. There is no persisted claimed stage, RunAttempt or startup lease.
Cold Sessions have no Worker affinity or permanent process. Successful claims
wake the next free slot; LISTEN/NOTIFY reduces idle latency and periodic polling
covers missed wakeups. There is no Temporal or competing dispatcher.

An active physical Session occupies one local Worker slot and has one native writer
and one owner lease, while main and Child Agent Loops run concurrently. Model
requests share a separate, abortable, round-robin budget keyed by physical Session;
Tools/child waits hold no model permit. Tree depth and total-node product limits
default to absent; explicitly configured finite policies remain enforceable.
KEDA counts active/ready physical families, not descendant Run rows. Cube compute
capacity scales independently. Draining rejects new families but finishes existing
families, including their newly delegated children.

Admission permits at most two in-flight Run claims
per Worker (ADR-0175). Unknown claims conservatively reserve possible family and
work capacity until commit or failure; PG remains the final authority. This
does not raise model concurrency, change per-Session ownership or allow a
successor to skip the predecessor's seal. New work arriving during an older
empty scan is rechecked on completion; idle scans do not self-wake indefinitely.

`session_leases` has one current owner per `(tenant_id, pi_session_id)` and retains
released incarnations as closure evidence. Its ID is also the native writer ID;
`pi_sessions.lease_epoch` is the monotonic Fence. Heartbeats renew each family
once; released or expired owners cannot revive. Each Run carries an
`ExecutionReference` (Run ID plus Session lease/epoch), not another lease.
The read-only `active_execution_scopes` view combines Run state with current owner
authority for executor checks. Task cancellation closes that task; lost ownership retires
the family, and a successor waits for its one ordered Session closure to project.

[ADR-0242](adr/0242-worker-claim-schema-cleanup.md) names the trusted Worker registry
`workers` and its cleanup records `worker_retirements`; leases, connections,
boot credentials and the execution-scope view use `worker_id`. These identities
are distinct from Cube sandbox IDs and physical allocation bootstrap context.
`pi_sessions` retains only physical identity, lease epoch and partition hash; product metadata stays in `sessions` and native ancestry in Durable.
Native child lookups use scoped source/conversation indexes; cloud root Run
transition history has a tenant/Run/time/ID index.
Normal new-owner admission remains nine business SQL statements. Schema 184
requires the matching drained application release; it adds no compatibility view.

Workspace access across different Sessions is deliberately ordinary user-managed
Linux concurrency, not a scheduling lock or tenant concurrency quota.

Lease decisions use primary PostgreSQL `clock_timestamp()` after authority-row
locks, not application timestamps or transaction-start `now()` (ADR-0170).
Renewal cannot revive an expired owner after a lock wait, and retirement checks
the current locked lease again. Local Worker/control-plane deadlines use a conservative
monotonic observation of the database's remaining lifetime. They trigger local
cancellation; the database and ordered seals still decide authority. This adds
no per-token or per-Step SQL check. Database clock/failover discipline remains an
operator responsibility.

Native writers share one Worker-local lease observer. A single read batch checks
all observed owners, retaining the one-second revocation observation interval.
Committed direct-PG heartbeat renewals feed that same cache. Late reads cannot
overwrite newer renewal evidence, late renewals cannot revive a revoked observer,
and closing one Lane retains observation for its siblings. Expired cold-restore
observations refresh from PG before rejection. Cube boot and closed-scope fencing remain at the external-effect boundary.

[ADR-0258](adr/0258-bounded-session-lease-renewal.md) independently expires an
active observer's last confirmed monotonic deadline even while its read is pending.
Production Workers isolate lease renewal/observation/quarantine in a two-connection
pool, with five-second acquisition and checkout budgets. Checkout covers the
whole transaction, including COMMIT; failure evicts and destroys its connection.
Local revocation and admission rejection precede PG quarantine. Renewal selects
available rows with `SKIP LOCKED`, rechecks PG time and full identity after locking,
and updates only those rows. Eligible busy rows receive an explicit deferral:
no new lifetime, no false revocation, and a retry within one second. Missing from
both renewal and deferral arrays means rejection. The ordinary 60-second lease,
20-second successful-cycle delay and three business SQL statements are retained.
These changes require matched Worker/Control Plane heartbeat schemas; they do
not create a second lease or release ownership before the ordered seal.

Under [ADR-0259](adr/0259-control-plane-expiry-progress.md), Session expiry,
management maintenance and remote Worker retirement advance in independent,
non-overlapping loops. Management checks connection expiry and failed-Worker
admission independently; connection liveness cannot suppress durable failure.
Short maintenance SQL uses a dedicated three-connection direct-PG pool with
five-second acquisition and checkout budgets. Remote retirement retains its
existing claim/HTTP budgets and ordinary reconciliation transactions.

Expiry selects current Session scopes directly, excluding already-requested seals,
and pages by lease UUID. Connection and failed-Worker scans similarly page by
their immutable IDs. Disposable cursors advance past busy candidates and wrap;
they confer no authority. Each candidate preserves lifecycle lock order, uses
NOWAIT and rolls back earlier locks on contention. Fresh PG time and the exact
identity are checked after locking. The default 100-Session batch replaces the
former ten-Worker-by-ten-family window; it is a work budget, not a product quota.
The one-second delay follows completed scans, not a detection-time guarantee.

Failed Workers without retirement are admitted under Host/Worker/connection locks
with the existing Boot identity and `worker_failed` reason. Connection fencing
and idempotent retirement insertion commit together. Normal completion and ordered
seal projection own physical lease release; expiry no longer visits unrelated
healthy leases. Seal/scope updates reuse transaction-local locked facts, retaining
unsealed ownership and successor fencing. The
[review](reports/control-plane-expiry-review-20261018.md) records the earlier
defects; [delivery](reports/control-plane-expiry-repair-20261018.md) tracks verification
and deployment separately from this source implementation.

Under [ADR-0248](adr/0248-idle-worker-management-reconnect.md), management connection
expiry is recorded as `expired`. An authorized idle Boot with no unreleased Session
lease or retirement can reconnect without a process restart. Fresh PG execution
leases also protect a busy Boot, but no longer extend an expired management
connection. Re-registration keeps the Worker/Boot identity and issues a new
connection ID; old messages cannot update a replacement connection. Revoked or
expired Boot credentials and failed/draining/terminated Workers are not revived.
An expired unreleased Session is not evidence of idleness.

Boot provisioning and registration serialize on the existing Host row; registration
checks current authorization after Worker/connection locks. New Run admission
checks the current connection inside its existing final SQL and rolls back to
queued when unavailable, without another SQL round trip. Existing Session renewal
stays independent of the management connection. These changes add no per-Tool,
per-Step or per-token authority query and no new storage table.

## Publication and execution log

Atomic PG admission freezes one root work item's physical-Session lease and epoch.
The Worker opens a Kafka transactional producer whose stable ID is derived from
Topic, tenant and physical Session. Run, epoch and Worker boot are not part of
that producer ID. It checks the exact PG grant before initialization and again
after Kafka has fenced the preceding producer; no PG lock is held during network
initialization. Ordinary commits validate the local shared grant and use bounded
pending bytes/records, with no per-commit authority query or HTTP ingress.

One physical Session has one native Harness, one writer and one Worker family
slot. A Run describes the root work and its ordinary descendants. Children are
native Conversations/Tasks, not separately claimed cloud Runs. They retain
independent input, model/tool configuration, display and cancellation identities.
`subagent_conversations` stores native source and product/resource links;
`subagent_executions` and `conversation_turns` are query views of native progress.
Opaque source JSON is decoded in JavaScript, never converted through PG jsonb.

Worker joins the native family and drains its commits before publishing
`work_finished`. Projector materializes the root outcome and advances the next
work item. The current product releases idle Harnesses, so a normal completion
also supplies voluntary writer retirement. There are no child seals and no
terminal Outbox round trip for normal completion. A pending forced seal remains
the required ownership boundary even if native completion arrives meanwhile.

On failure/unknown commit, PG revokes the old grant and requests one Session seal.
Control Plane closes routing admission, temporarily initializes the same Session
transactional ID, rechecks its PG closure intent and publishes the seal. Projector
installs exact recovery checkpoints and closure evidence before PG can issue the
next lease. A lost local cleanup ACK does not prevent releasing Kafka write
ownership; physical Cube cleanup still requires its own evidence. Old completed
seal requests reuse PG proof without initializing another producer. Uncertain
native publication never automatically retries a batch or reinitializes its
producer. A delayed stale initialization can fence a valid successor, but its
post-init PG check forbids data publication; the successor recovers through the
same closure protocol. Arbitrary unsafe Tools are never replayed by projection.

The code-owned topic is `pi-cloud.execution-log.v18` (schema 194, ADR-0264/0266).
Physical Session ID fixes its Kafka partition; partition count cannot change in
place. Native producers use short RF3/acks-all transactions; no model/Tool wait
holds an open transaction. Consumers read committed records. Control changes
still use one Projector-owned transaction producer per partition, coupled to
consumer-group membership and the existing dispatch offset. Session seals use
the Session producer ID plus that group commit guard. Cross-producer causal order
comes from acknowledged control revocation and PG handoff, not merely the key.

The old Worker open/append HTTP endpoints and ingress identity cache are removed.
Private HTTP only forwards control changes/seals between partition owners.
Worker readiness checks Kafka policy/available partitions directly; replacing the
Control Plane does not reset a healthy Worker producer. Tool dispatch, projection
and browser delivery can pause while the Projector is unavailable. PG remains
the only lease/work authority. See [ADR-0247](adr/0247-session-work-and-tool-dispatch.md).
The [initial outage check](reports/control-plane-outage-20261014.md) exposed idle
Boot retirement. The [reconnect acceptance](reports/idle-worker-reconnect-20261014.md)
now verifies both idle and busy Worker processes/Boots across 60/90-second Control
Plane outages, same-Run/lease/VM continuation and fresh management connections.
This is not proof for every interactive transport or arbitrary schema upgrade.
On a new consumer assignment the reader explicitly resumes assigned partitions;
an old handler's pause must not survive its generation. Recovery then reinstalls
any required pause before dispatch. This preserves the committed effect boundary.

Native sequence, exact closure offsets and fingerprints remain necessary for
idempotent replay. There is no per-Step receipt, second channel lease or signing
key. The first native append co-commits its recovery floor with semantic state;
a first display/control record persists its floor before visibility or routing.

[ADR-0256](adr/0256-session-publication-and-completion-boundaries.md) preserves
proved no-send rejection through the native Session Host. Pi receives
`StorageRejected` while the shared owner remains usable; this adds no automatic
retry or rejected-result retention. Unknown ACK and post-ACK adoption errors
still interrupt the writer. Normal completion replay returns its exact persisted
terminal/coverage, and the completion transaction reuses its locked Run state
with checked, updated versions. [Delivery status](reports/session-publication-completion-repair-20261018.md)
records the implementation, matched deployment and passing live verification.

Hot event and Worker-envelope schemas compile once per server process. Browser
bundles select the same schemas' non-code-generating checker through package
conditions, preserving strict CSP. Validation rules and public errors are
unchanged; this introduces no authority cache or additional durability boundary.

## Unified projection and recovery

One `pi-cloud-session-projector-v2` consumer group assigns disjoint partitions.
Its decoder validates one compact envelope and prepares dispatches once using a
record-local native write index. Nested tools, cancellations and presentation
inherit the root writer identity while keeping their own Conversation addresses.
The original Boot reply Topic is shared by the commit. Expanded commands and
self-contained cold control metadata are internal objects, not another wire format.
After canonical replay/closure checks, a record updates native PG state, its disposable
live view and the Tool routing module as applicable. Guest execution itself is
never awaited by the partition handler. PG or live-owner delivery failure stalls
that partition; it does not serialize unrelated partitions.

Native record IDs, Conversation ancestry and commit sequence are assigned by
the Worker before Kafka publication. PostgreSQL applies those exact records and
updates projection progress in the same transaction. A crash before commit
replays the record; a crash after commit can redeliver it without changing its
meaning. Native sequence conflicts stop recovery rather than being skipped.
Projection checks the commit fingerprint, sequence and current-record identity
only after acquiring the physical Session lock in a separate statement.
This preserves a fresh snapshot after waiting for another projection.
Native message/Tool-intent projection co-commits display event/native positions
on the Run. Active conversation reads stop at that semantic boundary. A
proposed Tool is not rendered as running until its native execution intent exists.
Only text covered by the native content is evicted; mismatched/incomplete text
remains pending for interruption recovery. These metadata updates are not a
second transcript or a per-delta PG write.

PG transaction-time closure checks remain: a stale Projector handler cannot
overwrite a successor merely because it cached an older OPEN state.
The maintained source combines Run and writer validation into one SQL statement
with an explicit Run-before-lease locking dependency, then takes the native
Session lock. This saves one database round trip per native batch without
removing lifecycle synchronization. Display coverage still validates the Run
and native commit on replay, but updates only when either cursor advances.
Partition projection progress likewise updates only to a larger offset; unchanged
replays create no new progress tuple ([ADR-0239](adr/0239-projection-query-and-replay-writes.md)).
This change is [deployed on schema 183](reports/projection-release-20261009.md).

Publication and dispatch/progress commits share a guard for their own partition.
Periodic progress tracks in-flight work per partition; waiting for one guard
does not reserve another partition or suspend its next progress tick. The native
consumer's actual offset-commit callbacks remain serialized for unambiguous
confirmation. This removes cross-partition lock coupling without changing the
dispatch boundary or same-partition handler ordering. Kafka connection/coordinator
failure remains a shared transport boundary.

Recovery starts at the minimum of PG's canonical/unsealed-prefix floor and the
group's committed position. It can replay text/native history but cannot move
the dispatch commit backwards. A new Tool command is dispatched only after its
Kafka offset commit is confirmed; commands below that commit are never dispatched
again during projection replay. A crash between commit and dispatch may omit
execution and remains UNKNOWN. Kafka fetching is not acknowledgement. Complete
native commit/seal transactions advance PG progress. Durable text/thinking partials
are native document changes kept in Kafka and the active live state; PG stores
their small commit headers and settlement/handoff checkpoints under ADR-0244.
Local Tool drafts remain excluded by ADR-0230. Public display fragments do not
create another transcript table.
Rebalance invalidates old subscriptions and rebuilds the assigned prefix before
its Projector serves snapshots.

The private closure prefix retains only sequence progress and uncovered event IDs
for conflict checks. It never retains presentation bodies. Normal completion and
forced closure retire every prefix belonging to that Writer, including children.
The existing public live view owns text buffering and history/display merging.

At a terminal seal, one PG transaction stores the exact public terminal, Run
closure and recovery progress. A recoverable seal closes only the old execution
incarnation and re-readies the original Run, without an invented terminal event. The Projector then updates
the local live view directly. There is no second Kafka commit notice or buffer
waiting for such a notice. A successor is released by the PG closure, not by a
browser ACK. Incomplete Tools remain UNKNOWN; no successful result is invented.

A quarantined Session becomes idle only after its latest failed execution has
both positive Agent exit evidence and a committed seal (ADR-0169). Exit is recorded
after the local Runner settles, or after an exact Worker-stop confirmation;
lease expiry and an unreachable management endpoint do not establish that fact.
The two facts may arrive in either order. Recoverable owner loss re-admits the
same logical Run only after old-writer closure. Durable resumes its checkpoints;
unsafe interrupted Tools are never automatically replayed. A native terminal
outcome or explicit Stop terminates the logical Run. This adds no per-delta or per-Step
database barrier. A stale browser failure state may submit a new-message request,
but admission remains server-authoritative until recovery actually completes.
Unstarted withdrawn or individually cancelled inputs do not supersede an
execution's exit/seal proof. A later admitted Run (start timestamp or lease)
still does, including a Run awaiting Durable recovery (ADR-0236).

Kafka automatic time/size expiry is disabled. Safe retention stays behind
canonical progress and every unsealed start, with an additional grace interval.
Missing progress or PG failure stops reclamation. A known missing unsealed
prefix is an operator-visible failure. Kafka is not the lifetime transcript or
an unlimited outage buffer; PG retains semantic history and bounded recovery
metadata, while Cube Volumes retain files.

## Browser view

The public SSE request has no cursor. The assigned Projector subscribes to live
wakes, captures an immutable tail and then reads primary PG. That PG snapshot
cannot precede coverage already committed and observed by the tail. It merges
canonical messages with uncovered spans into one presentation, not a replay of
raw deltas. No transaction spans a network write.

Snapshots and large complete events use begin/part/end SSE framing with bounded
parts and incremental JSON encoding/decoding. A disconnected partial value is
discarded; only a complete replacement is applied. Small live events remain
immediate. The browser does not submit Kafka offsets or Last-Event-ID. A local
POST which raced with an older snapshot invalidates that UI request, not the Run.
History opens on the latest 40 Turns; earlier pages use an owned Turn identity. An
SSE Turn start can precede its POST acknowledgement and metadata read. The Web
view retains an unknown input as `null`, keeps execution visible and renders the
user message only after matching input metadata arrives. It never inserts
placeholder prose as user-authored content or borrows another draft. Empty text
remains a valid known input for attachment-only messages.
The composer shares one submission-identity implementation across ordinary,
first-message and Steer paths. An uncertain response retains the key for the
same Session/text/attachments/target; confirmation or a different submitted
input permits a new key. Draft edits made while waiting survive the ACK. This
is browser-local retry identity, not a second Run authority or durable draft store.
Returning stopped input ends only the unresolved identity with the same Session
and original acceptance key. A delayed return cannot reset a newer submission.
Queued inputs and unstarted cancellations do not occupy history pages or Turn
counts. The composer owns a separate pending-input view. Initial, focus and
reconnect reads use a current PG snapshot; successful edits reuse their returned
snapshot. Initial-Run changes reach the Session owner through the existing
Outbox/Kafka path; native queue commits carry affected Session IDs in their existing
commit envelope. Both paths update watched memory views and unsequenced `input.queue`
SSE frames. There is no two-second polling. `viewVersion` orders presentation
snapshots as the tuple (native committed sequence, Session row version), independently
of the optimistic edit `revision`, including
Run transitions that change queue membership. Queue changes do not restart the
execution SSE stream. Optimistic conflicts preserve the editing draft.

Chat Stop closes input admission and uses Durable abort to settle the native
queue. The existing cancellation receipt holds only `inputReturnPending`.
After logical terminal settlement and ordered writer closure, the read adapter
returns human submissions that have no consumed Entry and were aborted (or were
still queued when an old writer was sealed). Individually withdrawn inputs and
consumed inputs are excluded. Text/order/uploads come from the native metadata;
there is no Run return-pointer column or separate queue-cut payload. A Stop retry
cannot capture later submissions belonging to another Run. Missing physical Tool
replies are not proof of process termination.

Queue snapshots expose `hasReturnedInputs`. GET
`/v1/sessions/:sessionId/returned-inputs` waits for consumption reconciliation,
then returns at most 20 withdrawn inputs in their original order, including each
input's original `idempotencyKey`. Subsequent
pages use that Stop's `requestId` and `afterPosition`; their immutable membership
survives another browser's acknowledgement. The browser appends their text and
restores attachments without replacing its draft. POST
`/v1/sessions/:sessionId/returned-inputs/acknowledgements` accepts the fully
recovered `requestId` and clears its bounded pending-return marker in the existing
control receipt. Failed or lost acknowledgements do not duplicate draft text.
An unacknowledged return survives a browser/Control Plane restart in its original
native Run metadata. Acknowledgement before closure is rejected. Once recovered, it has the same browser-local lifecycle as an ordinary
unsent draft. Text and images never move into a control receipt or second queue.
The former paused flag, Send action and queue-resume endpoint are removed.

Queue display refresh is bounded asynchronous work in the same owner process,
outside the ordered Projector handler. Two read slots and a separate two-connection
pool isolate it from authority SQL; server statements have a five-second deadline.
Owner reset discards stale completions without freeing occupied slots early.
Failures/capacity exhaustion request resynchronization instead of Kafka retries.
Queue pages contain at most 20 complete inputs, `afterPosition` and `hasMore`.
Continuation requests require the same queue `revision`; changed order returns 409.
SSE publishes the first page; loading more is explicit and newer snapshots discard
obsolete continuation pages while retaining editing drafts. This is a response
bound, not a total input quota (ADR-0216).

The pending queue shares the composer's visual surface. Three rows are shown by
default; expansion and revision-checked pagination expose every accepted input.
Each queued row has Steer and an action menu for edit, withdrawal and adjacent
moves. Editing stays in the row; a consumed input or discarded continuation page
leaves an editable draft, recoverable to the composer. Attachments use compact
chips. Only native consumption removes an acknowledged steer; there is no
persistent success banner or optimistic disappearance. Changing Enter preference
does not mutate existing inputs. Native post-Tools/final consumption timing stays
unchanged, including waiting for the current Tool round.

There is no cloud Steer-delivery reconciler. Worker replacement recovers the
native submissions through the existing ordered closure/new-lease path. Queue
observations refresh only on relevant commits, control changes or reconnect;
an unavailable presentation view cannot schedule or replay input.
Tree jumps load missing pages, and export traverses them. These history anchors
are not stream recovery cursors.

Conversation discovery returns pages of 100 Sessions with an optional opaque
`nextCursor`. It preserves PostgreSQL timestamp precision for the descending
activity/ID position; every page retains tenant and branch-pruning filtering. Browser
load-more appends by Session ID, and a newer refresh invalidates an older page
request. This list position is neither authorization nor an SSE cursor.
The activity index selects the visible Session page before lateral Turn counts;
only that page's history participates in counting. No persistent count mirror is added.

A request arriving on another API replica is proxied to the partition owner
discovered from Kafka group membership. Each replica advertises a unique internal
HTTP URL; Kubernetes derives it from Pod IP. There is no PG partition-owner ring
or second Kafka consumer in this proxy. Both endpoints enforce user/tenant auth.
Internal forwarding bypasses the external Provider HTTP proxy.

Existing readers retain immutable references while semantic commits remove
covered spans. Completed snapshot objects are released after sending, not held
for the lifetime of an SSE connection. Blocked writes have a 30-second deadline;
each subscriber's additional pending formal events are bounded by 1,024 records
and 16 MiB of encoded event bytes. Size is counted lazily once per broadcast when
queuing is necessary. Overflow clears pending delivery and requests the existing
replacement snapshot; it cannot hold Kafka or another viewer. This budget is not
a limit on complete snapshots, total output or actual process heap. Pending text
still needs memory proportional to its actual content, not constant RAM for
unbounded output. SSE heartbeats keep idle connections open. Pi Durable coalesces
model partials at its native 100 ms trailing-write boundary. Projector resolves
committed descriptions and immediately publishes their original display events.
The recovery tail compacts adjacent appends to the same explicitly identified
commentary or final message; that cache has no public-text delay timer.
Complete terminal responses remain visible when no partial
was committed. Phase metadata is preserved and can be corrected by later provider
information; the adapter does not require a text_end event or fabricate a typing
stream. Tool argument drafts and thinking are not public text streams. Tool
preparation is a payload-free, disposable Working observation, replaced by complete
native Tool start/result events.

The browser progressively reveals newly received assistant text for both
commentary and final answers. Both phases share the existing animation path;
recovered snapshot prefixes appear immediately, and reduced-motion/background
views show received text directly. Presentation pacing does not change native
persistence, Kafka publication or the history/display coverage boundary.

Every active browser turn also has a persistent runtime status. The default view
shows the current phase and any connection/update-delay warning. Activity age,
message-path confirmation and sandbox round-trip confirmation are available in
collapsed diagnostic details; these observations are not Tool progress or success.
The trusted
Runner maps native lifecycle/stream events into PiCloud phases and last-activity
time. Worker sends bounded, coalesced HTTP observations to the existing Projector
partition owner; its cached admitted scope checks tenant, Run, writer and fence.
The existing Worker management credential protects this private ingress.
`run.activity`, `run.path` and `run.execution` are unsequenced, disposable SSE frames. Slow readers
retain only the latest values; reconnect starts without old observation history.
Only active turns may display them, and terminal state wins over late frames.
Under [ADR-0257](adr/0257-browser-observation-and-buffer-boundaries.md), each frame
requires `generation`, copied from the already-admitted Session fencing token.
Higher generations reset all old observation/revision state in the SSE view and
browser; lower generations are discarded. A cache eviction which resets counters
within the same generation resyncs the affected Session. No new execution counter,
PG read or durable health record is introduced. Source and rollout status are
tracked in the [delivery record](reports/projector-browser-repair-20261018.md).

Ordinary successfully processed execution records provide path evidence. After
publication silence or stale execution evidence, one physical Session emits at
most one `path_probe` every 15 seconds through its existing publication writer and
Kafka partition. One bounded payload includes its activated Lane bindings; there
is at most one pending guest response per binding. An acknowledged ordinary
record must precede probes. Projector arrival immediately confirms the log path.
Existing active bindings can continue through Cube's fixed guest probe and the
original Worker's reply mailbox; grouped bindings sharing a VM use one guest echo.
The Worker reports that complete round trip over HTTP. Log-path confirmation
does not wait for this branch. Unactivated bindings are not applicable, never
provisioned for observation; an expected but missing binding stays unavailable.
The probe is the explicit observation-transport exception: it enters Kafka but
never native Pi history, PG projection, display sequence, model context or Tool
execution authority. It neither renews leases nor changes recovery authority.
Original timestamps, matched probe/target/boot identities and monotonic positions
prevent replay from appearing fresh; evidence older than 45 seconds is stale.
Projector reset discards pending evidence. A probe ACK failure
does not create an uncertain semantic mutation; shared producer failures retain
the existing fail-closed behavior. Phase, actual model/Tool activity and path
confirmation are separate UI signals. See [ADR-0201](adr/0201-runtime-activity-and-path-probes.md)
and [ADR-0211](adr/0211-execution-path-and-runtime-probes.md).

## Native Pi state and Harness

The public Pi Durable Storage port owns atomic batches of Conversations, Tasks,
Submissions, Entries and Chord document writes. One physical Session has one
Harness and one renewable PG execution lease. A native Conversation is the
execution Lane; its numeric ID comes from Pi, never PG admission. Child creation
has an atomic native receipt before the product binding becomes ready. A child
Conversation belongs to the requesting generation, allowing its delegation Tool
to return a blocked result and the parent to issue a later reply Tool. Native
parent abort still cascades to that child.

[ADR-0243](adr/0243-native-input-current-state.md) separates durable current input
state from retained history. `pi_durable_current` stores one current body for every
Submission and the conversation-scoped latest-only `pi.inbox` and
`pi-cloud.human-inputs` documents. The latter preserve native version/delta count,
creation/retirement identity and provenance. These bodies do not appear in
`pi_durable_log` or accumulate document-revision checkpoints. The Projector applies
current replacements and native consumption's immutable user Entry in one PG transaction.
Individual cancellation clears unused text/upload metadata through Pi's transaction;
Stop-return and consumed-message presentation data retain their existing lifetime.

`pi_durable_log` retains other native writes as JSON text, preserving NUL and lone
surrogates. `pi_durable_commits` retains sequence/ID watermarks, original replay
fingerprints, retained-history checksums/counts and small current-state checksums.
`pi_durable_records` indexes retained history and current state; the body resolver
is one view over those two stores, not a second transcript copy. Other documents
still use `pi_durable_document_revisions` with derived checkpoints every 64 deltas.
Fixed selector keys are code-owned SQL literals while values remain parameters.

Rebuild requires quiescence, validates journal completeness and the latest required
current values, and rebuilds only indexes. It never deletes current state, runs
Tools or allocates sequence. Current state must accompany history in asset recovery;
chat history alone cannot restore the input queue. Kafka acknowledgement, native
batch atomicity and the ordered closure/new-lease boundary remain unchanged.
[ADR-0244](adr/0244-kafka-backed-native-live-state.md) is implemented in source
under matched schema 186; its deployment status is recorded in the
[verification report](reports/native-live-state-20261012.md). Conversation-scoped
`pi.live` also uses `pi_durable_current`, but its PG row is a boundary/handoff
checkpoint rather than a replacement on every delta. Active updates remain in
complete Kafka commits and disposable Worker/Projector current values. A nullable
topic/partition/offset/sequence reference protects the suffix not included in
the PG checkpoint, independently of which Run anchored its publication.
Native commit headers/checksums remain in PG; streaming bodies and their 64-delta
checkpoints do not. Other document and Task history policies are unchanged.

[ADR-0245](adr/0245-native-commit-text-presentation.md) carries assistant display
metadata in that same native commit. The trusted Runner interprets Pi and emits
text selectors, not a second body. Projector resolves a same-record Entry string
or the native live document produced by this commit, using its existing memory
view. It skips canonically covered references before resolution during replay.
No extra text fetch, Harness in Control Plane or new storage authority is involved.

ADR-0249 extends same-commit descriptions to native Tool starts and canonical
Tool results. Worker interprets validated Task checkpoints and post-hook result
Entries; Projector resolves owned value/text selectors, image placeholders and
the bounded display format. The post-adoption watcher no longer publishes a
second copy of Tool arguments or output. Native batch contents remain intact;
unrelated human-input, model and hosted-activity notifications keep their paths.

All publications use the physical owner's existing serialization boundary.
Each Conversation view keeps its own display sequence; preparation adopts that
sequence only after Kafka ACK. Canonical Entry projection and display coverage
share one PG transaction. The root Run is locked before the shared lease and
native Session. Child display retains its own product Session/Turn while sharing
the root Run and Writer, even when the parent anchors publication.
The initial Kafka floor also accounts for that co-committed child display.

The public `assistant.text.delta` SSE payload retains `messageId`, `text`, `phase`
and `replace`. Optional `settledMessageId` renames the completed active block to
its canonical `entry:<id>:<block>` identity. A resumed native Task can then stream
a new reply without overwriting the previously interrupted one. The web client
and snapshot reducer apply this rename; native selectors stay private.
Non-text notifications remain on their existing path. Their later coverage
updates must never cover a newer, uncompleted native partial. The Worker guards
that checkpoint with its last canonical native sequence and current partial state.

The Worker keeps the current live value across ordinary projection-buffer flushes.
Cold open checks checkpoint completeness in the native-head query. Projector
restart reconstructs protected live state even for already-projected batches or
closed publication anchors, using stored fingerprints and cutoffs; reconstruction
grants no append or Tool-dispatch authority. Old-writer closure atomically installs
exact live checkpoints before permitting replacement. Native sequence, document
version and delta count are retained. Safe Kafka deletion includes outstanding
live references, and cold administrative mutation/export requires their completion.

The Worker prepares and validates a detached batch, publishes it directly to Kafka,
waits for RF3 Kafka ACK and only then exposes it to Pi. A bounded acknowledged
overlay handles PG lag. Ordinary buffer eviction waits for the existing projection watermark in
batches, not a receipt per Step. A proved pre-enqueue refusal leaves the writer
usable; an ambiguous commit poisons that owner until ordered closure. Cold reads
use native head markers, scoped record indexes and bounded document tails.
An acknowledged local base and its complete suffix satisfy document reads
without cold revision SQL. Historical points before that base and suffixes whose
base was evicted still read PG and merge its derived checkpoints (ADR-0236).
Both overlay and cold modes run the official upstream Storage conformance suite.

The trusted `DurableAgentSession` supplies live model and remote-effect grants;
Pi owns scheduling, retry, foreground Compaction and abort. Stored model
references have no credentials. Compaction uses the same model authority port.
Reopen restores summarize/retry request identity from live persisted Compaction
tasks before rebinding the new PG grant. Display sampling correlation handles
overflow snapshots without assuming a start event survived; native retry progress
may precede its terminal-only assistant Entry. These repairs do not add another
checkpoint, model counter or execution authority.
The Models port retains streamed local Tool calls in Worker memory. Text and
thinking partials reach Durable with empty text slots in place of Tool blocks,
preserving content indexes without storing Tool names, IDs or arguments.
Only a complete successful response exposes its Tool calls to the Harness;
error, abort, deferred and length-truncated replies omit them. Tool preparation
activity remains payload-free HTTP/SSE. Kafka retains complete native commits. PG materializes the current input values
and retained history under ADR-0243; the Models policy never strips fields from
accepted Storage batches or introduces a second recovery log (ADR-0230).
Automatic background Compaction is disabled through the public setting because
cloud background admission is not yet a product capability. The API uses generic
Session data operations while quiescent, never a Harness or model/Tool executor.

After native argument validation and before-hooks, the fixed remote Tool prepares
its binding/callback. Its native execute checkpoint and compressed Cube dispatch
co-commit in one Kafka record. Arguments occur once, in that checkpoint. Projector
confirms dispatch progress before Cube handoff. The display identity is the native
Tool task ID (`task:<id>`); provider call IDs stay in native messages, and a separate
operation UUID correlates physical replies. Unoffered calls have their native
result-entry identity. A late physical reply cannot overwrite native abort.

Independent human forks own copied entries, document bases and image references.
Native `asOf`/`current` document fork policies are honored; `initial`, task and
Session documents do not copy execution grants. Deleting the source cannot break
the copied history. World State compares against its native document baseline.
A verification reminder is derived from committed current-Run entries at native
yield; neither delayed display callbacks nor Worker replacement can duplicate it.

Images in native records and documents use immutable `pi_cloud_image_v1` references.
Only the trusted Worker hydrates pixels; Projector retains references atomically.
Unsealed source Runs protect unprojected uploads. Cleanup claims reachability in
PG and deletes S3 bytes outside the transaction. Workspace bytes remain solely on
Cube Volumes. There is no old SessionStorage backend, operation ledger, JSONL
replay, or patched Agent loop. See [ADR-0229](adr/0229-native-durable-runtime.md).
Provisional user-upload pins bind exact native operations and writer incarnations;
only a receipt or ordered closure resolves uncertain acceptance. Unacknowledged
PUTs retain cleanup inventory even after a DELETE, until positive write completion
precedes another delete pass. Source previews use scoped verified streams
([ADR-0266](adr/0266-upload-reference-and-write-lifetimes.md)).

## Tools and Cube

The Control Plane owns control admission, the Session Projector and a
sandbox lifecycle module. There is no independent Broker process. At the
Worker's existing lazy binding hook, the controller materializes the chosen VM
and stores bounded immutable transport metadata (Cube API/node/boot and guest
attachment). Pure chat still allocates no VM. The Projector confirms its
monotonic Kafka dispatch commit before handing a fixed Tool directly to Cube.
It waits for bounded takeover, never the duration of Bash execution.

[ADR-0250](adr/0250-cube-handoff-outcomes-and-runtime-admission.md) separates the
takeover failure reply from quarantine success: both start and settle independently,
without detaching lifecycle work. Availability codes and execution evidence are
classified separately; an unavailable endpoint can definitively refuse before
execution, while unknown refusal semantics remain UNKNOWN. Known-binding Tool,
cancel, probe and preview reads use the existing exact memory key and validate
the writer, without enumerating a family or querying PG. The
[delivery record](reports/projector-cube-handoff-repair-20261015.md) records the
serving release, native race tests and real acceptance.

Binding creation, closure, deletion and controller adoption co-commit bounded
control-change references with PG state. They publish to the same Session
partition through its control publisher. Projector maintains an indexed binding view;
ordinary Tool/probe routing reads memory. PG reads belong to control publication
admission, consumed changes and bootstrap. A closure installs current closed
state at the partition owner before its Kafka publication, so a delayed close
event cannot permit more queued dispatch after acknowledged revocation.
Bootstrap captures Kafka bounds before reading PG routes. Binding identities
never reopen or silently retarget a replacement VM. These facts do not become
Pi Entries or model context. See [ADR-0212](adr/0212-ordered-control-read-models.md).

Cubelet owns native containerd process handles and operation-scoped guest cgroups.
Its Tool/Cancel admission checks the existing in-memory VM catalog under the same
Manager mutex that protects position registration and confirmed-absence cleanup.
A missing catalog entry cannot recreate a removed VM's retained position state;
it is refusal evidence, not physical-absence or quota-release authority.
It rejects stale positions and duplicate/changed operations in memory, without querying PG Run leases.
A trusted host completion adapter externalizes images and publishes one final
reply to the original Worker boot. Pi Harness processing still creates the
canonical Tool Result. No raw-result GET/cache or PG operation ledger exists.
Uncertain execution never causes automatic shell replay.

[ADR-0251](adr/0251-guest-attachment-and-execution-bounds.md) defines guest protocol 6:
full initialization carries environment/seed data only at VM preparation; ordinary
Tools carry an attachment with binding identity, working directory and optional
network configuration. One strict guest message replaces the old outer wrapper.
Known expiry/cancellation before Start retains non-execution evidence. Native
cleanup keeps a finite final Kill budget even after its parent expires; ambiguous
Start or stopping replies remain uncertain. Native Read path interpretation is
contract-tested against pinned Pi while retaining bounded reads and images.
The [repair record](reports/cubelet-guest-execution-repair-20261015.md) records
the matched rollout, source/live acceptance, failed samples and cleanup.

The [guest return-path review](reports/guest-cubelet-result-review-20261016.md)
reproduced receipt-only loss discarding a valid result and triggering operation
cleanup, and oversized temporary previews being dropped. Current source implements
[ADR-0252](adr/0252-tool-receipt-and-ephemeral-preview.md) in guest protocol 7:
only the fixed launcher can classify failed reverse receipt after successful local
settlement as exit 76. Cubelet requires a unique valid final frame and confirmed
normal/receipt-only exit before retaining the result without scoped cleanup.
A final observed before the execution deadline gets a bounded settlement join;
missing/invalid evidence retains UNKNOWN and the existing cleanup boundary.
Explicit scope cleanup still applies, and late replies never replace Pi abort.
This does not prove Kafka durability or authorize replay/whole-VM destruction.

Authorized closure revokes publication and binding routing admission before the
seal. Normal Stop co-commits native abort and cancellation for unfinished fixed
Tools or workflow scripts; a late reply cannot replace the native outcome. Binding closure itself has no
process-stop receipt. Interactive workflow orchestration closes with its caller.
A late reply is discarded when its original waiter no longer exists.

The controller chooses, observes, adopts and quarantines physical VMs, and owns
explicit release and recovery. ADR-0272 moves elastic idle expiry to Cubelet's
existing synchronous allocation journal and maintenance loop. Finite retention
intents share the Session writer and Projector; no per-pulse PG history or second
idle timer is maintained. Diagnostic probes cannot renew this resource policy.
A normal Tool error or user Stop does not destroy a VM. User cancellation acts
on unfinished Tool process groups. Explicit native Tool
execution timeouts still stop the main process and clean its cgroup; ordinary
completed Bash can leave background servers. Executor boot replacement or an
unsafe native timeout outcome makes the VM unavailable for recovery. User-owned
machines keep their explicit release semantics, and elastic VMs retain their
existing Workspace lifecycle. Missing heartbeats/master routes never prove VM
absence; quota release follows positive observation on the recorded node.

Physical health runs independently from resource cleanup. A due-time pump covers
all known VMs with bounded concurrency, without truncating each sweep to 16.
Recent current-VM responses from Worker probes or real guest Tool completions
postpone duplicate controller execution checks. Idle VMs use the same fixed
guest probe with a bounded direct HTTP response, independent of Worker/Kafka
availability. Paused VMs are not woken. A bounded inventory supplies positive
lifecycle observations; omissions require exact node observation and never imply
absence. Probe failure only requests further diagnosis; definite stopped/unsafe/
absent observations retain the existing recovery policy. Health samples remain
in memory and metrics, while lifecycle transitions remain in PostgreSQL.

`SandboxAdmission` owns local physical capacity and allocation waiters. Runtime
capsules preserve elastic and development VMs across controller replacement;
recorded execution boot identities cannot silently change during adoption.
Closing control-plane transports does not destroy accepted Cube executions.
Run bindings and terminal channels do not own the shared VM. Physical allocation
counts do not double-count a machine borrowed by an Agent or a shared terminal.
Interactive workflow hostcall channels retain their existing control-plane
connection lifetime; they are separate from fixed Tool takeover.

VM creation and retirement follow [ADR-0223](adr/0223-recoverable-vm-allocation.md).
Before calling Cube, PG stores a bounded immutable creation configuration and
five-minute creation authorization on the existing physical resource record.
Controller replacement can recover an allocation before its encrypted runtime
capsule exists. Cube's allocation catalog fixes VM ID, node and node boot before
dispatch. Node metadata durably admits the exact identity before native creation;
duplicate requests return its outcome without repeating the workflow. Observation
queries may repair publication metadata but do not start a missing VM. Explicit
Create retries remain confined to the same recorded node and boot.

Cleanup atomically marks the PG allocation closed before contacting Cube. Closing
at the node excludes future creation and joins any accepted creator before
physical absence can be confirmed. No-handle cleanup uses the allocation catalog,
not a missing inventory entry. Newer PG completions cannot reopen a closed intent.
Master records admission holds before creation and reconciles versioned node
holder/cleanup state independently of allocation reply persistence (ADR-0226).
The fixed POSIX Detach requires no success-only metadata after failed Attach;
pending cleanup and shared-holder protection remain durable (ADR-0227).
Confirmed closed receipts may
expire after their immutable authorization window plus one hour; node boot checks
and durable clock floors continue rejecting old requests. Uncertain creations and
unfinished cleanup never expire merely to free capacity. Historical untracked
allocations retain independent-verification requirements. No VM deletion follows
ordinary Agent Stop or an ordinary Tool error.

Controller lifecycle transactions retain owner SHARE locking, resource CAS and
PG-time checks, with server-side lock/statement/whole-transaction budgets.
Renewal only updates the controller identity; resource invalidation runs in
bounded maintenance batches with SKIP LOCKED. Terminal ownership follows that
identity directly, without copied per-terminal lease timestamps. Cold native
writer cleanup batches active-Run queries and never overlaps itself (ADR-0227).

The guest executes the whole fixed Tool, with native edit/write logic and source
output bounds.
Oversized-line Read retains a UTF-8-safe text prefix. Continuation guidance
travels as structured diagnostics through Tool Worker protocol 5; native Harness
renders it after bounding content, so a full text budget cannot erase the hint.
Ranged reads do not scan the remaining file just to count total lines/bytes.
The matched-release requirement is recorded in [ADR-0236](adr/0236-recovery-input-identity-and-tool-diagnostics.md).
Head/tail truncation is a licensed, source-pinned Pi 1.0.0 helper subset with
upstream-output contract vectors. The guest does not depend on the full Pi CLI,
MCP, Codemode, TUI or model-provider SDKs. Native file Tools still use public Durable
Tool/environment APIs; no private package import or Agent-loop patch is used. Internal reads/writes are not separate RPCs. The trusted Cube
adapter forwards Pi-native final results to a Worker-boot Kafka reply topic;
all slots share one topic. A random operation ID correlates the waiting callback,
not authority. The final reply resolves or
rejects `execute`. Pi still owns after-Tool hooks, its lifecycle events and the
canonical Tool Result appended to the execution log. Kafka reply ACK releases transport buffers, with
no completed-result cache or per-result retirement notification.
Eight large-reply permits replace the former two; source truncation and the
64 MiB per-reply framing remain. Cube transfers immutable final buffers to
delivery without two extra full-frame copies. Read remains conservatively
classified before execution; actual-image streaming is a separate future change.
Explicit before-start cancellation is distinct from interrupted execution.
Confirmed `not_started` survives Stop; fixed Tools and Workflow share typed
infrastructure failure policy, blocking further sampling on UNKNOWN while
ordinary native/business errors stay on Pi's normal Tool error path (ADR-0227).
Current source implements the narrow [ADR-0253 exception](adr/0253-tool-reply-uncertainty-and-continuation.md):
fixed-Tool reply deadlines and explicit handoff transport loss can permit inspection
after a fresh bounded probe and current binding/owner confirmation. Generic
execution UNKNOWN, protocol failures, Stop and lost ownership still interrupt.
Probes remain outside native history/model context and never become lease, replay
or VM-destruction authority. [Verified release `tool-unknown-791a6ed0`](reports/tool-reply-continuation-20261016.md)
includes idle completion-child recovery. Submit and async
probes reuse the existing process owner's bounded readiness recovery; healthy
admission checks memory only. Direct physical probes do not depend on the adapter.
Stop arriving during producer bootstrap is retained until the bounded authorized
writer is ready; Pi opens in its existing `stopOnResume` mode with effects blocked
and settles cancellation normally. Aborting each bootstrap would prevent native
settlement and requeue the same Stop indefinitely. Pure claimed Workspace seed
metadata does not intercept the Stop; native Pi completes its abort. The release
record distinguishes Tool/Worker crash acceptance from ADR-0226's conservative
unknown Volume-reference state, which still requires positive operator recovery.
Confirmed loss of a user-selected working directory before a fixed Tool starts
also returns a native Tool error, allowing the Harness to continue the dialogue.
The guest classifies missing/non-directory paths at preparation; it never repairs
the directory or chooses another cwd. Unexpected filesystem and Volume attachment
failures retain infrastructure handling, including the fixed `/workspace` mount
boundary. The completion adapter does not infer outcome from Tool text
([ADR-0241](adr/0241-missing-working-directory-tool-errors.md)).
Kafka Tool replies accept only the final result; typed observation probe replies
share that mailbox without resolving native Tool callbacks. Guest updates use the separate HTTP
observation path. The Worker observes its reply Promise before awaiting command
publication and retires it on every exit, including image-decoding failure.
ADR-0254 separates validated execution receipt from attachment restoration
through an invocation-local wait handle. Image restoration uses caller cancellation
and its storage budget, independently of the satisfied receipt deadline. An
attachment failure interrupts with its own reason without declaring sandbox loss
or retroactively cancelling a completed Tool. Same-boot reply reassignment uses
the reader's existing volatile progress; this cursor is not Pi history or
Projector durable recovery state.
Committed observer notifications which produce no outgoing display body do not
read an Entry or its sequence. Observed Entry progress still advances. Sequence
lookups use acknowledged in-memory metadata or select only `seq` from the scoped
record index after eviction, without restoring bodies or images. Native guest
results and packed Kafka replies use distinct content schemas; malformed content
cannot mark a mailbox invocation as validly settled (ADR-0255).
The Projector expands a combined invocation into the native Cube handoff
only after materializing its native intent. Cancellation before the invocation
enters its publication queue prevents dispatch; later cancellation can race
execution even before the producing Worker receives its ACK. Projection replay
never reissues the command.

Guest file Tools treat cwd as a relative-path base and follow ordinary guest
paths/symlinks. Native Node writes retain byte bounds, edit-conflict detection
and file/parent fsync before success. Host Volume browsing retains its separate
containment checks. Pi may run read-only/delegation batches concurrently; any
fixed write/edit/bash in a batch retains native sequential execution. Existing
Tool transport/fault bounds remain, as does one ordered Session writer. Product
quotas for families, descendants and model/Tool call counts default to absent
(ADR-0215).
The former per-file and raw Bash RPC forms are removed; native Tools and scoped
workflows are the only Agent execution requests. Text reads retain Pi's LF split,
CR and BOM behavior, including an empty final line, within the existing bounds.

One Runner sampling-context adapter prepares World State and model headers for
both pure chat and file-capable Runs. The Step's `activeTools` is explicitly the
file/shell grant; Pi owns the complete executable Tool registry. Preparing an
empty file grant does not activate Cube.

Pi source updates are disposable observations, not model context. The guest's
pinned headless-terminal adapter interprets decoded Bash output before CR stripping;
the independent final-output collector keeps its existing result policy. Bash
retains ordinary pipes. The preview has fixed geometry, an 8 KiB UTF-8 text bound
and a bounded parser queue; overload retires the preview without pausing execution
or losing the final result. Ordinary changed views emit at most once per second,
with a self-contained reset every five seconds while the preview is active.
HTTP/SSE preview schema 2 carries revision-bound edits/resets, without copied Tool
arguments or final-result metadata, within a 64 KiB encoded frame ceiling.
Cube completion HTTP and SSE coalesce edits against one bounded view, rather than
overwriting unrelated deltas. Missing bases or uncertain delivery wait for a reset.
An internal credential protects ingress; partition redirects use Kafka membership,
not PG queries. Reconnect starts empty and recovers from a periodic reset even
during silence. Only running Tools display escaped text in the opt-in fixed-height
preview. Completion discards pending previews and wins over late progress.
No Kafka/PG row, model context, durable replay, Worker callback or background-service
log follower is created for progress. [ADR-0252](adr/0252-tool-receipt-and-ephemeral-preview.md)
replaces ADR-0184's snapshot body while preserving its observation-only boundary.

Reply topics have bounded retention, are deleted at graceful Worker shutdown,
and are reaped only after positively completed Worker retirement plus grace.
They are not a cold recovery source. Already-admitted work may finish after
closure; late replies cannot reopen a call or enter sealed history. UNKNOWN
never triggers automatic shell replay. Kafka fencing cannot undo an already-issued
Cube request or roll back a running process. See [ADR-0183](adr/0183-native-remote-tool-execution.md).

Worker-local `supervisor-host/src/tools` contains the trusted Tool catalogue and
generic remote proxies. The `subagent-control` adapter authorizes child resources
in PG; Control Plane calls Worker native create/configure/input/stop capabilities
rather than running a Harness. Ordinary Tool dispatch references the same
committed native execution intent; dynamic workflow hostcalls have native Task
Doc receipts. Their final results use the same boot-scoped Kafka mailbox as Cube.
Only Pi's processed Tool result is canonical.

ControlToolDispatcher keeps active references and bounded in-flight handlers/reply
bodies. Reference memory is proportional to active native control Tasks; it does
not copy prompt or script bodies. A wait holds no handler/model permit. Native
outcomes wake relevant references; retries have deadlines. Reassignment joins
current native Tasks to commit metadata. Receiver input receipts are checked by
the current Worker at its native input boundary, not a cached child Run state.
No PG command-body queue, result cache or per-child polling loop is retained.

Direct delegation creates no script or Cube. Workflow JavaScript runs in Cube
through envd's bounded stdin/stdout bridge. Guest `runs.*` requests return to the
owning Worker publication port; no PG/Kafka/model credentials enter the guest.
The script's explicit return travels over the Kafka reply channel and becomes
the outer Tool Result. Its `runs.*` duplex host-call channel is unchanged. Variables and JS
call stacks are not recovery checkpoints. Preview remains a fixed trusted
platform adapter; user-supplied Worker extensions are not supported.

Under [ADR-0255](adr/0255-native-tool-result-boundaries.md), coordination tools admit
coordination result text within Pi's native 50 KiB UTF-8/2,000-line defaults.
A final LF terminates its line; outer JSON escaping is not counted as native
text. Structured values are serialized once. Oversized values/errors produce
explicit bounded Tool errors instead of incomplete successful JSON or retries.
Supervisor metadata omits duplicate output/reply text and retains a separate
same-budget check; hostcall values are checked before their identity wrapper.
This supersedes ADR-0196's 256 KiB result budget while retaining the 900 KiB whole
execution-fact bound. [Delivery status](reports/worker-harness-settlement-repair-20261018.md)
records source and deployed verification separately.

Delegated task input is checked before Tool intent and again before PG child
admission. It shares the public/Worker 100,000-character prompt bound and has a
256 KiB JSON-encoded UTF-8 budget, leaving room for all three native startup
copies without enlarging Kafka records. Unsupported NUL/unpaired-surrogate text
is rejected before storage. Tasks are never silently truncated (ADR-0204).

## Workspaces and development machines

An elastic Workspace owns one persistent Cube Volume and one default compute
scope with finite retention. Different ordinary Sessions receive independently fenced Tool bindings to
that same environment. Files, ports and processes are shared intentionally. Human
terminals may use it concurrently. Pure chat does not reserve compute. Ordinary
directory/file browsing reads current bytes, not a per-Run file index or archive.
No runtime object or Workspace settlement head is required to start a Run or
retain compute. Environment validation is recorded at activation. Oversized
raw Tool output is not archived; the native result contains bounded output and
truncation guidance. Subagents can create additional temporary compute scopes
mounting the same Volume; stopping a scope never deletes shared files.

Cube's Controller Volume Plugin initializes storage and atomically publishes one
immutable Volume identity. The trusted Volume Gateway verifies that identity; it
never repairs or initializes storage during a read. Guest seed initialization
only supplies missing files and cannot clear existing user data. A separate
generation-bound deletion grant still expresses PG-authorized release, not mount
refcount. See [ADR-0172](adr/0172-plugin-owned-volume-initialization.md).
Gateway reads and uploads hold shared filesystem exclusion on the existing
Volume envelope; credential callbacks take a separate exclusive lock after that
shared admission. Deletion preparation/finalization requires exclusive Volume
access and waits for active callbacks. Uploads retain unique staging and
non-overwriting atomic publication. The Node-owned descriptors outlive the
acquisition utility and are independent of PG connections. Lock files remain
outside guest mounts and disappear with the retired envelope. Replaced-inode
waiters are refused. An absent root may return an empty directory listing without
creating storage; no such read establishes deletion authority. PG upload/lifecycle
authorization and Cube attachment evidence remain required (ADR-0231/0234).
Deployment Recreate excludes mixed Gateway lock contracts.

[ADR-0235](adr/0235-upload-staging-recovery.md) moves upload temporaries into
managed areas on the destination filesystem. Gateway areas remain outside the
guest mount; machine areas belong to the fixed guest helper. Shared OS-held
staging locks cover writes and atomic publication. Nonblocking exclusive cleanup
can reclaim abandoned temporary names after process loss while preserving active
writers and final files. Startup/periodic scans do not depend on PG draft rows.
Guest filesystem locators retain discovery across Session deletion; they contain
paths and inode identities, never uploaded bytes or execution authority. Guest
maintenance applies only to already-owned, running development machines. Elastic
Workspace staging is reclaimed by the Gateway. Paused/inactive VMs are not woken,
and cleanup failure cannot authorize quarantine, destruction or quota release.

Under ADR-0273, a user-owned development machine is a stable product resource
with desired running/paused/released intent and an independent current allocation
UUID. PG lifecycle phase records admission, provisioning, settled intent,
reconciliation and confirmed release, not current VM health. Intent revisions
reject stale acknowledgements. Cube supplies physical observations; the resource
API combines them with intent and progress, and does not persist VM IP samples.
Machine creation/recovery uses direct SandboxProvider → Cube API management.
Session binding changes still use the existing Kafka control-reference path.

The existing recovery loop adopts running instances, respects deliberate pause,
and replaces positively stopped/unsafe/absent instances only after closure and
confirmed absence. An unreachable node cannot authorize replacement. The same
machine row retains the current creation authorization until safe rotation; no
allocation-history queue or second scheduler is added. Image changes publish a
new ordinary environment version through the same helper used by Run admission.
The prior immutable version remains readable. Workspace Volumes survive cold
replacement, but process memory and system-disk changes are not guaranteed.
Pause/resume keeps Cube's node-affine snapshot contract. Release still deletes
the machine's Workspace without deleting conversation history.

Elastic allocation records use `allocated` independently of current holders.
Borrowing/returning a ready VM no longer changes an active/warm PG field. Binding
and terminal reservations still serialize admission and protect explicit cleanup;
unreferenced resources and unfinished creation retain their cleanup rules.
Retained idle allocations have only Cube's finite deadline, never a competing
controller timeout. Observation-only health checks make no per-sample PG writes.

Deleting an environment/Workspace makes dependent Sessions require rebinding.
Existing messages remain readable. Rebinding is allowed after resource deletion
and only while no Run is active; a new Run freezes the new Workspace.
Rebinding can select an elastic Workspace or a running/paused development machine
owned by the conversation creator and authenticated actor. Machine/profile/cwd
binding commits together; pending machine release prevents admission. The dialog
reuses machine directory browsing and keeps retry identity separate from new-chat
selection. The next World State reports the different Workspace without assuming
`/workspace` or empty files. See [ADR-0202](adr/0202-development-machine-workspace-rebinding.md).
A trusted deletion coordinator and Cube Volume Controller remove actual bytes, including
root-owned files, before committing purge completion. There is no Kopia/S3
Workspace authority or platform-managed Git tree.

Preview is published by a trusted tool after an actual listening-service probe.
The Agent includes the returned platform path as a named answer link. Internal
port numbers stay in Tool details unless requested; the Web does not synthesize
another application action or inspect answers for missing links.
Authenticated isolated origins proxy HTTP/WebSocket traffic through the control plane's
credential-free guest relay. Each content request resolves current authorization,
Workspace and owner in one PG query; permission and cross-resource tunnel caches
are not used. There is no localhost replacement in model text or
fixed application-port reservation. Human Web Terminal and one-use SSH tickets
use independent product authority; they are not Agent execution commands.

## Models, Subagents and integrations

The [October 19 focused review](reports/model-request-response-review-20261019.md)
is repaired under [ADR-0263](adr/0263-model-response-and-work-lifetimes.md), with
[source and live evidence](reports/model-runtime-repair-20261020.md).
Schema 192 removes the whole-Run duration policy. Existing ownership revokes model
grants on closure, Stop, lease loss and Worker retirement; there is no fixed
capability TTL, refresh scheduler or per-model-request PG lookup. Network/Tool
and retirement bounds remain independent. Hosted completion is
an empty native text slot carrying PiCloud-owned metadata, replayed as the exact
provider item at the public payload hook. Gateway is transport-only. The Models
boundary owns phases, hosted content and semantic outcomes. Native Store/Kafka
commit and abort boundaries are unchanged, including exclusion of aborted/error
Assistant entries from later Pi model context. Worker retirement has a bounded
drain and closes late admission before entering existing same-Run recovery.

Known transient failures retain Pi's native retry classification; quota, billing,
configuration and cancellation outcomes remain distinct. Durable is the sole
sampling retry owner. Semantic execution and HTTP transport have separate metrics.

CLIProxyAPI owns upstream subscription/API credentials and account affinity.
Under [ADR-0267](adr/0267-scoped-releases-and-model-catalog.md), the Control Plane
loads one validated deployment model catalog. Chat/admin choices and defaults
come from its API. Run admission freezes capabilities and the catalog digest in
PG; Worker initialization/recovery and native children use that snapshot, with
no second Worker model-name catalog or per-request SQL. Invalid reloads retain
last valid configuration and expose failure. Model withdrawal affects new
admission while old desired selections and history remain readable. The initial
schema 196 / Worker contract requires a matched cutover; subsequent provider and
catalog changes use [scoped Helm publication](COMPONENT_RELEASE.md), retaining
unrelated component identities and original artifact provenance.
GPT-6.1 Sol is the new-conversation default; Luna remains the routine test model.
Schema 195 previously migrated mutable Sol selections without changing history.
Gateway discovery does not automatically publish a selectable model.
Workers see only scoped model-runtime access through their local Model Gateway.
Revocation also aborts incomplete request uploads. After body validation, the
Gateway atomically rechecks its local capability and reserves the request count
before contacting the provider. This adds no database query. Usage remains in
native Pi history; dormant billing tables and monetary budgets are removed.
Provider/model/reasoning/Fast settings are immutable per accepted Turn. Completed
hosted search items replay only to the issuing provider/API/model; canonical
display retains normalized actions and citations. A different model receives
ordinary portable message content without those provider-native carriers.
The selectable DeepSeek model is V4.1 Flash; V4 Pro is hidden. Flash declares
`web_search` on Responses at the owner's request, although the upstream currently
ignores it. Search activity still requires actual provider events/results;
a declaration alone is never recorded as a performed search (ADR-0191).
Chat uploads place files in Workspace through the existing control-plane/Volume Gateway
or fixed machine guest helper. PG stores bounded upload claims and accepted input
references. Source images are retained in the existing S3 store; the current Run's
Cube normalizes them before model admission. Pi receives ordinary user text and
ImageContent without an Agent read Tool call. Queue edits, steer and native replay
retain images independently of mutable Workspace files. See
[chat attachment contracts](CHAT_ATTACHMENTS.md) and ADR-0200. Generated-image
results are delivered under ADR-0274 as an explicit ordinary Tool.
`generate_image` uses Codex-shaped arguments and a separately configured Images
service through CLIProxyAPI. Recent-image references are bounded by the invoking
assistant entry in the current Conversation. File reads, normalization and
exclusive generated-file placement execute in Cube through bound image I/O.
Canonical image content retains the existing S3/Worker codec boundary; an
authenticated Session image route serves only objects retained by native history.
ADR-0275 adds `show_image` for explicit presentation of existing Workspace images.
Both image tools use one public image-content shape, derived from canonical
attachment parts after Worker Harness processing. Live display selectors reference
the same native commit; cold reconstruction uses the current public Session view.
The browser places image results after their producing Tool, outside collapsed
activity groups. Read remains model inspection. No Markdown scanning, extra event
store or new image-generation service is involved.
[Delivery](reports/show-image-delivery-20261025.md) verifies live/cold presentation,
retained display after source deletion and the matched publication.
Non-replayable ordinary effects confirm the existing Kafka dispatch commit before
execution. A recovered unfinished intent returns UNKNOWN without another remote
request, including when prior admission cannot be proved. Reply retries keep the
completed in-memory outcome and never regenerate an image. No operation ledger,
separate image scheduler or Skill loader is added. The matched release
`image-tool-0bac4e97` and real path/recent-image/browser acceptance are recorded in
[delivery evidence](reports/image-tool-delivery-20261025.md), separately from the
owner's unsuccessful original-reference attempt.

The native Durable Harness owns bounded sampling retries; Model Gateway forwards one
send per admitted request. Generated CLIProxyAPI settings disable extra retry
rounds while keeping its account selection/failover responsibility. Logical
model-request limits do not claim to count every provider-account attempt.
Successful Assistant responses reset sampling retry state before further queued
input is processed. Run-local cancellation interrupts backoff without revoking
the shared Session authority. Compaction threshold checks ignore usage retained
from before the latest Compaction and use Pi's structural estimate until a new
valid usage-bearing Entry follows that boundary (ADR-0193).

The role-free `subagent` direct delegation uses Pi's public replay-safe Task
contract. It recovers its original child/Submission through a current-owner
reference and fresh boot reply. `subagent_control` provides bounded discovery
and management; `workflow` keeps the existing `runs.run`/`runs.all` programming
model in Cube. Management and arbitrary scripts remain unsafe for automatic
replay. None use a CLI-emulation backend.
Fresh context and inherited context are independent of shared/ephemeral compute
selection and working directory. All active Lanes share one physical Session owner; Pi holds durable
parent/child input and cancellation state; PG retains product/resource associations. Recursive depth, descendant
count and Worker/per-Session model concurrency default to no product quota;
explicit finite policies still use fair admission. Children are not rejected
merely because another child is waiting (ADR-0215).
An ephemeral child uses a new lazy, bounded-warm Cube against the parent Volume.
Shared descendants inherit that compute scope. The native creation receipt freezes the scope
and cwd; explicit directories must exist. Elastic Volumes retain `/workspace` and
machine home Volumes retain `/home/user` in every Cube. A machine's system disk
is not exposed through this mode. The parent can create worktrees using Git,
then pass their paths; PiCloud neither copies Workspaces nor initializes,
commits or merges repositories. This is cooperative shared storage, not file
security isolation. See [ADR-0171](adr/0171-shared-volume-subagent-compute.md).

Blocking supervisor requests remain supported through the same control log.
Agent-input IDs identify native consumption, preventing a replayed notification
from duplicating model context. Task completion is distinct from a progress or
delivery receipt. This release uses foreground-owned tasks; `follow_up` queues
input on an active Agent, and a closed task reports a missed delivery rather
than silently spawning another one. Autonomous background wake is not implemented.

Optional GitLab Issue intake uses ordinary Run admission after the user chooses
an execution environment. The platform never clones or commits automatically.
Environment-local origin-scoped Git credentials belong to the Agent's Linux
environment, not the conversation database. Provider Webhook/project credentials
remain separate trusted integration secrets. No GitLab is required for ordinary
PiCloud deployment or local-account login.

GitLab's managed Issue comment is an eventually consistent view of PG claim/job
state. Atomic database triggers advance one `gitlab_issue_note_sync` target per
job when displayed state changes. A separate Control Plane loop claims only that
sync row in a short transaction, reads the committed latest state, then releases
the transaction before loading credentials or calling GitLab. Two local requests
are allowed in flight, independently of Issue-to-Run execution. A 60-second
PG-time lease/token fences local acknowledgements; the whole HTTP attempt is
bounded to 30 seconds and shutdown aborts it. Success acknowledges only the
captured version, so newer changes remain pending.

Sync rows contain identities/versions and bounded retry metadata, never comment
bodies or credentials. Lost replies are reconciled by note ID or the bounded
marker search. Transient failures back off per job from 2 to 60 seconds; persistent
failures retain a safe code and become due again after 15 minutes. Equal
desired/synced versions become eligible for verification after five minutes,
subject to backlog and the concurrency limit, so late older writes can be
repaired. GitLab does not enforce our local token: duplicates after ambiguous
creates and temporary remote regression remain possible. The database business
state stays authoritative. No Agent scheduler, Kafka event or new service is
added; see [ADR-0190](adr/0190-gitlab-issue-note-convergence.md).

## Authorities and scaling

Lifecycle authorization locks the PG controller identity before resource rows
and rechecks PG expiry before commit, after any resource-lock wait. External Cube
calls occur after the transaction. Recovered local handles/bindings become
available only after preparation and required PG writes succeed. A temporary
adoption failure or missing local handle is not VM-death evidence (ADR-0224).

Cube managed allocation/Volume state uses the existing Cube metadata. Placement
holds precede creation; deletion closes new attachment admission and reconciles
versioned node references independently of allocation reply retention. Pending
detach and missing/replaced node metadata prevent Volume deletion. PG keeps
product intent and Cube remains the physical/Workspace-byte authority (ADR-0226).
These lifecycle checks add no per-Tool PG lease lookup or operation ledger.

Template replica and rootfs artifact cleanup resolve the recorded stable Cube
node ID through the current node registry at dispatch. Historical Pod IPs are
observations, not cleanup targets. Multiple replica/job observations of one node
produce one request; an unresolved node retains cleanup metadata. Active-template
and shared-artifact pins remain enforced by Cube (ADR-0233).

| Concern | Authority |
| --- | --- |
| users, resources, Runs, leases and fences | PostgreSQL |
| publication scope and ordered closure | PG-issued metadata + execution log |
| not-yet-reclaimed output records | Kafka |
| semantic Session history and query projections | PostgreSQL |
| native active Lane context and browser tail | rebuildable Worker/Projector memory |
| Workspace bytes | persistent Cube Volume |
| guest processes/memory | the live Cube or a surviving native VM snapshot |
| model account credentials/selection | CLIProxyAPI |

Worker replicas add Session-family slots; Projector replicas divide Kafka partitions;
Tool executors and Cube nodes add execution capacity. Cross-owner result and SSE
routes remain explicit. No Cell, worker-affinity queue or second scheduler is
required. See [run lifecycle](RUN_LIFECYCLE.md), [crash contracts](STREAM_DURABILITY.md)
and [configuration](CONFIGURATION.md) for operational boundaries.

## Intentional coupling and unverified boundaries

The [October 3 repair](reports/review-repair-20261003.md) removes ordered-handler
waits on queue presentation, unrelated Lane-head transfers, and complete-original
image buffering on the Cube normalization path. Normalized native image content
and explicitly requested UI/history data still consume memory. These improvements
do not establish physical-node HA or unbounded aggregate capacity.

API and Projector share a process. PG or live-owner admission failure stalls its
Kafka partition, though guest execution does not; other partition handlers can
proceed. Active Lanes share one native writer/Worker, not arbitrary placement
across Workers. History outside the in-memory active branch still waits for PG
projection before reading. These are explicit tradeoffs, not independent-HA claims.
Proved pre-enqueue validation/capacity rejection restores the affected Lane view
without consuming native sequence or poisoning siblings. Lost ACK or failed
post-ACK apply still retires the whole writer. Cold readers share one monotonic
progress read, retaining independent cancellation and current-owner checks.
The PG budgets cover native/seal transactions, not pool acquisition, every API
query or external routing; a persistently failing record still blocks its partition.

Cubelet enforces boot identity, active-operation fingerprints and monotonic
partition admission. It owns accepted processes independently of Worker lifetime;
ADR-0221 delivers cancellation to unfinished Tools. Explicit Tool timeouts retain
native process/cgroup cleanup. This does not establish durable cross-boot
process/result recovery or exactly-once effects. PG failover, Cube node
drain and full multi-node HA remain
separate deployment acceptance work. The isolated duplicate SSE opening remains
unexplained; reproducing intentional stale-snapshot cancellation is not its fix.

Conversation deletion commits a quiescent, locked subtree deletion in one PG transaction,
including Run/Turn control history, its native physical Sessions and attachment/upload
references. `DELETE /v1/conversations/:sessionId` returns 204 after commit, including
an already absent tenant-scoped ID; no archive/restore receipt remains. Independent
native Forks, shared image references and Workspace/Volume bytes retain their own
lifetimes. Pruned logical views use `pruned_at` and do not consume usable-Session quota.
An empty PG notification wakes the existing control-plane cleanup scan after deletion.
Missing hints fall back to periodic scanning. Unreferenced elastic compute is
eligible immediately, while ordinary between-Turn warm reuse remains unchanged.
The provider confirms Cube absence before physical quota release; uncertain cleanup
stays in PG for retry. User-owned development machines keep their explicit lifecycle.

The public Session lifecycle matches atomic Run admission (ADR-0208): cold/idle
becomes running in the admitted Run transaction; completion/cancellation returns
to idle or quarantines the Session as failed. Recovery persists failed → idle only
when the existing PG guards confirm both Agent exit and native output seal. VM
startup/eviction is not a Session state; those resources retain their own lifecycle.

## Self-hosted deployment boundary

[ADR-0214](adr/0214-unified-self-hosted-k3s.md) unifies the one-host runtime in
K3s. Native selector-backed Services own endpoint changes; clients retain their
reconnect/deadline behavior. PostgreSQL/Kafka/S3 and provider infrastructure deploy
before the platform migration Job. Retained local PVs replace Docker-owned data
volumes; Cube remains the sole Workspace byte authority. Worker boot state uses
retained claims. Docker is a build/import dependency, not a runtime discovery
source. No domain lease, Kafka writer, Tool authority or Pi loop changes.
The single-node profile shares `cube-system` with Cube and does not imply HA.

# Documentation map

The [October 6 post-Durable whole-repository review](reports/repository-review-20261006.md)
audits `aace21a8` across all 22 workspaces, native Pi, Cube, product and delivery
boundaries. It records five findings, three measured optimization opportunities
and two failing delivery checks, with isolated reproductions and live Luna acceptance. Fixes remain in BACKLOG;
this review does not change the deployed runtime.

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

[ADR-0221](adr/0221-pi-tool-cancellation.md) implements Pi-style Tool cancellation:
ordered operation interruption, original-result settlement and bounded UNKNOWN
outcomes. [Verification and matched release](reports/pi-tool-cancellation-20261004.md)
include normal and unavailable-executor Luna/Cube acceptance.
[ADR-0222](adr/0222-paused-inputs-after-stop.md) adds durable queue pause on Stop,
independent fresh input and explicit continuation.
[Verification and rollout](reports/paused-inputs-20261004.md) cover native input
consumption, real Luna/browser behavior and Worker replacement.
The earlier [detach-only acceptance](reports/agent-stop-correction-20261004.md)
records ADR-0220's superseded behavior at its named revision.

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

# Documentation map

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

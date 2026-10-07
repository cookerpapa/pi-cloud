# October 7 whole-repository review

Reviewed revision: `7a5fc6034a55d9fda98a25c8015112327ed2bfc4`, branch
`migrate/pi-durable-1.0`. This is a review and characterization record; the
findings below are not implemented repairs.
The subsequent [approved source repair](review-repair-20261007.md) implements the
findings below. Their original characterization evidence is retained here.

The review covers the eight agreed areas: resource identity/address discovery,
native Pi alignment, execution/recovery, resource lifecycle, SQL/read paths,
product flows, delivery, and component cohesion/documentation. The inventory has
1,616 tracked files and 22 workspaces. Maintained source and contracts were
examined by complete data flows and ownership boundaries. Historical migrations,
ADRs and earlier reports were used as design evidence, not inferred as active
components. Relevant earlier owner discussions were consulted privately; no
session transcript is included in this report.

## Findings

### R07-01 — P1: retrying an ordinary send after losing its response admits another Run

**Example.** A user sends “run the project test once”. The API commits the Turn,
but the response is lost. The composer retains the draft and permits another
click. The second click generates a fresh key, so the API accepts another Turn
and Run. This can repeat model work and external Tool effects.

`packages/web-ui/src/ChatApp.tsx:1254` calls `newIdempotencyKey("turn")` inside
each submission. The catch path preserves the draft but not its request identity.
`packages/control-plane/src/control-plane-store.ts:1497` and `:1828` correctly
replay by the committed Session/idempotency-key pair; text equality is not an
idempotency contract. The Steer path already retains a fingerprint/key across
an uncertain response and illustrates the missing ordinary-send behavior.

**Evidence.** The actual ChatApp and PiCloudApi ran in an isolated browser fixture.
The fixture recorded the first admission before failing its response. Retrying
the unchanged draft produced two distinct keys and two fixture admissions.
Backend source independently establishes why those keys are separate admissions.
This was not a paid or production Run.

**Repair slice.** Retain the complete ordinary-submission identity, including
Session, text and attachment identities, while its outcome is uncertain. Retry
that immutable request with the same key; clear it after confirmation or an
explicitly different submission. Cover both existing conversations and the
first-message flow. Do not deduplicate by prompt text, which would prevent
intentional identical messages.

**Acceptance.** Lost ACK + unchanged retry yields one accepted Run; changing the
draft creates a new submission; an ACK does not erase edits made while waiting;
attachment retries retain the same accepted input.

### Q07-01 — P1 for delivery: reusable guest identity conflicts with release provenance checks

`scripts/register-cubesandbox-tool-template.mjs:388` legitimately reuses READY
templates when their guest build-input identity is unchanged. Meanwhile,
`scripts/generate-release-evidence.mjs:206` requires every inspected image's OCI
source revision to equal current Git HEAD. The guest descriptor at `:287` uses
the reusable content-identity tag but still passes HEAD as the expected revision.

**Example.** Change only the Control Plane or documentation, then release. The
guest has identical build inputs and is reused with its original OCI revision.
Release evidence rejects it, even though its digest and guest identity are the
ones the registrar intentionally preserved.

**Evidence.** At the reviewed HEAD, guest identity
`1f7649a81c99c671770d3ef2bc09480dadd93847` matches the registered templates. Its
OCI source revision is `18defa3ec16fa6f5fa395bc931239c1602e59a32`. Invoking the
actual image inspection function against that image and HEAD `7a5fc603…` rejects
the OCI revision. The full release pipeline was not rerun or deployed during
this review.

**Repair slice.** Represent release revision, guest build-input identity, image
digest and original image source revision separately. Verify that the original
guest source has the required build inputs and record its provenance. Do not
overwrite an immutable guest tag merely to make a label equal HEAD, and do not
drop source/digest verification.

**Acceptance.** An application-only release can reuse the exact guest digest and
produce valid evidence; a changed guest input cannot reuse it; provenance still
identifies the commit that actually built each artifact.

### O07-01 — measured concurrency limitation: an upload excludes all Gateway access to its Volume

`packages/sandbox-control/src/persistent-volume-workspace-volume-gateway.ts:388`
holds the Volume's exclusive filesystem lock while consuming the upload stream.
Directory reads (`:329`), file reads (`:427`) and credential operations use that
same lock. The default wait in
`filesystem-workspace-volume-gateway-lock.ts` is 30 seconds.

**Example.** While a large upload is arriving slowly, another browser tab tries
to inspect an unrelated directory in the same Workspace. Its read waits behind
the entire transfer and can return `workspace_volume_lock_unavailable`.

**Evidence.** Two actual Gateway objects shared a real Volume fixture and flock.
A two-chunk stream was suspended between chunks. A concurrent directory read
exhausted a deliberately short 100 ms test wait; after upload completion, the
same read succeeded. The small payload isolates lock duration from file size.
This establishes contention, not a production throughput or 30-second measurement.

**Design to discuss.** ADR-0231's filesystem exclusion solved a real correctness
problem and must remain. Evaluate a shared admission lock for ordinary reads and
staged transfers, with narrow destination/credential serialization and exclusive
initialization/deletion. Specify lock order, process-loss behavior, inode
replacement and deletion exclusion before changing it. Removing the lock or
moving an unsafe critical section outside it is not the proposed repair.

### O07-02 — measured query amplification: list pagination occurs after counting all matching history

`packages/control-plane/src/conversation-reader.ts:95–165` joins visible Turns,
groups every matching Session, sorts those aggregates, then limits to 101 rows.
The returned page is bounded; the work required to produce it is not bounded by
that page.

**Evidence.** An isolated database copied the current table definitions and
indexes, with 5,000 Sessions and 40 completed Turns per Session. The actual reader
query scanned 200,000 Turns and aggregated 5,000 Sessions for a 101-row SQL page.
Three runs took 144–179 ms. A page-first/lateral-count candidate returned the same
rows, counted 4,040 Turns through the existing Session index, and took 4.6–5.3 ms.
The candidate still sorted 5,000 Session headers; it does not eliminate that
remaining work. These are local fixture measurements, not API latency or fleet
capacity claims. Machine-readable plans are in the accompanying JSON.

**Repair slice.** Select the ordered, tenant-filtered Session page first, then
count visible Turns for that page. Consider an index matching the visible
Session cursor/order. No new count authority, projection table or Kafka topic is
required. Preserve cursor precision, deleted-Workspace display, Turn visibility
and delegated-session summaries.

**Acceptance.** Existing cursor/visibility results stay identical; query plans
avoid aggregating every Session's Turn history before the page limit. Test deep
pages and uneven history lengths in addition to this uniform fixture.

### N07-01 — P3: one Stop comment still describes the superseded result-wait policy

`packages/runtime-core/src/session-projector.ts:100` says that Stop already waits
for the original Tool result under ADR-0221. Current ADR-0229, the maintained
architecture and runtime behavior use native Durable abort settlement and discard
late physical results. This is a misleading implementation comment, not evidence
that the old cancellation mechanism still runs. Update the comment in a repair
slice; preserve the current behavior. README's current cancellation explanation
is accurate and requires no topology rewrite.

## Architecture assessment

The principal boundaries are defensible: native Pi owns Harness/Task progress;
PG owns cloud admission and lifecycle; one physical Session writer publishes
through fenced ingress; Kafka orders accepted facts; Projector materializes
history and routes admitted effects; Cube owns accepted physical Tool lifetimes;
the persistent Volume owns Workspace bytes. This review found no reason to add
another broker, workflow scheduler, operation ledger, or transcript authority.

The separation is implemented, not just documented. The current RF3 integration
fixture observes zero SQL queries for ordinary ingress append, 100 hot binding
lookups with zero SQL queries, and zero idle SQL queries in ordered Subagent
views. PG checks at admission, closure, recovery and destructive lifecycle
operations still serve different purposes and should not be removed as if they
were redundant lookups. Auth revocation and external-effect admission cannot be
made dependent solely on a delayed Kafka event.

Three engineering tradeoffs remain worth explicit discussion:

1. **A partition remains a failure/latency boundary shared by Sessions.**
   `KafkaLogConsumer.#batch` awaits each handler; Tool routing awaits the bounded
   Cube handoff/cancellation request. A slow target or stalled canonical write
   can therefore hold unrelated Sessions in that partition. Other partitions
   continue. This is visible in source, not a new live outage measurement. First
   measure per-stage duration and partition lag under one slow target. Moving
   dispatch to a per-Session pump would require a design for ownership loss,
   ordered cancellation and commit-before-effect; simply launching untracked
   promises would weaken those guarantees. Retain the single Projector group.
2. **Cube is a maintained execution integration with a real upgrade cost.**
   The manifest pins six patches, including execution handoff/completion,
   boot/position fencing, recoverable allocation and Volume reference recovery.
   It is no longer adequately described as a Node wrapper around Bash. Current
   declarative Helm rendering and pinned contract tests are useful improvements.
   Keep the native patches and the trusted completion adapter behind the existing
   ports; distinguish native-runtime, completion-adapter and guest artifact
   identities. Evaluate any future upstream adoption against these actual
   contracts before replacing or expanding the integration.
3. **Cohesion is weaker inside lifecycle/UI implementations than across services.**
   SandboxController is 3,536 lines, its state repository 2,116, the Cube provider
   2,254, and ChatApp 2,377 at this revision. Size alone is not a defect, but the
   inspected methods combine elastic/development/terminal lifecycle and resource
   recovery, or navigation/composer/upload/queue state. R07-01 is a concrete
   example of two submission paths implementing request identity differently.
   Extract shared submission handling and bounded lifecycle responsibilities as
   part of repairs, keeping transactions and authority in their current owners.
   A new service or framework is not warranted merely to split these files.

The best next work is R07-01 and Q07-01, followed by O07-02. O07-01 needs the lock
contract agreed first. Partition dispatch redesign and further Cube changes need
measurements and an ADR if adopted; this review does not authorize them as fixes.

## Native Pi alignment and rejected hypotheses

- Inspected the installed pinned `@earendil-works/pi-durable`, `pi-ai` and Chord
  **1.0.0** implementation. The old local Pi checkout was used only as historical
  context, not as the current runtime contract.
- Native scheduler startup is disabled until explicit submit/resume; cloud model
  grants are rebound before recovery. No confirmed premature ungranted model
  request was found. Existing Compaction recovery/event/Storage contracts are
  included in the maintained test suite.
- Remote Tools retain Pi validation and native execution-intent persistence;
  cloud hooks add ordered handoff and cancellation. Tool draft suppression is an
  explicit Models-port policy under ADR-0230, not an Agent-loop patch.
- Conversations retain per-Lane task identities under the physical Session
  owner. Old reply callbacks are boot-local; new owners do not recover arbitrary
  shell work by replaying it. Native abort settlement and unconsumed queue return
  follow the accepted ADR-0229 behavior. Automatic background Compaction outside
  a cloud admission and user-loaded extensions remain documented product limits.
- The apparent remote `childAnchor()` call inside child-admission SQL is not the
  production path: Worker freezes the anchor before publishing; Control Plane
  requires it and only creates the native child outside its admission transaction.
- No current template artifact-download Pod-IP defect was reproduced. Live
  `master_node_ip` uses the stable CubeMaster Service address. A historical-IP-first
  helper remains in upstream explicit `kind=snapshot` reconciliation, but this
  catalog has four `kind=template` entries and no snapshot entries. It is a dormant
  integration risk if that feature is adopted, not a confirmed current product bug.
- Missing probes do not prove VM absence. Physical cleanup and quota release
  retain the recorded node/allocation evidence; ordinary Tool failure does not
  authorize whole-VM deletion. The two existing UNKNOWN runtime records were
  neither modified nor reclassified.
- GitLab note reconciliation performs network calls outside its claim/settlement
  transactions. Historical references to holding a GitLab row lock across the
  network are not the current implementation.

## Coverage

| Workspace or boundary | Review focus |
| --- | --- |
| control-plane | Admission/idempotency, queue/Stop/reconciliation, conversation history/tree/delete, uploads, auth, preview and source-control coordination |
| runtime-core | Session ingress, seals, Run/lease lifecycle, canonical projection, dispatch commits, live views and retention |
| event-log | Transactional publisher, assignment/recovery, monotonic dispatch offsets, boot-scoped replies and cancellation |
| sandbox-supervisor | Native Harness/Models/remote Tools, events, input delivery, model failure and Compaction recovery |
| supervisor-host | Worker claims/capacity, model permits/gateway, management/recovery composition and trusted orchestration |
| pi-session-postgres | Public Storage adapter, native commit/index ownership, document materialization, cold reads, Fork and idle administrative writes |
| subagent-control | Parent authority, child preparation, stable context anchor, messaging/wait/cancellation and ordered views |
| sandbox-control | Bindings, Tool dispatch, runtime observations, allocation/retirement, persistent capsules, Gateway exclusion and Volume deletion |
| tool-sandbox | Guest execution/input, native file Tools, Bash/process boundaries, image normalization and output budgets |
| workspace-runtime | Seed/byte integrity, upload staging/finalization and ownership of Workspace bytes |
| session-attachments | Image references, S3/PG retention, canonical reachability and reaping |
| cube-completion | Final reply validation, image claim checks, progress separation and bounded framing |
| cube-api-authorizer | Private fixed endpoint/identity boundary and allow/deny behavior |
| cube-egress-gateway | Configuration refresh, HTTP/CONNECT, destination policy and connection lifetime |
| provider-egress-relay | Provider host routing, upstream proxy, connection lifecycle and redacted audit |
| ssh-gateway | Ticket scope/consumption, terminal channel, backpressure and disconnect cleanup |
| database | Current schema/indexes, prepared statements, transaction retry boundaries and optional notification wakeups |
| domain | Run/Turn/Session state transitions, model snapshot and resource-limit semantics |
| protocol | Public/private schema boundaries, native intent transport, control references, position/identity and size budgets |
| observability | Stage metrics, trace/audit payload policy and disposable health evidence |
| web-ui | Actual send retry, Steer/queue return, uploads, Session view/SSE, navigation, terminal and rendering contracts |
| fake-model-server | Test-only provider role, deterministic streaming/failure fixtures and separation from release claims |
| Cube/deploy/scripts | Exact pinned upstream plus six patches, stable node routes, allocation/execution/Volume boundaries, Helm render, clean-install gates, build identities and release inspection |
| docs/history | Current README/architecture/ADRs/backlog, migration/repair/release evidence and historical rationale |

## Verification and limits

Newly executed checks at this source revision:

- `npm run check`: all 22 workspaces typecheck; 1,612 workspace tests and 43
  acceptance-helper tests pass. The default run skips nine opt-in tests.
- `npm run test:transport`: seven RF3/PG tests pass in six files, covering seven
  of those default skips. The two live KVM Provider cases were not rerun.
- Installation contract/shell syntax, Helm rendering and distributed preflight,
  runtime time/retention budgets, Worker image closure, Docker build-context
  exclusion and documentation checks pass.
- The four review reproductions ran successfully, including the real-browser
  lost-ACK case and the actual guest image inspector. The portable SQL repeat
  again returned identical rows: 101–127 ms for the current query and 3.4–3.7 ms
  for the candidate. Query-plan work, rather than timing stability, supports O07-02.

The [machine-readable record](repository-review-20261007.json) contains baseline,
probe results, SQL plans and the final verification summary. Portable
[reproduction commands](../../scripts/experiments/review-20261007/README.md) use
owned local browser/filesystem/PG fixtures; the guest probe only inspects an
existing image. No new model calls, production fault injection or deployment
were performed in this review.

The initial read-only deployment baseline was schema 181, Cube Helm revision 50,
PiCloud 25 and infrastructure 24, two Workers, 32 Session partitions, four READY
templates, no Sessions/Runs/unsealed Runs, and runtime states released=86,
unknown=2. Current source and running application images are distinguished: the
application release is `review-release-18defa3e`, while Cube native images include
the subsequent `template-cleanup-59f3db87` fix.

The prior [matched release](review-release-20261006.md) supplies live Luna/Cube,
Fork, five Subagent scenarios, uploads and cold-Worker image recovery evidence.
The [template repair](template-cleanup-20261007.md) supplies the exact current
native cleanup contracts and rollout evidence, including actual old-template
removal. Those earlier results are not claimed as newly executed here.

This is a source/contract review with bounded reproductions, not proof of
multi-node availability or arbitrary external-effect exactly-once execution.
The full image vulnerability scan, bare-host install and long-duration physical
multi-node failure tests were not repeated. Their absence does not turn the
recorded local measurements into production scale guarantees.

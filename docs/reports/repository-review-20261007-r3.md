# October 7 recovery and boundary review

Reviewed revision: `1e7e21eb170bff0f0699f156bdd6755c59305eb4` on
`migrate/pi-durable-1.0`. The working tree was initially clean. Application/native
images remain `review-release-ad2bdd97`, with deployment/acceptance follow-up
`8f648019`, schema 182 and guest/Tool Worker/managed protocols 4/3/7. Pi Durable,
Pi AI and Chord remain pinned to 1.0.0.

The review covers the eight agreed areas, the current boundaries of all **22
workspaces**, and the tracked **1,667-file** inventory including deployment,
native patches, tests and maintained documentation. Historical migrations and
reports were consulted where they explain current invariants; this is not a
claim that every historical line was re-audited. Private owner discussions were
consulted for cancellation and lifecycle intent and are not reproduced here.

There are **four confirmed defects: one P1 and three P2**, one measured SQL
optimization and one upstream retry-classification limitation. Product source,
dependency pins, deployment configuration and installed images were not changed.
[Machine-readable evidence](repository-review-20261007-r3.json) and
[portable characterizations](../../scripts/experiments/review-20261007-r3/README.md)
record the observations.

## Confirmed findings

### R07R3-01 — P1: a withdrawn queued input can permanently block Session recovery

**Example.** A is executing and B is queued. Stop withdraws B for return to the
composer. A's cancellation initially fails to confirm cleanup, so the Session
becomes `failed`. The system later positively confirms A's Agent exit and projects
its output seal. The Session nevertheless remains `failed`, and another user
message receives `conflict`.

`packages/runtime-core/src/quarantined-session-recovery.ts:33` rejects recovery
when any later mailbox Run has a state other than `queued`. B is now `cancelled`,
even though it has never acquired a lease or started. The recovery predicate
mistakes a cancelled input record for a later execution. The withdrawal itself,
`packages/control-plane/src/stopped-inputs.ts:19`, correctly preserves that record
for queue-return/idempotency purposes.

**Evidence.** The isolated PostgreSQL probe uses the actual admission,
`RunCancellationExecutor`, `RunExecutor`, seal projection and new-input API code;
only the Worker/initial cancellation failure is controlled. In both exit-first
and seal-first orderings, the control case without B becomes `idle` and accepts
new input. With B, A has both proofs but the Session remains `failed`; B has
`lease_id = null`, `started_at = null`, and `stop_reason = queued_input_withdrawn`.
This demonstrates availability loss, not lost history or duplicated shell effects.
The existing suite separately covers cancellation recovery and Stop queue return,
but missed their composition.

**Repair direction.** Define the recovery guard in terms of the latest actual
execution/admission, using existing Run fields. Unstarted withdrawn/cancelled
inputs must not supersede its exit/seal proof. Preserve the tenant, exact lease,
active-Run and unsealed-output checks. Do not delete the queue-return rows to make
recovery succeed and do not infer Agent exit from lease expiry.

**Acceptance.** Cover both proof orders with withdrawn inputs, individual queue
cancellation, retained attachments and new input after closure. A genuinely later
admitted execution must still reject an earlier Run's exit proof; missing exit or
seal must still keep the Session unavailable.

### R07R3-02 — P2: resending a returned input can replay its cancelled admission

**Example.** While A is running, X is accepted into the queue but its HTTP reply
is lost. The user clears the still-visible X draft. Stop withdraws X, and the
browser restores it to the composer. Sending that unchanged returned text reuses
X's old unresolved idempotency key. The server correctly replays the original
admission, whose Run is already cancelled; the composer clears without admitting
new work.

`packages/web-ui/src/composer-submission.ts:20` retains the unresolved identity
until another successful/different submission or explicit reset.
`ChatApp.tsx:2240` restores returned text/attachments and advances the draft
revision, but does not relate that restored input to the old submission identity.
The Stop handler at `ChatApp.tsx:1281` does not establish that relationship either.
The server intentionally retains accepted identity when queue input is withdrawn;
this is not a server deduplication defect.

**Evidence.** The actual `ComposerSubmission`, `PiCloudApi` request/response
validation and `restoreReturnedInputs` run against a controlled admission store
which commits before dropping the first reply. The two requests have **one key
and one admitted Run**; the second valid acceptance DTO is a replay, while the
underlying Run remains cancelled. Ending that original intent in the control
case yields two keys and a new queued Run. ChatApp's callback/reset wiring was
checked in source. This is a composed client/API characterization, not a claim
of a new production browser Stop fault injection.

**Repair direction.** Correlate returned input with its existing accepted request
identity and end only the matching stopped intent. Preserve newer post-Stop
submissions and late-ACK protection. Do not deduplicate by text or blindly reset
all pending submissions whenever a return arrives. If the returned-input DTO needs
the original acceptance key/receipt identity, use the existing Run record and
record the public contract change before implementation; no new receipt store
or execution authority is needed.

**Acceptance.** Add a real ChatApp loss → clear draft → Stop → return → resend
case, including images. Verify one newly admitted Run, unchanged uncertain retry
deduplication, and a newer submission arriving while an older return is pending.

### R07R3-03 — P2: Read loses the file content of an oversized first line

**Example.** An Agent reads a minified JavaScript bundle or a one-line JSON file.
Pinned Pi Durable returns the initial bounded text plus a truncation diagnostic.
PiCloud returns only a warning, forcing another Bash request to see any bytes.

`packages/tool-sandbox/src/native-tools.ts:173` substitutes the entire result
with a warning when `readWorkspaceFileRange` reports `firstLineBytes`. The current
upstream `pi-durable/dist/tools/read.js` instead retains a UTF-8-safe prefix and
returns continuation guidance as diagnostics. The cloud implementation retains
older read behavior; the existing parity cases cover ordinary lines, BOM/CRLF and
empty files, but do not cover this boundary.

**Evidence.** Both implementations read the same owned 120,017-byte single-line
file. Pi returns **51,200 bytes of actual content** including its unique prefix.
PiCloud returns **102 bytes of warning, zero file content**, with `isError=false`.
No model choice, Kafka behavior or image conversion is involved in the difference.

**Repair direction.** Keep bounded reading at the data source while aligning the
text prefix and truncation/continuation contract with Pi 1.0. Preserve diagnostics
through the fixed guest/Harness boundary so subsequent native output bounding
does not discard guidance. Do not restore an older Pi implementation or add a
second selectable read mode. Any guest wire change needs an ADR and matched
protocol/artifact rollout.

**Acceptance.** Compare actual native/cloud output for oversized ASCII and
multibyte lines, offsets, line limits, BOM/CRLF and image reads. Verify the final
Harness model result, not only the unprocessed guest reply.

### R07R3-04 — P2: the shipped CubeMaster image logs database passwords at startup

The pinned Cube source contains a full configuration dump in
`CubeMaster/pkg/base/config/config.go:725`:
`fmt.Printf("cfg:%+v\n", utils.InterfaceToString(cfg))`. The serializer includes
`DBConfig.Pwd`; validation/reload error paths also format the raw configuration.
PiCloud's structured-log redactor cannot intercept this upstream stdout path.
The source pin and applied patches are owned by
`deploy/cubesandbox/runtime-build.json`.

**Evidence.** A disposable container using the exact deployed
`pi-cloud/cube-master:review-release-ad2bdd97` image, with networking disabled and
credential fields replaced by a synthetic password, prints that password during
configuration initialization. The fixture is removed afterward. Real credentials
and raw startup configuration are not included in the report. The current Pod's
available stdout no longer contained its startup dump, so that absence was not
used as evidence that the image is safe.

**Repair direction.** Remove full configuration serialization at the pinned
native boundary and retain bounded, nonsecret startup/error diagnostics. Cover
both successful initialization and invalid/reloaded configuration paths. This is
a logging repair, not a new authentication system or a change to Tool authority.

**Acceptance.** Synthetic database/Redis/auth canaries must never appear in the
actual image's startup or error output; nonsecret version and startup failures
must remain diagnosable.

## Measured optimization

### O07R3-01: complete local document state still performs cold PG reads

`packages/pi-session-postgres/src/durable/published-storage.ts:486` calls
`projection.revisions()` for a rewindable document even when its acknowledged
local overlay already contains the complete base and every required delta.

An isolated real-PG probe holds projection at sequence zero, acknowledges 21
fixture publication batches and reads the resulting document 20 times. It
observes **20 revision SQL queries**, all returning no needed cold state. Values
remain correct. Injecting a projection-read failure also fails the next read,
despite the complete local document being present.

Prefer the complete local base/suffix when it covers the requested point; retain
PG reads for genuinely missing bases or historical points. Verify native versions,
`deltasSinceBase`, checkpoint merging and eviction using upstream conformance.
Measure CPU/materialization cost alongside query reduction for long delta tails.
This does not remove PG lease authority or establish PG-independent Agent execution.
No latency improvement is claimed from this characterization.

Existing transport measurements also remain favorable: the new RF3 integration
run records **zero hot publication SQL**, **zero SQL for 100 hot Tool-route reads**
and zero idle Subagent-view SQL. The next useful reduction is local to Storage;
adding another cache service is unnecessary for that case.

## Upstream and verification observations

The additional whole-production acceptance which was interrupted by model-proxy
HTTP 500 during deployment now **passes without product changes**. Seven owned
Runs make 21 GPT-6 Luna requests. Pure chat allocates no VM; coding/preview and a
background process survive cross-Run reuse. After confirmed allocation closure
and exact PG lifecycle reconciliation, a fresh VM attaches the same Volume and
verifies the 1,024-file fixture. Final-conversation deletion and physical cleanup
also pass. [Live evidence](repository-review-live-20261007-r3.json).

The older 500 responses' causes are still unknown. A separate intercepted-fetch
probe of pinned Pi's Codex adapter shows a narrower limitation: it drops the HTTP
status when choosing a JSON error message, and native retry classification then
matches that text. HTTP 500 with `Request could not be completed` is classified
non-retryable, while the same status with `Internal server error` is retryable.
This is reproducible upstream behavior, not evidence that PiCloud disabled native
retry and not proof of the earlier production error body's contents. Record it
for a bounded provider-adapter/upstream discussion; do not introduce a competing
retry loop or replay external effects.

The maintained production gate was run through a temporary failure-diagnostics
wrapper with unchanged assertions and runtime inputs. No failure-only branch was
needed in the successful run. The wrapper and owned resources were removed.

## Architecture assessment

The current division remains coherent: Pi owns native scheduling/context/task
recovery; PG owns admission and resource intent; Kafka owns ordered acknowledged
publication; Projector materializes history/views and dispatches effects; Cube
owns physical execution and Workspace bytes. The confirmed recovery defect is a
predicate mixing input records with execution history, not a reason to replace
these authorities. Current native cancellation, unsafe Tool recovery and atomic
intent/dispatch boundaries remain worth preserving.

The critical review identifies three continuing design costs:

1. **Partition dispatch couples unrelated Sessions assigned to that partition.**
   The repaired cross-partition guards and zero-SQL routing are useful, but a
   slow bounded Cube takeover still holds its ordered handler. Separate measured
   takeover time, native offset callback time and guest execution before proposing
   scheduling changes. Moving handoff to an untracked queue would reintroduce a
   crash boundary and is not an approved optimization.
2. **Cube is a maintained native extension boundary.** The six pinned patches
   cover creation/closure, node observation, Volume references, execution and
   completion delivery. They are more than Node forwarding. Current declarations
   and mount checks improve releases, while the startup-log finding shows why
   actual-image contract checks remain necessary. Upstreaming/narrowing this
   boundary deserves its existing backlog item.
3. **Internal cohesion can improve within existing processes.**
   `SandboxController` coordinates binding admission, VM/terminal lifecycle,
   recovery and observation; `ChatApp` coordinates several asynchronous product
   flows. Separate responsibilities through existing owned ports and measured
   lifetimes when changing those areas. File length alone does not justify new
   services, databases or a replacement scheduler.

Cache policy should follow authority: installed routing and disposable queue
views can avoid repeated reads, while admission, closure, attachment reachability
and physical deletion still need their current durable checks. The review does
not recommend turning every PG read into an eventually consistent memory lookup.

## Cleanup candidates

- `packages/sandbox-supervisor/src/model-stream-error.ts` is an unreferenced
  six-line classifier describing Pi 0.84. Repository-wide references find only
  its own declaration; it is not exported from the package. Remove it in the
  repair slice instead of reviving another retry policy.
- README contains overlapping historical deployment narratives. Keep one current
  topology/release pointer there and retain version-specific evidence through
  the documentation index/Git. This is documentation simplification, not removal
  of the architecture's recorded rationale.

These candidates were recorded, not removed during review. Native upstream
argument normalization is not PiCloud compatibility code and should not be
removed merely because it accepts older model-generated argument shapes.

## Coverage and verification

| Workspace | Reviewed boundary and verification |
| --- | --- |
| control-plane | Admission/queue return, canonical discovery/navigation, uploads, preview, tenant/source-control boundaries; PG and browser suites; real coding/preview |
| cube-api-authorizer | Fixed management-operation allowlist, private credential comparison and allocation/observation endpoints; package contracts |
| cube-completion | Guest identity, image externalization, typed UNKNOWN/not-started mapping and observation-only progress; adapter tests |
| cube-egress-gateway | Configuration polling, enabled-state behavior, public/private target policy and tunnel lifetime; package tests |
| database | Current Run/queue/native indexes, PG-time and transaction/notification contracts; historical migrations consulted for current fields; real PG suites |
| domain | Current state transitions and unlimited/finite policy representation; state-machine tests |
| event-log | Per-partition commit guards, callback serialization, rebalance/recovery and reply transport; RF3 integration |
| fake-model-server | Owned deterministic provider/stream fixtures, cancellation and bounded responses; package tests |
| observability | Payload-free phase/timing metrics, structured redaction and native logging boundary; logger/trace tests and actual-image canary |
| pi-session-postgres | ACK visibility, cold/overlay reads, document checkpoints, lease observation and native Storage contract; conformance and new SQL probe |
| protocol | Public/internal/guest schemas, current protocol pins, native intent expansion, input/output bounds and identities; schema suites |
| provider-egress-relay | Host/bridge tunnel lifetimes, upstream forwarding and private-route separation; relay tests |
| runtime-core | Admission/lease/exit/seal composition, Projector control views, Outbox and retention; new four-case recovery probe, RF3 and fault suites |
| sandbox-control | Allocation adoption/closure, shared VM boundaries, health evidence, upload/Volume locks and routing; controller/lifecycle suites and live cold restore |
| sandbox-supervisor | Public Durable Models/Storage/Tools hooks, abort/unsafe recovery, complete-call filtering, request identity and native parity; contract/fault suites |
| session-attachments | PG reachability, immutable S3 bytes, streaming checks, decoded-reference scope and cleanup; codec/storage tests |
| ssh-gateway | Ticket consumption time, tenant/machine scope and terminal/channel lifetime; gateway tests |
| subagent-control | Parent/child admission, frozen context/compute, communication and scoped views; package tests and RF3 Subagent acceptance |
| supervisor-host | Worker claims/family permits, model capability lifetime, request forwarding, retirement and boot evidence; Worker/model-gateway tests |
| tool-sandbox | Fixed file/Bash behavior, truncation, image geometry, process groups and guest replies; native comparison and package/fault tests |
| web-ui | Composer identities, queued/returned inputs, attachments, reconnect/snapshot, navigation, terminals and resource selection; browser and reducer tests |
| workspace-runtime | Streaming publication, flock ownership, staging/registry discovery and crash cleanup; process-loss fault cases |

Cross-cutting coverage includes the pinned Cube allocation/execution/Volume code,
all six patch identities, Helm rendering/preflight, image/source provenance,
installer/time-budget contracts and maintained documentation. Package tests for
SSH/code-host integration are not a claim of a new external GitLab deployment or
physical multi-node acceptance.

New verification: **22 workspaces typecheck; 1,649 workspace tests + 45 helper
tests; 217/217 deterministic fault cases; 7/7 RF3/PG integration tests; browser,
Helm and runtime-policy checks; npm security audit with no remaining findings.**
The fault suite's measured elapsed time is not a production recovery SLO.
Review-specific characterizations intentionally expose the defects above; their
successful execution must not be mistaken for repaired product behavior.

The owned live tenant, three Workspaces, their VM/Volume resources and associated
metadata were removed after confirmed physical cleanup. Original accounts/model
profiles remain, and no service restart, Kafka reset or deployment was performed.
Single-host acceptance still does not prove independent-node HA, fleet capacity,
or the root cause of the historical post-host-reboot `SetGuestDateTime` failure.

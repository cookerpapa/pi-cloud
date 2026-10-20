# Resource and interaction repair delivery

Status: implementation in progress, 2026-10-20. Not yet deployed.
The owner approved the [six-slice plan](resource-interaction-repair-plan-20261020.md).
The last verified serving release remains `model-runtime-058925bb`, schema 192.

| Slice | Source and verification | Live acceptance |
| --- | --- | --- |
| 1 — Live compute ownership/admission | Implemented; nine real-PG regressions, 95 existing tests and both affected typechecks pass | Pending matched release |
| 2 — Supervisor/workflow lifetimes | Implemented; 31 distinct targeted cases and both affected typechecks pass | Pending matched release |
| 3 — Delegation recovery/discovery | Implemented; native recovery, PG catalog/supervision and RF3 replacement cases pass | Pending matched release |
| 4 — Unknown Volume references | Implemented; native race and full allocation/Master/service contracts pass | Pending matched KVM acceptance |
| 5 — Attachment lifetimes | Implemented; native/PG pin, upload/streaming/cancellation and S3 transport cases pass | Pending matched S3/Cube acceptance |
| 6 — Terminal/preview lifetimes | Implemented; terminal/HTTP/WS/relay lifetime regressions pass | Pending compatible-replacement acceptance |

## Slice 1

Orphan retirement includes native child compute under the root Session authority
and terminal holders under their controller authority. It selects bounded hints,
locks the corresponding Workspaces, then rechecks users in a fresh PG statement.
Warm eviction separately claims `warm → cleaning` under the Workspace lock;
terminal or Tool admission cannot borrow compute after that claim.

Local recovery derives its known runtimes from warm, Tool and terminal holders.
Adoption joins the existing Workspace provisioning serialization and rechecks
local identity after the candidate snapshot. A recovered handle must match its
recorded Workspace. Profile changes cannot evict a terminal-held runtime.

Terminal admission now follows Session → Workspace lock order. A cleaning or
unknown shared runtime is busy, not permission to create a second terminal VM.
Workspace deletion combines its five occupancy checks and detached-Session count
under the existing lock. The empty-Workspace sample uses eight business SQL
statements instead of thirteen, excluding transaction framing.
The unused `turnWallClockTimeoutMs` field/initializer is removed.

The original seven PG review probes were replaced by maintained regressions in
`packages/sandbox-control/test/shared-compute-lifecycle.postgres.test.ts`, with
two additional admission/retirement races. All nine pass with real PG and a
controlled provider. Active terminal/child destruction is zero; the duplicate
adoption test also confirms ordinary eviction after explicitly closing the last
terminal. Concurrent Run/terminal admission both succeed. These are not live VM
fault tests. Sandbox-control and Control Plane typechecks pass. The 53 controller cases and
42 ownership/admission/cleanup/recovery cases pass (95 existing tests total).

An initial typecheck exposed a missing Workspace scope on the internal recovery
candidate; the port and fixtures now carry the existing PG identity explicitly.
Earlier broad test runs were stopped while refining that change and diagnostic
output; they are not counted as passing acceptance. The completed per-suite results above supersede those interrupted runs; live
release evidence remains pending.

Private test logs are under
`deploy/production/runtime/release-evidence/resource-repair-20261020/`.
No production accounts, configuration, credentials or resources have been changed.

## Slice 2

Supervisor reads no longer call an immediate `changed` callback. Committed
request/reply changes already create ordered Session control references in PG;
their existing Kafka/Projector path wakes reconciliation. Known retry/expiry
timers and native outcome wakes remain. The regression observes quiescence
between actual changes and one reply after the answer arrives.

Pending decisions are selected independently of progress, oldest first with ID
as tie-breaker. Native terminal child state precedes supervisor blocking. Pending
lists exclude ended children; a new reply rechecks child state after acquiring
its request lock, while replay of an already committed identical reply remains
idempotent.

Acknowledged child admission has a joined current-authority/status read instead
of repeating creation locks and management RPC. The repeated pending-child sample
uses two business SQL statements and zero locked reads, down from seven and two.
First/uncertain admission retains its original transaction and identity checks.

Workflow key/result maps now belong to one Tool invocation. Disposal aborts
pending local waits, clears the map and rejects late callbacks. A separate
explicit-GC process retains the Run's bindings and all 64 closed callbacks while
all 64 result objects become collectible. This is a reachability check, not an
OOM or throughput claim.

The seven-file targeted suite initially passes 30 cases. The updated six-case
supervision suite also passes, adding a real-PG child-cancellation/reply race and
checking multiple pending decisions (31 distinct cases in total). Control Plane
and Supervisor Host typechecks pass. Review characterizations were moved into
maintained tests; baseline evidence remains in Git.

## Slice 3 native prototype

The fixed native Harness passes interruption after child creation, configuration,
input admission and completion, plus Stop after restoration. Each keeps the
same source Task/child/initial Submission and does not rerun an unsafe child Tool.
The completion case adds a later child answer before restarting; the resumed
delegation still returns its original Submission's answer. Normal preparation
runs once while safe execution resumes.

These five new cases and four existing native family contracts pass; the
Sandbox Supervisor typecheck passes. Storage is a public MemoryStorage journal
restored into a fresh instance, and Models are Faux. The existing creation
adapter represents the management endpoint inside the test process. Distributed
PG/RF3 handoff and actual Cloud tool registration are not yet verified by this
prototype and remain the next implementation step.

## Slice 3 integration

The model catalog now separates safe direct `subagent` delegation from unsafe
`subagent_control` management and `workflow` scripts. Old combined action forms
are removed. Live-check prompts and Subagent documentation use the new catalog.
The matched Session topic advances to v18. Schema 193 attaches supervisor
requests to the original native Task and writer: a continuing child cannot
remain blocked on an interrupted unsafe caller from the previous owner.

The generic remote adapter can reprepare a safe Tool through its public native
execute path. A task-owned `pi-cloud.tool-recovery` document stores only the
original commit/operation reference; the new callback has a fresh operation ID
and boot mailbox. Original arguments and context remain at their initial
checkpoint. The Projector validates current authority and resolves that original
intent. The child association reuses the original identity and returns its
initial Submission's answer, even if later input produced another answer.
Target-free paginated discovery uses existing family/native associations.

The native bridge test additionally verifies reference persistence before
adopting a fast reply. Component suites cover current/stale callback correlation,
original answer selection, paginated discovery, ended native supervisor callers
and replaced writers. Initial catalog tests passed 47 cases; the expanded
recovery suite initially passed 39/40, with the remaining fixture incorrectly
trying to admit prohibited NUL task text. The corrected controller/activity
suite passes all eight cases.

The RF3 integration test performs two ordered old-writer closures and actual
PG queue claims, creates two new boot mailboxes, reads the original intent through
the production Session host, loses a reply, replaces the control dispatcher,
and receives the original outcome without a second child or Submission. Terminal
callers do not reappear on another dispatcher recovery. Both this test and the
same-boot mailbox reassignment test pass. The first broader transport attempt
also found an omitted version in its manually constructed document fixture;
that fixture is corrected. Actual cloud Worker management and KVM/model
acceptance remain release gates, not claims made by these controlled tests.

The production Worker Runner/Session Host/Tool catalog bridge also passes both
real-PG tests with Faux models: native follow-up stays in the child Conversation,
and child publication failure remains contained under the shared writer.

## Slice 4

[ADR-0265](../adr/0265-volume-reference-recovery-evidence.md) records upstream
comparison and the evidence contract. Cube patch 0012 preserves missing holder
IDs and conservative counts at restart. Reference observation reconciles only
the fixed POSIX plugin after the original allocation is durably closed/absent
and exact-node Observe confirms physical absence. The existing pending-detach
receipt handles hook/receipt interruption. Surviving shared holders may detach;
new attachment remains blocked until stale references converge.

Allocation GC retains records named by node holders or pending detaches in the
same Bolt transaction, deferring those expiry entries so unrelated collection
continues. No new database, controller, guest protocol or VM destruction authority
is introduced. Unrecoverable historical Unknown records stay unconfirmed.

Pinned Go race tests pass for lost last/shared holders, repeated restart,
unavailable evidence, failed detach receipts, late-attachment serialization and
allocation evidence retention. The maintained full allocation check also passes
Cubelet, real-MySQL Master and service-level physical-evidence contracts. The
obsolete characterization driver is removed; regressions are maintained in the
patch. A final additional historical-Unknown guard case is included in the
release-wide rerun. No live VM restart is claimed before matched deployment.

## Slice 5

[ADR-0266](../adr/0266-upload-reference-and-write-lifetimes.md) records schema 194.
Additional inputs/edits acquire delivery-specific upload pins. Definite no-send
or native refusal releases only its pins; ACK promotes retention. Maintenance
uses native current receipts, or that exact writer's projected seal, to settle
uncertainty. Initial Run admission remains one PG transaction. Pins contain no
input text and perform no delivery. Inputs without uploads incur no pin SQL.
Removal rechecks pins in a fresh statement after taking the upload admission lock.

Image inventory records positive write completion. GC retains uncertain writer
markers and deletes late bytes on subsequent passes; it cannot forget an object
whose PUT completed during DELETE. The S3 port disables automatic repeated writes
of one object identity. An unacknowledged crashed write can retain a small cleanup
marker indefinitely; neither timeout nor absent bytes prove writer quiescence.

MIME/claim rejection closes the sniffed source. Removing a local active draft
cancels and joins its placement. Image preview forwards the original through
the scoped stream with browser cancellation; its last chunk waits for complete
length/hash verification.

Four integrated suites pass 44 tests, including real native submit/edit receipts,
concurrent same-image delivery, withdrawal, fresh maintenance and ordered owner
closure. Additional regressions verify admission/remove locking, corrupt HTTP
response refusal, early claim cleanup and one-attempt buffered S3 PUT. The three
expanded upload/storage/S3 suites pass all 23 cases. Schema 194 verification
initially found the migration-count assertion still at 192; corrected verification
passes. Affected source typechecks pass. Owned loopback/controlled blob tests do
not claim actual S3/Cube live acceptance.

## Slice 6

Terminal redirect state is established before PG validation. Closure of the
previous peer cannot close a valid successor attempt; invalid validation,
browser cancellation and stale peer callbacks retain their own boundaries.
The upstream WebSocket has a 15-second handshake deadline and reports a
retryable connection error. Healthy connection/Agent lifetimes gain no limit.

Destroying a preview Agent now aborts its internal CONNECT, including redirects
and late socket delivery. Sandbox control tracks connections before opening the
backend, aborts pending opens on caller/shutdown closure and joins them before
shutdown returns. Late streams are destroyed without a 200 response. Cancellation
passes through the provider to the guest relay connection; known relay-start
failure joins its bounded cleanup request.

Five targeted suites pass 60 cases, covering redirect validation/cancellation,
stalled handshakes, pending CONNECT teardown, late shutdown streams, binary HTTP,
SSE, WebSocket and PTY control. Both affected typechecks pass. An additional
guest-relay cancellation test initially referenced a fixture variable cleared
by its successful cleanup; it now retains the actual connection object and
passes. Controlled endpoints prove connection ownership, not live application
continuity; that remains a matched-release gate.

## Combined release verification in progress

Before live acceptance, the owned-fixture cleanup helper now refuses unfinished
image writers. A single PUT stopped before the complete declared body is sent
can record definite failure under the S3 no-partial-object contract; a full body
without an ACK remains uncertain. Nineteen targeted cleanup/upload cases and
five S3 transport cases pass. Read/delete retries retain their existing SDK policy.

Maintained live gates now check safe child continuation/discovery, original
Submission/configuration and one canonical delegation result. The long-work
gate also holds a real terminal-only VM beyond fifteen minutes. Obsolete
RunAttempt-shaped SQL and failure-only expectations in the family gate are removed.
These live gates have not yet been run against the candidate.

The first broad CI pass began before these final follow-ups; it recorded one
upload-lifetime case failure among 443 Control Plane cases. A fresh run of that
package's entire nine-case upload file passes. Keep the original log and complete
frozen-source verification before deployment; no failed sample is counted as passing.

Final cross-check also distinguishes preparatory input metadata from an actual
native Submission. A failed image-preparation stage retains a provisional pin
while its writer is active, then releases it after ordered closure if no native
Submission exists. The three input/upload suites pass all 38 cases, and the
Control Plane typecheck passes.

The full repeat has passed all 443 Control Plane cases, other workspace unit
suites, 81 operator-helper cases and the nine RF3/PG transport cases; fault
evaluation and dependency audit continue. The old two-argument preview assertion
now verifies cancellation propagation; registry database initialization is in a
separate 60-second setup hook while its unchanged business test retains 20 seconds.
All 54 targeted controller/registry cases pass.

An initial artifact preparation built the guest/native/application images but
refused scanning because final fixes left the checkout dirty. It was not applied.
Rebuild/relabel from the final clean commit and repeat artifact evidence before
cutover; do not use the incomplete candidate or bypass the clean-source check.

## First matched deployment and additional live finding

The frozen-source suite, RF3/PG transport, fault evaluation and dependency audit
completed successfully. Eleven image artifacts passed the maintained evidence
gate. `resource-repair-3a045bf7` deployed with schema 194 and Session topic v18;
all Pods became Ready and the Windows localhost entry returned HTTP 200.

Actual Luna/Cube acceptance passes native input/Stop and Worker/Control Plane
recovery, safe shared/ephemeral delegation without a duplicate child or initial
Submission, all five supervisor/workflow interaction scenarios, and owned node
restart/Volume cleanup. The long-work gate held the same Run and Worker for
1,020 seconds and an existing warm VM's human terminal for 1,021 seconds, then
verified graceful Worker handoff. Initial live fixture errors (obsolete column
name and an incorrect standalone-terminal inventory assumption) are retained;
the corrected gate uses a normally warmed Agent VM and passes.

The actual S3 preview gate uploaded a 34,744,889-byte original, cancelled its
preview after 13,692 bytes and verified a subsequent complete read by hash.
The following partial-upload cancellation exposed a separate runtime defect:
an S3 request body's unhandled Readable error terminated the Control Plane.
The owned failing image inventory remains until writer quiescence is proven.

The adapter now owns the body's error/completion lifetime, aborts the remote
request on source failure and joins stream teardown. Four child-process tests
exercise cancellation at different points through real loopback HTTP and the
AWS SDK; the source-error case previously exited with an unhandled error.
All 30 attachment/upload transport cases and both affected typechecks pass.
The fix still requires a new matched release and actual cancellation repetition.
Large-image model acceptance also encountered upstream timeouts/TLS EOF; the
owner switched the proxy node, and those unchanged gates remain to be rerun.

## Upload correction and replacement acceptance

`resource-repair-7a05942f` passed the matched artifact gates and deployed. The
actual 34.7 MB preview/cancellation test now passes with the same Control Plane
process and zero restarts. Partial-write termination is recorded and the entire
owned fixture is physically cleaned. The earlier crashed writer was settled
only after its process exit and a controlled object-store process replacement
with no other active writers; its evidence is retained.

The unchanged Luna upload gate passes a 24,163,430-byte image and six attachments
totalling 60,863,590 bytes. Browser reload, direct vision, read Tool, ordinary
file contents and cold Worker image recall pass. Image-only queue admission,
editing, promotion to steer and one native consumption within the same Run pass.
The Control Plane replacement gate completes in 12,198 ms, retaining the Worker
and one physical command execution.

Additional terminal/preview replacement acceptance reproduced a refused upgrade
holding the old Sandbox control open. Its readiness `onRequest` ran before
the WebSocket plugin marked the request, so the plugin's response cleanup did
not close the detached socket. Readiness now uses `preValidation`, allowing
that existing plugin to own refusal cleanup. An isolated child-process test
fails before the fix and passes after it; all 33 connection/server cases and
the Sandbox control typecheck pass. This follow-up still requires deployment.

The full browser gate's missing running Tool was traced to Cube refusing
performance-profile VM creation, rather than a missing UI event. An owned
native request reproduces HTTP 500 with `reset guest time failed`; its allocation
was positively closed and absent. This matches the existing October 4 snapshot
restoration backlog item. Refreshing only that template from the same immutable
image and repeating its actual boot is in progress; no smaller profile or weaker
browser assertion substitutes for the failed gate.

# Replacement Worker → Pi Harness recovery review

Reviewed on 2026-10-19 at `e131a2ea0407db928abc6219a5267b84ab2d95d1`.
Serving source/release remain `0de1fe7f` / `seal-projection-0de1fe7f`, schema 190.
[Structured evidence](worker-harness-recovery-review-20261019.json).

Scope: after ordered old-writer closure and new PG admission, opening native
Storage/Harness, restoring context and pending input, rebinding live child
Conversations, and continuing or stopping native tasks. This does not repeat the
preceding lease/seal audits or audit the deferred provider request branch.

This review changes documentation and adds isolated, executable characterizations.
Runtime code and production services are unchanged. Tests use owned disposable
PostgreSQL, native MemoryStorage, in-memory object bytes and faux models. No
production fault, OS process-crash experiment, Kafka publication, provider call
or sandbox operation was performed. Earlier incomplete large-image cold-recall
acceptance remains incomplete; the small attachment probe below does not replace it.

## Flow and architecture assessment

1. The cloud still owns admission. `RunExecutor` supplies the same logical Run,
   Turn and accepted configuration under a new Session lease. Worker producer
   fencing and ordered closure remain prerequisites, not Harness responsibilities.
2. `PostgresDurableSessionHost` verifies the grant and shares one Storage/Harness
   per physical Session lease incarnation. `PublishedDurableStorage.open()` reads
   the latest native sequence/ID head and refuses outstanding live replay
   references. It does not bootstrap from lifetime JSONL or independently replay
   Kafka. The preceding Projector must already have produced the complete PG
   handoff checkpoint.
3. Pinned Pi Durable 1.0 `Harness.open()` loads nonterminal task states and changes
   surviving `running` tasks to `pending`. Dispatch remains paused until native
   `resume`/submission/wait operations enable it. Ownership reconciliation may
   already commit native cleanup; it still uses the admitted Session writer.
4. Cloud binding restores the accepted model/tools/context. Active native task
   Conversations identify live children; historical children are not restarted.
   Their frozen view, original delegation source and display cursor restore
   cloud ports. The family `bindingsReady` barrier guards model and Tool effects.
   This is necessary rebinding around Pi's scheduler, not a child cloud queue.
5. Initial input is deduplicated by the existing native Submission request ID.
   Current `pi.inbox`/human-input documents contain pending input bodies; Submission
   rows contain lifecycle metadata. Recovery does not resurrect superseded edits
   or create a second Run for a follow-up. Existing requests call native `resume`.
6. Context bounds come from the latest native head marker and active suffix.
   Compaction recovery restores its native request identity. Fixed remote Tools
   retain `replay: unsafe`: a recovered `execute` checkpoint becomes an interrupted
   result, with no new physical dispatch. Pi owns the next decision.
7. Root idle is descendant-aware. A final answer or a `done` Submission is not
   sufficient to close the family while child work remains. Stop uses native
   abort/withdrawal; it does not infer physical process death or permit shell replay.

The responsibility split is sound in the inspected paths. The current issues
are cloud I/O lifetimes and avoidable reads, not a need for another task table,
checkpoint authority, RunAttempt, child lease or a patched Pi loop.

## Findings

### WHR-01 — P2: recovery data reads have no outer PG wait bound

Worker startup constructs its ordinary PG pool without `readTimeoutMs` or
`checkoutTimeoutMs`. `PostgresDurableSessionHost` uses that pool for native head,
record/document and child metadata reads. The bounded two-connection lease pool
does not bound those data reads, and ADR-0261's bounded Projector pool belongs to
the Control Plane. The maintained PG deployment adds no substitute query deadline.

An owned real-PG pool with the same default settings is occupied by one controlled
checkout. Native cold open is still waiting after **250.4 ms**, until the fixture
releases it. The source establishes that no application deadline eventually
ends this wait; the short observation is not a claim of an infinitely observed
outage. Actual row-read lock waiting is also covered by WHR-02.

A replacement Worker can retain admitted work while waiting for restoration,
without reaching model execution or clean retirement. Many such reads also
compete with ordinary Worker database operations. Valid leases and write fencing
prevent stale effects but do not provide bounded read progress.

Locations: `packages/supervisor-host/src/main.ts:49`,
`packages/supervisor-host/src/runtime.ts:189`,
`packages/pi-session-postgres/src/durable/session-host.ts:321`,
`packages/pi-session-postgres/src/durable/postgres-projection.ts:126`.

Direction: reuse the existing database adapter for bounded native recovery reads,
including connection acquisition and queries outside transactions. Keep this
distinct from lease authority and uncertain writes; do not globally apply a
disposable-read policy to the mixed Worker pool. Timeout must release the actual
client/query rather than merely abandon a Promise. Include child/source/image
metadata reads in the chosen boundary. Also specify the failure result: generic
bootstrap errors currently become `agent_runner_error`, while automatic same-Run
recovery recognizes explicit ownership/publication failure codes. Adding a timer
alone is not a complete recovery policy. Proven transient restoration failure
and corrupt/missing native state need different treatment through the existing
ordered closure path, without reinitializing an uncertain writer.

### WHR-02 — P2: cancellation is dropped on the cold-read path

`PiCloudTurnRunner` passes its startup signal to `openSession`; production's
`openAgentSession` binding ignores it. Native Harness setup uses
`BACKGROUND_CONTEXT`, and Storage record/document methods discard their Context.
Projection hydration calls the attachment codec without a signal. Storage close
then waits for the serialized read tail.

In a real-PG fixture, an actual Entry read waits on an owned table lock. Cancelling
its Context does not settle the read or `Storage.close()` after **250.4 ms**.
After the fixture unlocks the table, the cancelled read returns the Entry normally.
A second probe holds a native image read: cancelling the supplied Context does
not abort the object reader's signal. Image transfer retains its own 60-second
deadline, so this is not a claim that every image request waits forever. Its PG
metadata read is also subject to WHR-01.

This can delay cancellation/retirement during restoration even though new model
and Tool effects remain gated. The probe tests the Storage cancellation boundary;
it does not measure a live user's Stop latency. A separate real-Runner native
child bootstrap Stop case settles correctly when its reads are available.

Locations: `packages/supervisor-host/src/runtime.ts:566`,
`packages/sandbox-supervisor/src/durable/agent-session.ts:246`,
`packages/pi-session-postgres/src/durable/published-storage.ts:310`,
`packages/pi-session-postgres/src/durable/published-storage.ts:564`,
`packages/pi-session-postgres/src/durable/postgres-projection.ts:153`.

Direction: carry read cancellation through the existing runner/host/storage/image
ports, using the native Context where applicable. Distinguish cancelling one read
or a revoked owner from native Stop settlement, which still needs durable state
to withdraw input and abort tasks. Do not blanket-replace every background cleanup
context or interrupt an acknowledged commit halfway through adoption. Combine
cancellable reads, bounded PG cleanup and deterministic owner disposal; preserve
the tested Stop-on-resume and family barrier behavior.

### WHR-O1 — P3 optimization: child metadata recovery issues two queries per child

`PostgresDurableSessionHost.activeConversations()` reads each child's original
delegation record, then separately reads its display cursor. It starts this work
with an unbounded `Promise.all` over the active views. The pool limits simultaneous
connections, but it does not remove queued requests or the extra round trips.

The actual loader performs **2 / 16 / 64 metadata statements** for **1 / 8 / 32
active children**. All returned prompts and cursors are correct. This fixture
controls the native active-view port and runs the real PG loader; the count
excludes the Harness's own task/document scans and individual child setup.

Location: `packages/pi-session-postgres/src/durable/session-host.ts:239`.

Direction: fetch bounded batches of exact native source references and matching
child cursors, ideally joining their metadata in the same request. Preserve
tenant, root Run, Conversation/source-kind checks and missing-source failures.
Use the current recovery operation's known identities; no cross-request authority
cache, child scheduler, prompt copy or new queue table is needed.

### WHR-O2 — P3 discussion: one context build reads the same image twice

Pi's `captureContextBounds()` reads the newest Entry to discover its ID, then
`deriveContext()` reads the active range. PiCloud eagerly hydrates image references
in each Storage result. A real native context read containing one 1×1 PNG causes
**two object-store reads for one immutable image**, with exact returned content.
Codec deduplication is currently limited to one decode invocation.

This is a measured extra cloud I/O cost, not a native data-loss defect. The fixture
does not establish the cost for 25 MB images or explain the earlier upstream model
header timeouts. The current architecture deliberately revalidates independent
image reads and does not retain bytes between decode calls.

Locations: pinned Pi `dist/harness/context.js:10` and `:46`,
`packages/pi-session-postgres/src/durable/postgres-projection.ts:199`,
`packages/session-attachments/src/codec.ts:98`.

Direction to discuss: determine whether public API boundaries allow bounded reuse
of verified bytes within one restoration/context build, preserving tenant,
reference metadata, integrity and cancellation checks. Define a byte/lifetime
bound and clear it with that operation/owner; reconcile the existing per-decode
policy in ADR-0192/current architecture before implementation. Returning incomplete
Storage records, patching native private fields or adding an unbounded cross-Run
image cache would be inappropriate. Accepting the current cost is also valid until
the intended optimization has a sound lifecycle and measured benefit.

## Verification and limits

- **110 existing tests in nine files pass**, including real-PG Storage conformance,
  same-Run admission after closure/Stop, shared Session host, native child control
  delivery, unsafe Tool non-replay, current-input edits, streamed-call recovery and
  Compaction summarize/retry/Stop.
- Four focused I/O/attachment characterizations reproduce the findings above.
  Controlled waits are always released and temporary PostgreSQL is removed.
- Two native family cases reopen a captured committed prefix with a root already
  answered and a live child plus queued follow-up. Both retain one creation/Tool
  effect and one queued receipt. Continuation makes two new child model calls;
  Stop makes zero and withdraws the queue. A missing grant and closed family
  binding barrier prevent model entry.
- A real `RemoteToolSandboxTurnRunner` case delivers Stop during restored child
  bootstrap. It returns `turn_cancelled/user_request`, with no model permit or VM
  activation. Ownership, source-view and publication ports are controlled; this
  is not a distributed ownership or physical process-death test.
- With **0 / 1,000 / 10,000 historical Entries**, the same two-entry active context
  (latest head plus suffix) uses **12 SQL statements** and reads **zero old bodies**.
  Returned body totals are 766 / 790 / 798 bytes; local samples are 20.7 / 13.1 /
  18.3 ms. The synthetic head marker isolates indexed read growth; these are not
  real model-compaction latency or fleet-capacity measurements.
- The three child-loader measurements isolate WHR-O1. No arbitrary shell
  exactly-once or whole-system recovery claim follows from these tests.

[Reproduction commands and fixture boundaries](../../scripts/experiments/review-worker-harness-recovery-20261019/README.md).
The earlier release section in `ARCHITECTURE.md` incorrectly still said ADR-0261
was not serving; its status is corrected to the already-deployed release, while
the unaccepted image gate is retained. No runtime fix is included here.

Next main walkthrough: Pi → Worker-local Model Gateway → CLIProxyAPI → provider
and the streamed response back. It should include the outstanding large-image
request/header timing investigation, without treating this review's attachment
read count as its established cause.

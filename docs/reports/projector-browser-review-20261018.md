# Projector → browser review

Date: 2026-10-18 (Asia/Shanghai). Reviewed baseline:
`5e6a381fa24dab8f4e9c6373ccc8345580fb33a8`.
Serving release remains `session-completion-6e74fd5b`.

Scope: committed native display descriptions through the Session Projector,
compact live tail, canonical PG snapshot, SSE subscription/framing/proxy,
browser reducer, text animation, runtime observations and terminal display.
This is a review with isolated characterizations. It changes no runtime,
schema, public protocol or production deployment and injects no production fault.

Subsequent planning is recorded in the proposed
[ADR-0257](../adr/0257-browser-observation-and-buffer-boundaries.md). It refines the
initial resync-first repair direction after checking the recoverable Run's queued
interval, choosing existing execution-generation metadata for observations.
The review findings/evidence below remain the baseline; no repair is claimed.

## Findings

### PBR-01 — P2: Worker replacement leaves old observation revisions in the open page

ADR-0229/0247 preserves the logical Run and Turn across Worker replacement but
issues a new Session writer. Worker activity revisions restart from zero, as do
the Projector's execution-observation revisions for the new writer. Admission
correctly keys observations by writer/Run/Session and removes the old writer on
its ordered seal.

The public observation loses that writer identity. Both the open SSE
`RunObservationView` and browser `RunObservationStore` compare revisions using
the unchanged Turn/Run. Neither is reset by an ordinary recoverable writer seal;
the Control Plane and its browser connection can stay alive during Worker loss.
Another `turn.started` for an already-known Turn does not reset the server view.

The isolated production-module chain reproduces this schedule:

1. The open page has activity revision 100 and execution revision 10.
2. An ordered recovery seal removes writer A; writer B is admitted for the same
   logical Run. Old A is still rejected by Projector admission.
3. B's activity and execution updates at revision 1 pass that admission, but the
   existing SSE view filters both out as older than 100/10.
4. Sending B's activity directly to the browser store also fails the old-revision
   check. A fresh SSE view and reset browser store accept it.

Impact: after genuine recovery, the page can retain an old phase/VM status and
then show stale or generic status even while new work is healthy. New revisions
must exceed the old counters, or the page must reconnect. Transcript delivery,
terminal events and execution authority are separate; this is not a lost result
or a reason to destroy a VM. The probe is in-process, not a real Worker kill.

Locations: `packages/supervisor-host/src/run-activity-publisher.ts:48`,
`packages/runtime-core/src/run-observations.ts:17`,
`packages/runtime-core/src/run-observation-view.ts:26`,
`packages/runtime-core/src/run-observation-view.ts:45` and
`packages/web-ui/src/RunStatus.tsx:38`.

Repair direction: align disposable observation lifetime with the existing ordered
writer handoff. Prefer reusing the existing Session resync/replacement-snapshot
path at a confirmed recoverable handoff, covering every affected child view,
instead of adding PG health rows or another heartbeat log. Reset both the open
SSE eligibility/revision state and browser observations; retain current-scope,
freshness and old-message rejection. Verify same-Run Worker replacement with an
uninterrupted browser connection, child views, late old observations and normal
terminal delivery. If a separate observation-generation field is chosen, record
that public protocol decision before implementation; it is not a second lease.

### PBR-02 — P2: slow-reader admission counts records but not retained bytes

`SessionEventSubscription.#push()` asks for a replacement snapshot at 1,024 queued
formal events. It never counts their bytes. The framing limit bounds an individual
SSE frame after serialization; it does not bound retained complete event objects.
The 30-second socket deadline handles a fully blocked write, but a slow reader
which occasionally drains can keep a backlog while new events arrive.

The characterization queues 128 valid complete `write` Tool-start events, each
with a 256 KiB input body, then drains all 128 without a resync request. Every
encoded event is below the existing 900 KiB execution-Fact bound. The queue
therefore retains references to 32 MiB of Tool input at this small record count.
At the same body size, the 1,024-record limit permits 256 MiB of bodies. The latter
is arithmetic, not a measured heap peak or an observed production OOM. Objects
are shared with other views/subscribers; the estimate must not be multiplied by
viewer count as though every body were copied. A lagging subscriber can still
keep those bodies alive after the canonical live-tail cache evicts them.

Impact: memory protection depends heavily on payload mix, so a single slow
viewer can retain far more data than the same number of ordinary text deltas.
This matters because the Projector and API share the Control Plane process.

Locations: `packages/runtime-core/src/session-event-hub.ts:129`,
`packages/runtime-core/src/session-event-stream.ts:30` and
`packages/runtime-core/src/session-stream-framing.ts:12`.

Repair direction: account for queued bytes as well as count using the existing
subscription queue. Estimate each immutable event once, update counters on
dequeue/reset/close, and use the existing resync/close path when the memory budget
is reached. Keep the blocked-write deadline and independent subscribers. This
limits disposable backlog, not total conversation output or admitted Tool size;
it should not wait on a browser before projecting Kafka or dispatching Tools.
Acceptance should include varied payload sizes, a periodically draining socket,
counter release, a healthy second reader and exact replacement-snapshot content.

### PBR-O1 — P3: streamed commentary retains obsolete complete-message cache rules

`CompactEventTail.#merge()` unconditionally refuses commentary spans, including
adjacent appends to the same explicit message ID. Git commit `e301418a` introduced
this rule when each commentary event was a separate complete message. Current
Durable presentation streams commentary with stable message identities.

With the same 1,000 three-character appends, commentary retains 1,000 spans while
final-answer text retains one. Both reconstruct exactly 3,000 characters. The
class's span-byte estimator reports 336,893 versus 3,337 bytes; this excludes the
shared per-sequence identity map and JavaScript object overhead and is not RSS.
The waste lasts until the native message's canonical coverage evicts its spans.

Location: `packages/runtime-core/src/compact-event-tail.ts:76`.

Repair direction: allow adjacent commentary appends with the same nonempty
message ID and phase to compact just like final text. Preserve distinct messages,
phase changes, replacements, canonical identity settlement and sequence gaps;
phase-absent/message-ID-absent event support is an existing public contract, not
a reason to merge separate commentary messages. Test reconstructed text and
snapshot coverage as well as span count. This changes only the disposable cache,
not native commits, Kafka records or live subscriber event order.

### PBR-03 — P3: maintained docs describe a removed 25 ms public-text buffer

`docs/STREAM_DURABILITY.md:118` and `docs/ARCHITECTURE.md:632` still describe
25 ms coalescing of public assistant text. The current same-commit path prepares
descriptions with native Storage, projects them and immediately publishes each
original event through `SessionLiveView`/`SessionEventHub`. It has no such public
text timer. Native Pi partial-write coalescing, compact recovery spans and browser
animation are separate mechanisms.

Impact: this gives an incorrect explanation of latency and where text waits,
especially during the ongoing message-path walkthrough. It is documentation
drift, not evidence of a second live-text publisher.

Repair direction: remove the obsolete 25 ms claim from maintained guidance and
describe the actual boundaries. Keep earlier decisions in historical ADRs/reports;
do not add a timer merely to make the implementation match old prose.

## Verified boundaries and review limits

- The assigned Projector remains the one Kafka history/live/Tool consumer.
  API forwarding uses its current owner and does not create another replay view.
- Native projection succeeds before display delivery. PG materializes canonical
  history/current state under the existing policy; native streaming bodies stay
  in Kafka. No second browser transcript is introduced.
- Subscribe-before-tail-before-primary-PG ordering is retained. In the added
  concurrent fixture, PG overtakes the captured partial and queued events: the
  snapshot contains `complete`, and only subsequent sequence 3 is sent live.
  Covered text is not replayed or duplicated.
- Existing PG tests cover native message/Tool history, coverage and borrowed
  tails, closure checkpoints, late old-writer writes, prefix replay and retention.
- Existing browser/SSE tests cover large framed values, Unicode, interruption
  before `stream.end`, replacement snapshots, scope checks, deleted/unauthorized
  Sessions, observation/preview separation and terminal precedence.
- The real-browser gate covers React effects/StrictMode, commentary and final
  animation, recovered prefixes, reduced motion and runtime status. Its browser
  and product fixtures use no real model or production database.

No transcript-loss/duplication defect was reproduced in these covered schedules.
This does not establish fleet capacity, a zero-gap UI under every network fault,
or real multi-node/production chaos acceptance. A new queue/broker/cache service
or browser-owned execution authority is not needed for the proposed repairs.

## Verification and reproduction

117 existing tests pass across 18 files:

- 82 tests: live view/stream, Projector handoffs, event hub, Tool/Run observations,
  input-queue delivery, transcript reducers, SSE client, presentation and scrolling.
- 9 tests: native text descriptions, display protocol and browser runtime status.
- 26 tests with the maintained disposable PostgreSQL fixture: conversation tree
  history, execution seals and Durable execution recovery.

`npm run browser:presentation:check` passes. Four additional characterizations
pass against the reviewed baseline; these assert observations of the current
defects/limits rather than silently turning them into desired-behavior contracts.
The [JSON evidence](projector-browser-review-20261018.json) records their scope and
measurements. Reproduce without production access:

```sh
node --import tsx scripts/experiments/review-projector-browser-20261018/probe.ts /tmp/projector-browser-review.json
```

The probe uses actual runtime modules, synthetic scoped records and an in-memory
socket. The pending PG snapshot is controlled by the fixture; no actual PG
network failure, Kafka rebalance or Worker crash is injected by that probe.
The separate 26-test group uses a real disposable PG instance.

Private logs are under
`deploy/production/runtime/release-evidence/projector-browser-review-20261018/`:
`baseline-tests.log`, `native-display-tests.log`, `pg-projection-tests.log`,
`browser-presentation.log` and `probes.json`. The disposable PG container is
removed by the maintained runner. No production fixture or configuration is changed.

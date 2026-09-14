# Whole-repository review and user-flow acceptance

Base revision: `c9a3b333`. Status: historical partial campaign, continued by the
[September 15 audit](repository-audit-20260915.md). This document is not a claim
of whole-repository coverage or completed live acceptance.

## Scope and invariants

Inspect tracked source, tests, deployment/configuration and maintained docs by
component, with explicit file/range coverage. Dependency lockfiles, generated
artifacts and historical migrations are distinguished from active code; obsolete
readers/fallbacks can be removed, but migrations still required to build the
current schema cannot simply be deleted. Preserve current user features and the
PG authority → Worker → Kafka → unified Projector architecture. Stop for the
owner's decision if a correction requires changing an architectural invariant.

## Campaign

| Slice | Required evidence | Status |
| --- | --- | --- |
| Architecture and inventory | README diagram, exact tracked-file coverage | In progress |
| Input, identity, scheduling | FIFO, idempotency, shared Session ownership, cancellation, query/ACK cost | Pending |
| Native Session/Harness | official backend contracts, branch/fork, interrupted context, repeated Compaction | Pending |
| Kafka/Projector/SSE | no delta rows, sealed-prefix recovery, slow/disconnected readers, restart and load | Pending |
| Tools/resources | actual Cube, shared/isolated bindings, terminal/SSH, provision/rebind/release/purge | Pending |
| Subagents | direct/workflow, fresh/branch, shared/isolated, recursive, communication/cancellation | Pending |
| Providers | heavy native search, provider/reasoning/Fast switches, Compaction, different-Worker restore | Pending |
| Product surface | enumerate API/UI actions; exercise each supported entry; playable preview and port isolation | Pending |
| Performance | paid multi-tenant/multi-Session runs; separate queue/platform/provider/client timing; model-free load | Pending |
| Delivery | final checks, scoped fixture cleanup, preserved accounts/settings, resume update, commits | Pending |

Testing uses separately identified tenants/resources. Preserve user data and
configuration; remove only campaign fixtures after physical cleanup is confirmed.
Do not erase provider usage accounting. Keep aggregate evidence, not raw prompts,
credentials, screenshots or generated test workspaces.

Latency evidence distinguishes first model activity, first text, Tool preparation
and final completion. Compare matched provider/first-text intervals, not the
duration of a whole model response. Record queue/model-admission waits separately.
Detect wall-clock discontinuities; do not report negative cross-process latency
or infer actual active concurrency from simultaneous POSTs.

## Findings in the first inspected slice

- Corrected two acceptance scripts which looked for nonexistent `tool.preparing`
  instead of the current public Tool-preparation event. Activity classification
  and wall-clock-jump rejection now live in the shared measurement helper; its
  tests enter the normal `check` gate. Long-context runs record matched transport
  timing outside the measured completion interval.
- Removed Projector's decode → stringify → decode round trip. Wire decoding
  happens once; authorization/projection/routing use the same decoded record.
  Its regression failed before the change and passed afterward.
- Removed repeated `Promise.race` subscriptions to the same idle SSE read.
  Each heartbeat now finishes its pending read and releases its timer; the next
  read owns a fresh bounded wait. Event/close/timeout behavior is tested without
  changing the frontend protocol. The new regression failed before the fix.
- Removed the unused in-memory `DurableEventStore` writer/error hierarchy from
  production code and its implicit API fallback. Composition now requires an
  explicit event view; API-only tests inject a small read-side fixture. The
  production execution-log port remains separate from its Kafka implementation.
- Removed the unused native Projector authority-bypass option. The production
  wrapper always checks its execution boundary and co-commits a Kafka position.
- Reduced native usage statistics from four scans of the same usage records to
  one aggregate. Pinned Pi's 29 backend-conformance cases still pass.
- Reproduced a stale local lease-deadline observation rejecting a renewed owner
  during slow bootstrap. Only expired observations recheck PG; ordinary Steps
  still use the observed valid deadline. Real owner loss remains a rejection.
- Reproduced a lost `LISTEN` connection with a probe-owned real PostgreSQL
  backend: polling continued but subscription did not return. The Worker now
  reconnects off the queue-scan path, and closes a client after failed initial
  `LISTEN`. The same PG fault probe reconnects with the new code. This follows
  [node-postgres's client lifecycle](https://node-postgres.com/apis/client), not
  another scheduler or durable queue.
- Reproduced Workspace deletion racing message admission on independent real
  PostgreSQL connections: the old implementation acknowledged a queued Run after
  its Workspace had been deleted. The existence query now holds a shared row
  lock through admission. Competing admissions can read concurrently; deletion
  either wins first or observes the committed queued Run. CI's PostgreSQL service
  runs both orderings in a disposable test database.
- Resource API query-shape failures now return `400 invalid_request`, not a
  generic server failure. Six malformed/missing/repeated-query cases cover file,
  directory, machine-directory and installation-callback entry points.
- Removed an unreachable private environment-validation branch from Turn
  admission. There was no caller supplying its optional argument.
- Reproduced development-machine release destroying compute before rejecting a
  queued message. Release now checks all nonterminal Run states before any
  external effect. Admission shares the machine row lock and checks existing
  pending release intent after acquiring it. Persisted release requests are not
  mistaken for completed effects; retries and the existing reconciler can finish
  a release after request/reply loss or Control Plane replacement. Tests cover
  all three cases without automatically replaying any Agent Tool.

The first slice was committed and deployed as `74870892` (Control Plane and both
Workers). Whole-repository build, types, tests, formatting and docs checks passed;
29 official backend contracts and the recursive-index query-plan check also ran
against real PostgreSQL. The deterministic fault manifest passed all 26 targets.
That manifest is not a real-process chaos campaign.

Post-deployment Subagent acceptance passed twice, with 11 groups per run: empty/
inherited context, tool-less/lazy/shared/isolated execution, parallel and recursive
children, parallel Python coding, mailbox delivery, supervisor questions,
cancellation, guest-script boundary and conversation-tree projections. The first
run exposed a measurement-label mistake: its script overrode `low` with `off`.
The second removed that override and verified `low` in all 24 persisted Turns.
It recorded 12,903 input, 5,053 output and 183,040 cache-read tokens. Selected
valid samples had 175–194ms before model dispatch and about 8ms from the parsed
text event to the API/SSE client; these are not a percentile or browser-paint
measurement. Wall-clock discontinuities invalidate affected cross-process samples.

A fresh cookie-authenticated account also requested a real DeepSeek Snake game
in an exclusive Cube. Chrome observed write preparation, then loaded the isolated
preview and verified Start, keyboard movement, Pause and Reset through game-loop
state changes. The script released its machine/conversation and removed its
screenshot; physical purge and account/history cleanup are checked separately.

Follow-up work (not deployed yet):

- Real PG reproduced parent deletion archiving a child whose Run was concurrently
  accepted. Descendant rows now lock before admission checks; rechecking membership
  rejects a tree that grew during lock acquisition. Four real-PG resource race
  cases and existing conversation tests pass.
- CI's failing image scans report PCRE2 `10.42-1` in the pinned Node base. The
  shared build-time installer applies Debian `10.42-1+deb12u1`, verified in a built
  image. No advisory was ignored and the scan gate remains enabled. Debian lists
  this fix for [CVE-2026-86145](https://security-tracker.debian.org/tracker/CVE-2026-86145)
  and [CVE-2026-89161](https://security-tracker.debian.org/tracker/CVE-2026-89161).
  The updated CI image matrix and all other CI jobs passed.

The full browser check exercised 92 visible controls/actions: local auth and
language switching, both navigation panels, progressive conversation creation,
model/provider/reasoning/Fast menus, copy/download, Steer/Stop, tree views,
Workspace files/terminal, Fork/delete, development-machine create/pause/resume/
directory/SSH/release, and final resource cleanup. The fresh run passed. The
product API campaign also verified concurrent Tool execution from two Sessions
sharing one physical Workspace runtime. A two-family/one-model-permit campaign
ran five concurrent parent/child tasks without charging children as extra Session
families, queued a third independent family, then killed its Worker during a
child Tool. Closure and a replacement Worker recovered the Session and verified
the old file effect without replaying it. All Worker capacity settings were
restored afterward.

The direct Worker-to-Kafka benchmark used 32 partitions, three brokers, RF=3,
`acks=all`, idempotent Producers and no application microbatch. Its 60-second,
1,024-Session case acknowledged 5,055,873 records (84,255/s), with ACK p50/p95/
p99 of 10.874/19.441/24.438ms. This excludes Projector, PostgreSQL, model, Cube
and browser work and is not an active-Agent concurrency claim. Its temporary
topic was deleted.

The Workspace availability inconsistency was reproduced by removing only a test
settlement object while retaining its real Volume: browsing still worked, but
listing and even tool-less admission failed. The owner approved removing both
the per-Run settlement and unused Tool-output archive instead of replacing the
object with another revision head. ADR-0168 implements that cutover; the isolated
copy contract now uses physical Volume generation. See the [follow-up acceptance](direct-workspace-storage-20260914.md).

All ten tenants created by this campaign were removed after confirming zero
active Runs/leases/machines, zero Cube instances, purged Workspace storage and
no Volume directories. Runtime objects returned from 127 to the original 75;
the original 35 users and their password/model/platform-setting digests are
unchanged. The test rows are deliberately not recoverable except from an external
database backup; aggregate reports retain only acceptance evidence.

The completed long-context campaign is a baseline against the preceding deployment:
12 Python coding rounds, two native Compactions, early-context recall, subsequent
coding, replacement Workers and GPT/DeepSeek hosted-search/settings handoffs.
Native usage records contain 285,216 input, 202,617 output and 8,060,416 cache-read
tokens; this excludes Compaction/retry requests not represented by those records.
Full code coverage, post-change live/load/UI acceptance, cleanup and resume work
remain pending.

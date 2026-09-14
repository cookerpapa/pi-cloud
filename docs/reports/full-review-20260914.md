# Whole-repository review and user-flow acceptance

Base revision: `c9a3b333`. Status: **in progress**. This document is not a
claim of whole-repository coverage or completed live acceptance.

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

These source changes have focused tests, but have **not yet been deployed**.
The completed long-context campaign is a baseline against the preceding deployment:
12 Python coding rounds, two native Compactions, early-context recall, subsequent
coding, replacement Workers and GPT/DeepSeek hosted-search/settings handoffs.
Native usage records contain 285,216 input, 202,617 output and 8,060,416 cache-read
tokens; this excludes Compaction/retry requests not represented by those records.
Full code coverage, post-change live/load/UI acceptance, cleanup and resume work
remain pending.

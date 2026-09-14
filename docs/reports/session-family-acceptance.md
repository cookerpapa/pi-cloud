# Physical-Session ownership and capacity acceptance

Checked on 2026-09-14 on the one-host WSL deployment, with the uncommitted
ADR-0167 changes based on `970ecc4a`. Migration 137 and matching Worker,
Control Plane/Projector and Broker images were deployed; native facts use v8.
This is not a multi-node HA or maximum-throughput result.

## Verified behavior

- One physical Pi Session, including its main and child Lanes, owns one
  renewable lease/epoch and one Worker family slot. Each child retains task
  identity and cancellation, not an independently renewed lease.
- With one Worker, two family slots and **one** model permit, the API/SSE
  test observed five task scopes but only two leases. All three coding children
  shared their parent's lease. A separate family completed while those children
  waited for Tools; a third family waited for capacity, then ran.
- Real children implemented and tested insertion sort, binary search and
  Fibonacci in the same Workspace. A later branch child read and retested them.
- After observing a real file append, the test killed the Worker with SIGKILL.
  Both affected tasks closed before another Worker continued the Session.
  The replacement checked the one-line marker, reran the algorithms, and wrote
  a separate successful-verification file. The old append was not replayed.
- The existing 11-turn delegation suite passed: fresh/branch context, no local
  Tools, lazy Tools, shared/isolated Workspace, parallel children, depth-two
  recursion, parent/child messaging, supervisor interaction and cancellation.
  The observed parent/child executions shared both Worker and owner lease/epoch.
- A separate paid DeepSeek run generated and served Snake in a user-owned Cube.
  The authenticated host preview returned HTTP 200. A real headless browser
  verified start, movement, pause and reset, plus write-generation UI activity.

Machine-readable evidence:
[family/fault check](session-family-acceptance-latest.json),
[delegation regression](subagent-production-acceptance-latest.json),
[Snake browser regression](snake-preview-acceptance-latest.json).

## Actual failures found and repaired

The first fault run exposed a Broker cleanup bug: after warm reuse, child
bindings no longer used the original physical activation ID. Orphan cleanup
removed only that original binding, leaving stale aliases of a released Cube.
Cleanup now retires every binding for the exact physical identity under the
Workspace provisioning lock, before allowing a replacement. A regression test
reproduces warm reuse followed by two abandoned bindings.

The next run exposed missing child-status reconciliation after a parent Worker
died. A failed child Run could still appear queued in delegation metadata and
block conversation deletion. The existing bounded reaper is now driven by
projected seals and controller startup/recovery, without requiring a surviving
result reader. A stale status observation cannot overwrite terminal state.

The initial acceptance assertion also matched a success-marker string inside
an honest failure explanation. It was rejected as evidence. The maintained
check now examines the final transcript item and a verification file produced
after successful tests, and records cleanup failures. The complete family/fault
test was rerun successfully after both product corrections.

## Tests, timing and limits

The final full typecheck/test run passed **803 tests**. Targeted coverage includes
one renewal per family, child-only cancellation, final-member release, owner
expiry with a one-family reconciliation limit, drain accepting owned descendants,
fair model admission and permit release on Tool waits and Compaction failure.
Build, Helm, runtime budgets, install contracts, image closure and backup crypto
checks passed. The 26-case deterministic fault suite passed; its cases are not
all live infrastructure crashes. Security audit passed its high-severity gate;
two moderate development-test dependency findings remain.

The accepted family check used 10,392 input, 109,824 cache-read and 5,155 output
tokens; the delegation regression used 13,768 / 195,712 / 6,583 respectively.
These are actual reported model usage, not inferred from prompt lengths. Earlier
failed/debug runs and Snake are additional usage, excluded from those totals.

Queue delay under the deliberately one-request model limit is intentional, not
an estimate of default latency. The accepted fault-recovery turn completed in
about six seconds; its final text followed earlier Tool sampling. Valid paired
event measurements observed roughly 9–10 ms from the Pi text event to the SSE
client. These are a few API-client observations, not browser-paint percentiles.
WSL wall-clock jumps invalidated two cross-process timing decompositions; the
report flags them instead of publishing negative transport latency.

The native log restores semantic state, not JavaScript stacks or in-flight model
connections. No automatic replay of uncertain shell work is claimed. Owner loss
retires the physical Session family; an individual quiet child is managed as a
task, not interpreted as a lost distributed owner. Large live contexts still
consume memory; model permits and the soft admission watermark are not an OOM
guarantee.

## Cleanup and deployment

Both Workers were restored to four family slots, four global model permits and
four per-family model permits. Temporary limit overrides were removed. Six
acceptance/debug tenants and their records were removed after their resources
retired. Native Cube reports zero instances; the test Volume directory is empty.
The original 35 users, password records, model profiles and platform settings
match their pre-test digests. Pre-existing unrelated data was not purged. Kafka
records expire through normal retention, not a destructive shared-log reset.

# October 5 review: proposed improvement slices

Status: proposed, not implemented. Baseline: `5c2fcab4`.
This refines [R05-01–05](repository-review-20261005.md) after source and ADR rechecks.
Existing review files and runtime/deployment state are unchanged by this proposal.

## Ownership and scope

- Pi's public Agent/Tool APIs retain the loop, hooks and canonical Tool results.
- PostgreSQL retains Run/control and lifecycle admission authority. Controller
  ownership is distinct from the physical Session execution lease.
- Kafka retains Session ordering, dispatch commit, control propagation and seals.
- Cubelet retains accepted Tool lifetimes and physical reference recovery. Only
  the Control Plane decides VM lifecycle; absent replies never prove VM absence.
- No added service, queue, lease, Tool ledger or raw-result lookup. Protocol or
  lock-contract changes must have an approved ADR before implementation.

## Slice A — executable Volume recovery (R05-01)

The failure is a mismatch between the native recovery call and the fixed plugin.
Acquire precedes Attach. Failed Attach schedules PendingDetach with no metadata;
the binary adapter sends `{}`, but the POSIX plugin accepts only an empty argument
or its constant success metadata. Every later reconciliation repeats the rejection.

The POSIX plugin does not mount a host filesystem in Attach: it validates and
returns an existing Workspace path. Its Detach hook performs no physical unmount.
The constant `driver` metadata does not identify a physical mount to undo.

Proposed change:

1. Define this fixed plugin's Detach as an idempotent no-op that does not require
   successful-Attach metadata. Remove the irrelevant success-metadata equality
   check, retaining Volume/namespace/sandbox/request validation. Do not add a
   growing list of accepted legacy JSON spellings or fabricate success metadata.
2. Make the failed-Attach path explicitly use the existing pending-detach contract;
   remove misleading rollback naming/comments and expose cleanup-state write
   failure. Preserve the durable holder/pending state when cleanup is unconfirmed.
3. Complete the pending record only after the plugin succeeds. Preserve node
   incarnation/revision, shared holders and Master state reconciliation. No forced
   zero, Volume deletion, VM restart or quota release follows from this change.
4. Use the same cleanup path after restart; no new PG workflow/table is needed.

This contract is specific to the supported POSIX plugin. Other plugins must not
silently inherit a claim that their physical Detach needs no metadata.

Acceptance: canceled/failed Attach → retry → confirmed reference state and a
subsequent valid Attach; restart during PendingDetach; cleanup-state write failure;
shared Volume with another holder; old/duplicate reference observations. Tests
must compose Manager, real Bolt, binary adapter and the actual installed script.

## Slice B — bounded lifecycle transactions and independent renewal (R05-02)

Keep the owner SHARE lock and final PG-time ownership check. They close the
previous revocation race. The defect is keeping that common lock while waiting
indefinitely for one resource, thereby blocking the same owner's renewal.

Proposed change:

1. Put all lifecycle transactions holding this owner lock under a common PG-side
   lock, statement and whole-transaction budget. Apply settings before taking the
   owner lock. Include startup/retirement paths that can contend with them.
2. Use the remaining lease observed with PG time to refuse new mutations when
   insufficient renewal margin remains. Keep the same lock order, resource-owner
   predicates and final expiry check. Do not extend or revive an expired owner.
3. Separate owner renewal from the current `#markExpiredOwnersLost` resource
   updates and terminal-row maintenance. The renewal transaction should only
   verify/update its own owner row. Run cleanup through the existing maintenance
   mechanism in short, retryable batches. A locked terminal/resource must not
   roll back a successful owner renewal; derived terminal timestamps must never
   become a second authorization source.
4. Resource contention returns a retryable busy outcome after rollback; retry the
   existing immutable lifecycle intent with backoff. Unconfirmed COMMIT remains
   subject to existing reconciliation. Never retry a Cube effect inside the SQL
   callback, and never mistake a JavaScript Promise timeout for released PG locks.

The pinned PG image was checked locally: PostgreSQL 17.6. It supports
[`lock_timeout`, `statement_timeout`, `transaction_timeout`](https://www.postgresql.org/docs/17/runtime-config-client.html).
The first two abort statements; the last terminates an overlong transaction's
session. The connection must be discarded and COMMIT uncertainty treated
conservatively. Use transaction-local settings, not a database-wide timeout.

For the current 15-second owner lease / 5-second renewal interval, an initial
validation target is 500ms lock wait, 2s statement and 3s total transaction, capped
by PG-observed remaining lease and reserved renewal margin. These are proposed
test values, not measured performance guarantees. Slow normal work must be split
into bounded SQL batches instead of stretching the owner's critical section.
These budgets do not limit VM startup time or Bash duration: external effects
remain outside database transactions.

Acceptance: keep resource A locked beyond an entire lease; its mutation exits
within budget, owner renewal continues and resource B remains operable. Also test
a locked terminal during renewal, explicit owner revocation, slow queries,
transaction-timeout connection eviction, late COMMIT acknowledgement and retry
identity. No test may pass by removing the ownership lock or inventing VM absence.

## Slice C — one Tool outcome policy (R05-03 and R05-04)

These two findings share an adapter-level cause: Promise rejection, ordinary Tool
failure, cancellation request and infrastructure uncertainty are being treated
differently in different paths. Reuse ADR-0225's existing structured envelope.

| Evidence | Meaning | Worker handling |
| --- | --- | --- |
| Native final result, including an ordinary Tool error | Final Tool outcome received | Preserve result; Pi applies hooks and publishes canonical history |
| Structured `effect: not_started` | This operation did not begin execution | Preserve the confirmed negative outcome; no UNKNOWN cleanup merely because Stop raced it |
| Structured `effect: unknown` | Effects cannot be confirmed | Record unknown; refuse further sampling in this Run through the existing failure guard |
| No final evidence within the cancellation grace, or lost execution transport | Effects cannot be confirmed | Same unknown handling; retain inspection-before-repeat guidance |
| Cancellation request ACK only | Request accepted | Continue waiting for the original outcome; ACK is not completion |

Effect certainty and environment availability are distinct. A known not-started
rejection can still indicate an unavailable executor; its structured code may
block further sampling, while its Tool outcome stays not-started. During user
Stop, no subsequent sampling occurs regardless of which confirmed result arrives.

Proposed change:

1. Extract one small, typed outcome-classification policy at the trusted Worker
   adapter boundary. Keep the current mailbox/envelope; no extra durable record.
2. The cancellation waiter and disposal path must recognize a confirmed typed
   rejection as final evidence. Preserve not-started and ordinary final results;
   invoke unconfirmed cleanup only for an uncertain outcome.
3. Fixed Tools and Workflow reuse the same infrastructure-failure policy and
   existing `toolRuntimeFailure` sampling guard. Workflow's own script/business
   errors remain ordinary Tool errors. Transport closure is typed at its origin,
   rather than recognized later by parsing an error string.
4. Preserve Workflow's documented interactive connection lifetime and fixed
   Tools' independent Cube lifetime. Sharing classification does not grant
   Workflow automatic replay/restart, nor authorize VM destruction.
5. Keep operation IDs, original callbacks, native hook finalization and ordered
   cancellation/sealing. Late replies cannot reopen the completed Run.

Acceptance: matrix of both paths × native success/error, not-started, unknown,
lost reply and cancellation ordering. Check callbacks, canonical Tool content and
actual model request count. UNKNOWN must prevent request two; business errors may
continue normally. Include cancel ACK loss, final-result races, lost Workflow
socket and completed background-process survival.

## Documentation and bounded cleanup (R05-05 and review candidates)

Correct current architecture/ADR/plugin comments to describe Volume state
reconciliation and the migration's real removals. Keep versioned historical
reports as evidence; do not relabel an unimplemented proposal as deployed.

After behavior repairs, use separate small changes for:

- Cold native writer cleanup: bounded batches of candidate lease IDs, one active
  scan, PG active-Run checks and a fresh local-reference check before eviction.
- Volume lock cleanup: reuse Cube's existing `ResourceLocks` with context-aware
  waiting and reference-counted lock removal, preserving same-Volume exclusion.
- Deployment readiness: bounded wait for the expected Cubelet release/Pod before
  source/protocol checks, with diagnostic failure on timeout. Do not accept a
  still-ready old Pod as proof that the replacement is ready.

No extra hot-path PG cache or Kafka consumer is proposed. Binding and queue views
already avoid SQL on loaded lookups. Lifecycle/authorization checks remain PG
decisions; repeatable maintenance reads can be batched without changing authority.

## Follow-up: Read reply buffering

The owner questioned the two large-reply permits because output is already
bounded at the data source. Current code confirms that text Read/Bash bodies
use Pi's 50 KiB / 2,000-line bounds, while images use pixel/patch limits and
lossless PNG/base64. Source normalization does not make every image reply small.

An isolated synthetic check through the actual guest `processImageSource` used
1600×1600 flat RGB and high-entropy RGBA inputs, plus 3200×3200 high-entropy RGBA
for original detail. The noise bytes use xorshift32 with seed `0x12345678`.

| Fixture | Normalized PNG bytes | Base64 bytes before JSON envelope |
| --- | ---: | ---: |
| high, flat RGB | 11,243 | 14,992 |
| high, high-entropy RGBA | 10,259,814 | 13,679,752 |
| original, high-entropy RGBA | 41,035,801 | 54,714,404 |

These are synthetic size counterexamples, not representative screenshots or
memory/concurrency benchmarks. They do not establish two as the correct limit.

Every Read currently declares a 64 MiB possible reply and therefore takes a
large-operation permit before guest execution, even for tiny text files. The
permit is retained through completion delivery, including image upload and
Kafka acknowledgement. Cube's full-line buffers/copies and completion's JSON/
base64 decoding exist before S3 externalization. Kafka only receiving a reference
does not remove those earlier buffers.

Proposed direction: replace the tool-name-based global two-Read gate with
backpressure tied to actual image transfer/materialization. Ordinary text Read
must not wait behind image upload. Preserve source normalization and claim check;
reuse existing stream/S3 adapters where possible. Admission must occur before
large buffering, or image bytes must stream through bounded buffers; putting a
permit around upload after all bytes are allocated would not solve the problem.
Native image processing still needs memory within the guest/Worker.

Before implementation, measure mixed text/image workloads, peak host memory,
slow S3/Kafka and cancellation. Record any guest/native transport change in an
ADR. This is an additional proposed slice; no concurrency limit has been changed.

## Implementation and acceptance order

1. Record the agreed changes to ADR-0224/0225/0226 in a new current decision or
   explicit amendments before changing their contracts.
2. Implement Slice A, then Slice B, then Slice C, each with its regression tests.
   Replace review-only characterization assertions with desired-behavior tests in
   the owning package; remove obsolete duplicate paths rather than adding fallback.
3. Correct current docs and measure cleanup/query changes separately.
4. Run package tests, full checks, native Bolt/MySQL/plugin contracts and the fault
   matrix. Before a later matched rollout, validate owned real Cube shared-Volume
   recovery, controller replacement and cancellation with GPT-6 Luna.
5. Build matching native/plugin/application artifacts and verify identities. Data
   reset is not required by these fixes. Rollout scope and evidence belong to the
   implementation task; this proposal has not performed a deployment.

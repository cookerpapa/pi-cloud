# ADR-0227: Recovery isolation and consistent Tool outcomes

Status: implemented and deployed, 2026-10-05.
[Verification and matched release](../reports/review-improvements-20261005.md).

The owner approved the [October 5 review improvements](../reports/review-improvement-plan-20261005.md)
and explicitly requested relaxing the two large-reply permits. Preserve the
current PG, Session Kafka, Pi public SDK, Cube, Volume and attachment authorities.
This amends ADR-0224/0225/0226; it introduces no extra execution service or ledger.

## Adopted mechanisms

Reuse the pinned Cube Volume manager, Bolt holder/pending state, actual fixed
POSIX plugin and Cube's existing context-aware `utils.ResourceLocks`. The source
and alternative-controller survey in ADR-0226 still applies. Detach for this
plugin has no physical unmount: success-only constant metadata cannot be a
precondition for undoing a failed Attach. Keep request identity checks and
pending-state completion after successful cleanup, including shared holders.
Expose rollback-state failure instead of swallowing it. Do not generalize this
no-op contract to other Volume drivers or infer safe deletion from count alone.

Use PostgreSQL 17's existing
[lock/statement/transaction timeouts](https://www.postgresql.org/docs/17/runtime-config-client.html)
for short lifecycle transactions. The pinned official image is PG 17.6. A new
lock service, scheduler or JavaScript timeout around uncancelled SQL would not
preserve the required lock release and ownership semantics. PG remains the
decision clock; preserve owner SHARE locking, resource CAS and final expiry
validation. Bound total transaction lifetime as well as individual statements,
with margins derived from the configured lease. Expired ownership remains fenced.
Timed-out connections must be retired; uncertain COMMIT is reconciled, not replayed
as an external effect.

Owner renewal must not wait for unrelated resource maintenance. Expiry/cleanup
uses the existing lifecycle maintenance path and current resource records.
Copied terminal heartbeat/deadline fields are not an additional authority.
No Cube/network operation runs inside the PG transaction. Resource contention
is distinguishable from actual loss of ownership and is retryable through
existing control recovery.

## Tool outcome policy

Retain the v2 boot-reply envelope. A native final Tool error is still a final
reply, and a typed `not_started` failure confirms absence of execution. Stop must
not turn either into UNKNOWN merely because a Promise rejects. UNKNOWN remains
necessary for genuinely unknown effects or missing final replies. Cancellation
acceptance ACK is never final evidence; completed results win cancellation races.

Fixed Tools and Workflow use the same trusted-adapter infrastructure policy.
Preserve business Tool failures and native hooks; typed infrastructure loss or
unconfirmed transport failure closes further sampling through the existing Run
guard. Classify transport failure at its origin, never by parsing user output.
Effect certainty and executor availability remain separate. Workflow keeps its
interactive transport lifetime; fixed Tools keep their independent Cube lifetime.
Neither uncertainty nor Stop authorizes VM deletion, quota release or shell replay.

The native manager's pre-driver cancellation has the distinct failure code
`tool_cancelled_before_start`. A driver interruption called `tool_cancelled`
may have executed effects and remains UNKNOWN at completion. Do not infer
non-execution from the ambiguous name. PG migration 175 removes the unused
terminal heartbeat/deadline mirrors; controller identity is their sole owner.

## Read concurrency and bounded maintenance

Increase native large-reply permits from two to eight, retaining the existing
overall outstanding-operation boundary and bounded reply lifetime. Eight is an
initial fourfold relaxation, not a claim of measured fleet capacity. Ordinary
text and large image replies must be tested together with blocked delivery and
cancellation. Per-reply 64 MiB framing and source Pi text/image limits remain.
At eight permits, possible serialized large replies alone can total 512 MiB;
copies, decoder memory and guest/Worker image processing are additional.
Do not disguise a count increase as removal of full-frame buffering.

The owner chose widening for this slice. Actual-image streaming/backpressure
needs its own measured transport change; no new upload protocol is added here.
Reuse native resource locks with lifecycle collection; batch cold-writer PG
reads and suppress overlapping sweeps. Readiness waits must identify the expected
Cubelet release before verifying source/protocol identity. These changes add no
durable queue or compatibility path.

## Acceptance and release

Validate actual POSIX plugin plus Bolt after Attach failure/restart and shared
holding; blocked resource/terminal versus renewal and unrelated admission;
revocation, whole-transaction timeout and connection recovery; native/business/
not-started/unknown outcomes and cancellation races; actual next-model-request
counts after Workflow failure; more than two simultaneous reads, slow delivery
and ordinary Tool isolation. Preserve original unknown/history data.

Run full checks and native/fault suites. Any rollout must use matching patched
Cube, POSIX script and application build identities. Public/native Tool wire is
unchanged; source identity checks still reject mismatched artifacts. No data
reset is required. Rollback uses matched artifacts and schema state. Record
verification and rollout status separately; acceptance is not deployment proof.

# ADR-0216: bounded presentation and image data paths

Status: accepted for implementation, 2026-10-03, following the owner's approval
of the [October 3 review](../reports/repository-review-20261003.md).

## Preserved ownership

PG remains Run/control authority; one physical Session owns its writer and Kafka
partition path. Keep native Pi hooks, exact append projection, consumption receipts,
closure admission and Cube scope fencing. No additional broker, consumer group,
workflow engine, image archive, compatibility protocol or default product quota.

## Reuse before build

Use pinned AWS SDK 3.1141.0 / Smithy HTTP transport for socket inactivity and
connection deadlines, with its [supported handler configuration](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/node-configuring-maxsockets.html).
An idle deadline is not a total file-transfer deadline. Reuse Node async iterables,
existing S3 GET/PUT and Cube's temporary-file upload endpoint; neither a new blob
service nor resumable-transfer ledger is required. Existing PG row locks and
`clock_timestamp()` remain cancellation authority. No new infrastructure dependency.

## Changes

1. Streamed S3 traffic gets connection/inactivity deadlines, including the final
   PUT receipt. Existing upload cancellation joins both sinks before claim release.
2. Cancellation selection, claims and retries use PG time. Optional verification
   reminders certify the last completed mutation generation, never stale success.
3. Native append projection reads only affected Lane heads after its existing
   Session lock. Preserve exact sequence, identity, parent and replay validation.
4. Queue presentation refresh is disposable work, separate from the awaited
   Projector callback. Coalesce by Session/version in bounded local memory;
   ownership generations discard stale completions. Failure/capacity exhaustion
   requests browser resynchronization, not Kafka retry or input loss. Keep a small
   dedicated read pool with database/query deadlines so display work cannot occupy
   the publication/lifecycle pool. Shutdown joins this bounded work.
5. Public queue reads and SSE deliver a page of at most 20 complete input records
   plus `afterPosition` and `hasMore`. Continuation reads carry the observed
   `viewVersion`; a changed version returns conflict instead of combining different
   orders. The browser can load more, retains edit drafts on refresh/conflict, and
   accepts a newer first-page snapshot by invalidating older continuation pages.
   This limits one response, never total queued inputs. Matching API/Web deployment
   replaces the old unpaged response; no old-wire fallback. Mutations retain their
   current optimistic edit revision and durable idempotency identity.
6. Original image normalization consumes a length/hash-verified stream through
   the existing provider port. Always close S3 input on consumer failure, early
   return or cancellation. Cube still normalizes before native ImageContent; final
   normalized bytes remain subject to existing model/transport budgets. No S3
   management credential enters the guest, and no mutable Workspace fallback.

## Acceptance

Prove idle versus progressing uploads, lost receipts and cancellation; positive
and negative app-clock skew and concurrent cancellation claims; overlapping
verification/mutations; unrelated Lane count independence with post-lock freshness;
slow queue reads versus ordered processing, bounded coalescing, reset races,
pagination/reorder/edit/steer and drafts; streamed image backpressure, corruption,
short reads, consumer failure and guest cancellation. Compare transferred rows and
bytes under fixed synthetic work. Complete matching schema/API/Worker/Cube/Web
checks before rollout; preserve real VM and conversation assets.

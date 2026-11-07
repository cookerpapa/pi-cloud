# ADR-0303: Direct renewal and local execution authority

Status: accepted for implementation, 2026-11-07. Source and live acceptance are
pending. This is the evaluation and implementation decision for Issue #10.

## Evaluation

Management availability must not determine the lifetime of healthy active work.
The Worker already renews its physical Session leases directly in PostgreSQL;
its reconnecting registration socket sends no family renewals. Retryable socket
loss leaves the native family running, and registration expiry preserves a
credential-valid Worker with fresh direct-renewed executions. Moving renewal to
the management process would introduce the very outage dependency being removed
by the runtime separation.

Kafka fencing alone is insufficient. A broker does not observe PostgreSQL lease
expiry, and a management outage can delay ordered closure indefinitely. An old
Worker could otherwise keep calling providers while no successor initializes the
same transactional producer. Letting expired owners continue until closure would
also contradict `active_execution_scopes.valid_until` and the existing Tool
admission checks. We retain expiry as a local loss of execution authority, not
merely as permission to attempt takeover.

The periodic observer SELECT repeats the authoritative renewal predicates:
tenant, physical Session, lease/writer identity, fencing token, unexpired lifetime
and absence of release, writer failure or seal. Renewal also checks the owning
Worker is ready. The observer SELECT is therefore removed from the active path;
cold admission still obtains fresh PG evidence. This deliberately changes the
latency for discovering a silent PG revocation from about one second to the next
direct renewal, normally twenty seconds. It does not postpone a locally known
expiry, Stop, writer failure or owner shutdown. A stalled renewal cannot extend
the last confirmed deadline, normally at most sixty seconds from its request.

## Decision

1. Keep one PG-issued renewable lease per physical Session and direct Worker PG
   renewal. Keep bounded connection/transaction waits, nonblocking batch locks,
   explicit deferrals, post-lock PG decision time and fail-closed renewal errors.
   Management registration and physical-health probes do not renew that lease.
   Remove the unused registration-side family-renewal handler, its coordinator
   connection guard and lease-duration option. Registration heartbeats must carry
   `families: []`; a nonempty list is rejected instead of enabling a second path.
2. Keep one shared Worker-local authority for all native Conversations. A cold
   open coalesces its PG authorization read; only committed, identity-checked
   renewal acknowledgements extend an active deadline. Local deadlines use the
   request's monotonic start time plus PG's remaining lifetime, never receipt time.
   Active expiry has its own timer and is also checked synchronously at effect
   admission. Late acknowledgements, deferrals and wall-clock jumps cannot revive
   an expired owner. Cold checks and explicit transactional checks remain fresh.
3. Propagate a known Kafka producer failure to the whole family immediately,
   including a failed probe or keepalive on that producer. Do not wait for the
   next renewal to abort native work and revoke every family model grant. A missing
   physical probe reply is still only an observation; it never triggers this
   failure path, VM destruction, arbitrary Tool replay or quota release.
   A silent broker fence is discovered on the next same-producer publication,
   including the existing quiet-Session probes. Immediate propagation starts
   when that failure is known, not when an unobserved broker event occurs.
4. Recheck authority after asynchronous model preparation and synchronously in
   the existing Worker-local Model Gateway immediately before provider admission.
   The Gateway consults the same local authority, with no new PG request, lease,
   CPA fencing view or token TTL. Owner abort cancels all its current upstream
   transports. Several native children can have requests in flight. Cancellation
   cannot retract requests already accepted by the provider or guarantee that
   their computation/billing stops.
5. Preserve PG authorization before and after transactional producer initialization,
   the stable physical-Session transactional identity, fatal/uncertain producer
   latching and ordered closure before replacement. A stale delayed initializer
   may fence a valid producer, but fails post-init authorization and cannot publish.
   Neither writer automatically reinitializes or replays an uncertain batch.
6. Preserve independently fenced Tool admission, ordered Stop/native settlement,
   and physical cleanup evidence. Silent PG revocation may take a renewal interval
   to reach a waiting Worker; revoked effect admission and producer takeover do
   not wait for that observation. Local revocation never authorizes a successor.

This retains the existing PostgreSQL, Kafka and AbortSignal primitives rather
than adopting a second coordination framework. Existing build-versus-adopt and
failure evidence is in [ADR-0247](0247-session-work-and-tool-dispatch.md) and
[ADR-0258](0258-bounded-session-lease-renewal.md). The pinned native Kafka client's
generic `event.error` callback omits reliable fatal/code metadata; transaction
callbacks preserve the decisive failure evidence. We do not parse error messages
or treat ordinary network observations as fatal. No new scheduler, durable state,
external service, storage schema or public protocol is introduced. The narrowed
private heartbeat contract uses a drained matched application release; no legacy
renewal fallback is retained.

## Acceptance and release

- Healthy direct renewals outlive a prolonged management outage without periodic
  observer reads; missing/rejected renewals isolate the affected family.
- PG stalls, expiry, lock deferrals, stale late acknowledgements and event-loop
  delay cannot revive or prolong active authority. Slow cold opening remains safe.
- Kafka fencing/uncertain publication, including probe publication, aborts the
  shared family and its model transports before another renewal; definite
  pre-enqueue rejection remains distinct. No reinitialization or batch replay.
- Delayed old/new producer initialization retains both PG checks and the valid
  writer's ordered recovery contract.
- Model preparation/permit waits and local HTTP buffering cannot bypass expiry;
  multiple long provider calls are cancelled on shared-owner revocation without
  claiming they were never accepted upstream.

Root validation runs serially on the constrained build host. A drained matched
release and relevant live outage/recovery acceptance are required; source tests
alone do not establish deployment or physical-resource preservation. Rollback
uses a drained matched application set, with existing PG/Kafka/Volume authorities.

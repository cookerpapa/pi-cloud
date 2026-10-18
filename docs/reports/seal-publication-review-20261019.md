# PG Outbox → Kafka Session seal review

Started 2026-10-18; completed 2026-10-19 (Asia/Shanghai).
Reviewed revision: `596f9b9245e392c56a1038b9b94e6180cc47bedc`.
Unchanged release baseline: `control-expiry-c9d8112d`, schema 190.

Scope: the persisted seal request, Outbox claim/retry, Control Plane publication,
PG authorization, routing revocation, Kafka producer takeover and publication
receipt. Projector closure/checkpoint materialization and successor bootstrap
remain the next focused walkthrough segment.

This review changes documentation and isolated characterization tests only.
It changes no runtime, schema, protocol or deployment. Checks use disposable
local PG/HTTP/Kafka and substituted callbacks; no production fault, native crash
experiment, model call or VM operation was performed.

## Current flow

1. The previous hop atomically saves the `execution_seal` request in PG. The
   existing Outbox relay wakes on a PG notification or its periodic sweep.
   Defaults are a one-second poll, 30-second claim and 16 concurrent deliveries.
   One SQL statement selects eligible heads with `FOR UPDATE SKIP LOCKED`,
   increments `attempts` and moves `available_at`. That statement finishes before
   Kafka delivery; no PG row lock/connection spans the network wait.
2. The Control Plane sends the request to the current Session partition owner:
   locally when it owns that partition, otherwise through the internal HTTP
   forwarding client. This is control publication, not the removed Worker log
   ingress. Ordinary Workers still publish directly to Kafka.
3. `PostgresPublicationControl` checks the exact persisted request, old Session
   lease and Run closure intent. Already-projected closure returns the original
   receipt without initializing another producer. Otherwise it closes the old
   writer's Tool routing before attempting the Kafka seal.
4. A temporary `KafkaSessionWriter` uses the **same stable transactional ID** as
   the physical Session's Worker. Kafka initialization fences the old producer.
   PG is checked immediately before and after initialization; the later check
   prevents a delayed obsolete initializer from publishing after its PG authority
   changed. Kafka's producer epoch and PG's Session lease epoch are different.
5. The seal commits on the same Session partition, coupled to the current
   Projector consumer group through `sendOffsetsToTransaction`. The transaction
   uses the current dispatch boundary; it does not independently advance or
   rewind the Tool dispatch offset.
6. After a matching durable receipt, the relay marks the Outbox row published,
   conditional on its `attempts` value. A stale claimant cannot overwrite a
   newer claimant's acknowledgement or retry state. Failed delivery retries the
   same immutable Fact ID; it does not create a new execution command.

**Kafka acknowledgement is not PG-projected closure.** The next hop still has
to materialize the ordered seal and eligible release before a new PG lease can
be issued. This hop neither increments the successor's PG epoch nor proves that
a physical Tool process has stopped.

The architecture remains consistent with ADR-0247. Findings below concern bounded
waiting, connection discovery and resource lifetime, not a new queue or execution
authority.

## Findings

### SP-01 — P2: PG waits can stall publication and graceful shutdown

The relay claim/receipt/retry/cleanup queries and the publication authority reads
use the ordinary Control Plane database pool. `main.ts:133` configures 12
connections without a checkout or statement budget. ADR-0259's bounded maintenance
pool is separate and is not passed to this path. The relay's abort signal stops
future polling but does not cancel its pending SQL. `close()` joins that SQL and
all active publications before proceeding.

A disposable real-PG test holds the Outbox table lock, observes the relay claim
waiting in `pg_stat_activity`, and calls `close()`. After at least 1,250 ms,
close is still pending and **the relay's own** health check still reports ready.
Releasing the fixture lock allows completion. The fixture has its own ten-second
watchdog; that is not a production timeout. The measurement establishes waiting
under contention; the missing application bound is established by source. It
does not establish an infinite live outage or the whole Control Plane's readiness.

There is related ownership coupling. Pending seals are coalesced by tenant/Fact
ID, not partition generation. In a controlled PG-result schedule, the partition
is reassigned while its old authorization read is pending. A call from the new
local ownership generation borrows the old promise, then receives the old
`not_owner` failure. A fresh retry succeeds. PG itself is responsive during the
held callback. Coalescing prevents duplicate concurrent work, but cannot make
progress while the old operation is unbounded; this is not an incorrect write
authorization.

Locations: `runtime-core/src/session-outbox-relay.ts:67`, `:73`, `:118`, `:153`;
`postgres-publication-control.ts:31`, `:63`, `:107`;
`control-plane/src/main.ts:133`; `database/src/client.ts:49`.

Repair direction: use the existing bounded database facilities for this control
publication path, including pool acquisition, lock waits, receipt writes and
cleanup. Preserve Outbox retries and uncertain-commit handling. Retirement should
stop admission and drain old work before a fresh owner starts a replacement.
Do not merely race SQL against a timer while leaving it alive, or change the
pending-map key to permit overlapping same-Session producer initialization.

### SP-02 — P2: consumer restart does not join every publication using it

`KafkaLogConsumer` tracks and retires partition `KafkaPublicationWriter`s before
disconnecting its reader. A forced Session seal instead creates a
`KafkaSessionWriter` in `PostgresPublicationControl` and borrows the reader through
`publicationTransaction()`. That external transaction is not registered in the
consumer's retirement set.

The reader has a partition commit lock, but `disconnect()` joins message handlers
and ordinary offset commits without joining outstanding publication locks. It
can therefore finish disconnecting while `sendOffsetsToTransaction` is pending.
When that callback later completes, `commitPublication()` currently requests
`commitTransaction` without another generation check.

Two safe callback tests use the actual reader with a fully substituted native
client/producer:

- A send still pending at retirement is correctly rejected before the group
  transaction. This existing guard is retained.
- When the group-offset callback is pending, reader disconnect completes first.
  Releasing the callback then requests a commit on the substituted producer.

This establishes a lifetime/ordering gap, **not a successful stale broker commit,
data loss or native crash**. The real Kafka callback schedule and its consequence
were not forced. The proposed repair can be verified without a crash experiment.

Scope matters: normal `SessionProjector.close()` already closes publication
control before closing the consumer. The uncovered path is the consumer's own
background error/restart, which does not execute that whole-Projector shutdown
sequence. A normal partition rebalance does not necessarily destroy the native
reader; the finding is not that every rebalance is broken.

Locations: `event-log/src/kafka-log-consumer.ts:183`, `:418`, `:641`, `:653`;
`kafka-partition-reader.ts:367`, `:402`;
`runtime-core/src/session-projector.ts:113`, `:441`.

Repair direction: account for all transactions borrowing the reader, stop new
admission and join their bounded completion/abort before releasing that reader.
Recheck ownership after awaited group work as appropriate. A generation check
alone does not replace resource-lifetime management. Keep the existing stable
Session producer identity, group transaction guard and dispatch commit ordering.

### SP-03 — P2: failed peer connections retain an obsolete owner address

`HttpPublicationClient` caches redirect destinations by physical Session. It
clears a cached address after an explicit `not_owner` response, but a transport
failure leaves the address cached. An exited peer cannot send that response.
Every subsequent Outbox retry can therefore reconnect to the same dead address.

The isolated HTTP test first obtains a redirect to owner B. B is then normally
closed and the discovery endpoint points to C. Three retries of the same new
Fact all fail: the old client performs no new discovery and C gets no request.
A fresh client using the same discovery endpoint publishes that same Fact to C.

This confirms the owner-cache case already deferred in the reliability backlog.
Its persistent impact requires a surviving forwarder and a replaced peer, such
as a multi-Control-Plane deployment. The maintained single-Control-Plane baseline
does not establish this as a current production incident: when the whole process
is replaced its cache disappears, and local ownership bypasses forwarding.

Location: `runtime-core/src/http-publication-client.ts:45`, `:65`, `:77`, `:89`.

Repair direction: invalidate an obsolete route after a transport failure and
rediscover within a bounded retry policy. Preserve the immutable Fact ID and
distinguish an unknown acknowledgement from proven non-delivery. Do not retry
arbitrary Tool effects or add a second service registry.

## SQL and retained safeguards

The measured local-owner fixture has one seal, no sandbox bindings and no
pending bootstrap control references. Actual PG calls are traced; only the
Kafka writer is substituted. From relay claim through publication receipt:

| SQL | Purpose |
| --- | --- |
| 1 | Claim the existing Outbox record |
| 2 | Validate the persisted request before closing routing |
| 3 | Close bindings for the old writer; zero rows in this fixture |
| 4 | Recheck PG before Kafka producer initialization |
| 5 | Recheck PG after Kafka producer initialization |
| 6 | Mark the same Outbox record published, using the claim CAS |

This is **six client SQL statements**, including three separate authority reads,
not six per token or Tool call. Active bindings can add propagation work, and
background notification/cleanup traffic is excluded. It is not a universal
whole-recovery SQL count or a latency benchmark.

The three reads straddle different side effects and waits. This review found no
basis to replace them with an unversioned cache or delete the post-init check.
The first also protects already-closed evidence from unnecessarily fencing a
successor. The higher-value change is bounded progress, not fewer authorization
reads at the expense of recovery correctness.

## Verification and limits

- **46 existing tests across eight files pass**, covering Outbox ordering/CAS,
  partition publication, Projector handoffs/readiness, Session writer lifecycle,
  commit isolation, PG seal admission and refusal classification.
- **Six characterization tests across two files pass**: stale route, PG wait,
  ownership coalescing, SQL trace and two reader-retirement schedules. These
  assert the reviewed behavior; they are not repaired-behavior regressions.
- **One existing real RF3 Kafka + PG integration case passes**: direct writes
  during Control Plane replacement, old-producer fencing, same-Run successor
  claims, already-closed seal replay and delayed-initializer rejection followed
  by ordered recovery. This is not a complete replacement or model/VM acceptance.
- The first combined run passes all 46 existing cases and three PG/HTTP probes;
  its SQL probe fails because the fixture also contains a bootstrap control
  reference and the probe incorrectly sends it to its seal-only stub. Marking
  those fixture references already published before measurement and enforcing
  the Fact kind corrects the probe. The complete six-case repeat passes. A later
  HTTP-only repeat also passes after explicitly reusing one Fact ID for all retries.
- Strict experiment typecheck passes after correcting stub types/overloads;
  formatting, documentation checks and diff checks pass. All disposable test
  containers/networks are cleaned. No production state was changed.

Evidence: [sanitized results](seal-publication-review-20261019.json) and
[reproduction instructions](../../scripts/experiments/review-seal-publication-20261018/README.md).
No runtime repair is included. Next walkthrough: **Kafka seal → Projector → PG
closure/checkpoint/release**, followed by successor Worker bootstrap.

# ADR-0259: Control Plane expiry progress and failed Worker retirement

Status: accepted for implementation, 2026-10-18. The owner approved the repair
plan for CPE-01/02/03/O1 in the [review](../reports/control-plane-expiry-review-20261018.md).
Baseline: `b9338bc8`. Verification and deployment are not yet complete.

## Decision and adoption

Retain primary PG authority, one physical Session owner, native Pi continuation,
existing Outbox publication and ordered Kafka closure before a successor grant.
Reuse [PG nonblocking row locks](https://www.postgresql.org/docs/18/sql-select.html#SQL-FOR-UPDATE-SHARE),
the pinned [node-postgres pool](https://node-postgres.com/apis/pool) and ADR-0258's
bounded checkout adapter. These provide the required lock/transport isolation;
another scheduler, queue, cache or event stream would duplicate authority.

1. Session expiry, management maintenance and remote retirement advance in
   independent, nonoverlapping loops within the existing Control Plane process.
   Short expiry/admission transactions use a dedicated small direct-PG pool with
   five-second acquisition and checkout budgets. Actual eviction terminates an
   expired connection; a Promise timeout is insufficient. Remote stop/inventory
   remains outside transactions and retains its existing budgets.
2. Select bounded Session candidates directly from current execution scopes,
   excluding closure already durably requested. Page by a stable identity with
   a disposable rotating cursor; advance past busy candidates and wrap to retry.
   The cursor is neither authority nor a receipt and need not survive restart.
   Preserve lifecycle lock order. NOWAIT failure rolls back the whole candidate
   transaction, releasing earlier locks, before moving on. After locking, check
   exact Run/Session/Worker/lease/Fence and fresh PG time. No expiry snapshot can
   revoke an owner renewed before the decision. No timeout proves closure.
3. Management maintenance admits failed Workers without an existing retirement
   into the existing durable retirement flow, even if their connection is live.
   Under Host/Worker/connection locks, verify the exact Boot, fence its connection
   and insert one idempotent retirement with reason `worker_failed`. This does
   not revive failed Workers, confuse connection health with execution health,
   or retire a healthy Worker because a single Session expired. Restart and
   uncertain commit recover by rereading PG, never blindly replaying SQL.
4. Remove the unconditional all-family idle-release pass from expiry. Normal
   completion and ordered seal projection already release eligible physical
   owners in the same transaction as their closure evidence. Regression tests
   establish these paths before deletion. Retain the physical ownership rows
   until closure; pending seals are excluded from admission, not released early.
   Reuse transaction-local locked facts for seal/scope updates, preserving exact
   identities and conditional updates. No cross-request authority cache.

Add `worker_failed` to existing internal retirement/connection reason constraints
with a matched schema/application migration. Do not change native Storage, Kafka
wire schemas, guest Tools, model execution or public browser contracts. The
maintained drained release applies; preserve accounts/configuration/credentials.

## Acceptance

- Locked healthy Session, expired candidate or Host cannot indefinitely block
  unrelated expiry. Busy candidates beyond a full page eventually get examined;
  after unlock they are retried. Two controllers cannot duplicate admission.
- Eleven Workers continue past ten pending seals without projecting/releasing
  them first. A fresh successor remains forbidden until ordered closure.
- Failed connected Worker enters retirement exactly once; live heartbeat cannot
  revive it. New Boot, reconnect, controller restart and lost commit replies
  preserve identity. Healthy idle/busy Boots retain their existing reconnect.
- One expired Session among 1/8/64 Sessions has constant SQL cost independent
  of healthy siblings. Normal and forced closure still release eligible owners;
  unsealed owners are retained. No speculative orphan-cleanup path is added.
- Real PG pool/transport/row-lock failures terminate queries/transactions and
  allow drain. PG-time renewal races, native family recovery and unsafe Tool
  non-replay remain covered by existing and new fault tests.
- Complete source, transport, fault, scanned matched release and relevant live
  acceptance, with physical fixture cleanup and configuration preservation.

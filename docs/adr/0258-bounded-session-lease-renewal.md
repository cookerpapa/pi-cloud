# ADR-0258: Bounded Session lease renewal and local revocation

Status: implemented, verified and deployed, 2026-10-18, as
`session-lease-079dbddc`. [Delivery evidence](../reports/session-lease-repair-20261018.md)
records source/artifact gates, live recovery, the retained upstream TLS sample
and confirmed configuration/physical cleanup. The owner approved repairing
WLR-01/02/03 in the [review](../reports/worker-session-lease-review-20261018.md).
Baseline: `ddc404f8`; artifact/runtime source: `079dbddc`.

## Decision and adoption

Retain PostgreSQL as the only execution authority, one lease per physical
Session, direct Kafka publication and ordered closure before takeover. Reuse
[PostgreSQL nonblocking row locks](https://www.postgresql.org/docs/18/sql-select.html#SQL-FOR-UPDATE-SHARE)
and the pinned [node-postgres pool](https://node-postgres.com/apis/pool), including
acquisition timeouts and destruction of an unhealthy checked-out connection.
The installed pg/pg-pool source confirms release with an error removes and ends
the connection; an active query is terminated, not left running in the pool.
The adapter also destroys the exposed pg socket on bounded-checkout failure,
because ending an idle connection is otherwise graceful and can wait for a peer.
These existing primitives fit the measured gap. A separate lease scheduler,
queue or lock service would duplicate PG authority and is not adopted.

1. An active observer independently schedules expiration of its last confirmed
   monotonic deadline. A pending read cannot suppress that timer. Active checks
   also enforce it synchronously after event-loop delay. Cold bootstrap still
   obtains fresh authority before activating; stale cold cache alone does not
   establish PG revocation. Late replies cannot revive an expired/closed owner.
   Pending callers observe local abort and observer close does not await a read.
2. Production Workers use a dedicated two-connection PG pool for lease identity,
   renewal, quarantine and observation, separate from history/admission queries.
   It reuses the existing direct-PG notification endpoint (without LISTEN), so
   connection destruction and startup timeouts do not rely on a PgBouncer policy.
   Acquisition and each connection checkout have 5-second budgets; checkout
   covers the entire SQL transaction including COMMIT. Server statement and idle
   transaction limits supplement actual client eviction at the checkout deadline.
   These are execution-authority I/O limits, not product quotas. Failed/uncertain
   transactions are never automatically replayed; existing explicit rolled-back
   deadlock/serialization retries remain. A lost renewal COMMIT response supplies
   no usable new lifetime even if PG committed it.
3. On fatal renewal failure, reject new local work and revoke current local
   executions before awaiting bounded PG quarantine. Existing controller expiry
   and ordered closure finish durable recovery if quarantine fails. Local abort
   never proves guest death, releases quota or bypasses a seal.
4. Renewal locks available lease rows with `FOR NO KEY UPDATE SKIP LOCKED`.
   A subsequent statement uses fresh PG decision time, checks the complete
   reported identity and updates only those locked rows. Eligible but unlocked
   owners are deferred. Invalid, expired, failed or closed owners are rejected.
   The success path retains three business SQL statements per nonempty batch.
5. The private heartbeat acknowledgement requires `familyLeaseDeferrals`, an
   array of lease/Fence identities disjoint from `familyLeaseRenewals`. Both
   consumers validate scope. Deferral neither advances an observed deadline nor
   suppresses PG revocation observation. Missing from both arrays means rejected.
   The Worker retries a batch containing deferrals after at most one second;
   ordinary successful batches retain their 20-second delay/60-second lease.
   Busy physical Sessions therefore do not delay healthy siblings. Actual query
   errors retain their current fail-closed policy.

The acknowledgement change is a matched private API change with no legacy
decoder/default. Replace Control Plane and Worker together while drained. No
PG migration, execution Topic, native log, public browser, guest or reply schema
changes. Rollback requires a matching old application set while drained.

## Acceptance

- Pending observation, pool acquisition, query/COMMIT return and quarantine
  cannot indefinitely hold local authority or reuse an expired connection.
- Expiration/revocation wins over late results; fresh renewals reset active
  deadlines; cold refresh, sibling isolation and shared-Lane ownership remain.
- A locked A does not block B; A can renew after unlocking before expiry, but
  never after expiry. Foreign, closed and mismatched owners are not deferred as
  usable grants. Deferrals do not refresh observer age or deadline.
- Exercise real PG row locks, pool exhaustion, stalled transport, uncertain
  COMMIT and expired checkout; verify rollback/connection cleanup independently.
- Run repository/transport/fault gates, scanned matched release, relevant real
  Luna/Cube/input/image and management-outage recovery checks. Preserve original
  accounts/configuration/credentials and confirm fixture physical cleanup.

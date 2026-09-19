# ADR-0131: Run is the PostgreSQL execution queue

Status: accepted; readiness and execution identity follow ADRs 0179–0180.

`runs` is the sole execution queue. API admission commits the input, immutable
configuration and Session mailbox position. `ready_at` marks a Lane head whose
dependencies have closed. Workers with local capacity select ready work using
`FOR UPDATE SKIP LOCKED`, then atomically bind its Session owner and mark the Run
running. There is no execute Command, execute Outbox or separate Attempt queue.

LISTEN/NOTIFY is a wake hint; polling covers lost notifications. Same-Lane FIFO
and physical Session ownership remain durable. Global selection uses eligibility
and mailbox ordering; tenant fairness is not claimed without a measured policy.
Failure after admission closes that Run rather than automatically replaying it.

Cancel/Steer inputs live in `turn_control_requests`. Their delivery bookkeeping
does not create another Agent execution identity. Terminal Outbox rows remain:
PG must record the requested outcome before retrying its immutable seal into
Kafka. A business terminal is not permission to skip that seal's projection.

This adopts PostgreSQL's queue-table/index/notification pattern, also used by
Graphile Worker and pg-boss. Adding a second job lifecycle would not remove the
Session ownership and external-effect closure contract. Keep one authority
rather than synchronizing a framework's job state with a separate Run state.

Upgrade uses the current deployment guide, not an old blanket data reset. Drain
inputs, owners and seals; migrate and replace matching services without a legacy
runtime decoder. Version-specific historical cutovers remain in Git history.

References: [PostgreSQL queue locking](https://www.postgresql.org/docs/current/sql-select.html),
[notifications](https://www.postgresql.org/docs/current/sql-notify.html),
[Graphile Worker](https://worker.graphile.org/docs/sql-add-job),
[pg-boss queues](https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md).

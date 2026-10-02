# ADR-0213: control recovery and propagation budgets

Status: implemented and deployed, 2026-10-03.
[Verification and deployment evidence](../reports/control-recovery-repair-20261003.md).
Scope: [October 2 findings](../reports/repository-review-20261002.md), R02-01–04
and bounded O02-01–05 improvements. No new execution authority, broker, scheduler
or shared-resource broadcast service is introduced.

## Reuse and invariants

Keep ADR-0212's PG Outbox, Session ingress/group, bounded owner views and native
dispatch boundary. The existing [PG trigger contract](https://www.postgresql.org/docs/current/trigger-definition.html)
and [commit-time notification contract](https://www.postgresql.org/docs/current/sql-notify.html)
provide the required atomicity/wakes. Debezium/Kafka Connect would add deployment
and recovery ownership for changes already atomically recorded by this bounded
Outbox; another work queue would compete with PG. Extend the existing adapters.

### Quarantine commits before publication confirmation

Close local admission first. A transition of a physical resource to UNKNOWN
atomically closes its current physical bindings in PG, including the existing
control references. Use a resource-state trigger so direct controller and
dispatcher failure paths obey the same rule. A stale callback must not rewrite
the physical identity of a replacement resource.

After commit, explicitly confirm the binding changes through the existing owner
barrier and Kafka path. Failure leaves committed quarantine and retryable Outbox
work, not RUNNING state or false confirmation. PG failure retains local rejection
and is retried by existing lifecycle maintenance. Normal Tool errors, absent
probes and uncertain routes still cannot delete a VM or release quota.

### Readiness, scheduling and views

Listening, control/API availability and ability to publish for an assigned
partition are distinct. Worker admission must use available publication owners
and initialized views, without requiring unrelated partitions' projection to
catch up. Readiness remains a disposable admission hint; PG and fences still
decide ownership, and failures racing the hint retain the existing no-replay rule.

The private publication health response carries a bounded partition mask. A local
endpoint reports initialized owned partitions; the aggregate endpoint intersects
peer reports with Kafka group ownership. Peer calls are coalesced and cached for
at most one second. Worker hints expire and filter the existing PG claim query;
no network call runs inside admission. A generated full Session hash in PG matches
the existing UTF-16 FNV partition function; partition count/ownership stay outside
durable domain state. Binding bootstrap filters that hash by assignment before
fetching payloads, pages on its primary key, and caps retained rows and bytes.

Replace whole-batch relay waits with a bounded number of independent send slots.
Keep entity-head ordering and PG claims; completion frees one slot immediately.
Cleanup has a separate bounded work budget. Use commit hints and known retry
deadlines with a conservative idle fallback, preserving reconnect and lost-hint
recovery. Expose bounded backlog/age measurements in the existing metrics module.

Only real Subagent mutations emit control changes. Coalesce repeatable view
invalidations within their PG transaction before publication; published facts
remain immutable. Skip installed versions and irrelevant Steer wakes. Binding
creation/closure keeps its stronger synchronous contract. Recover only owner
state, with paging and row/byte bounds after ownership filtering.

Coalescing keys include a transaction-local UUID, tenant, entity and logical Session.
The UUID is generated on first use and stored with `set_config(..., true)`;
[PG transaction-local settings](https://www.postgresql.org/docs/current/sql-set.html)
reset at commit/rollback and respect savepoints. Do not persist PG numeric XIDs as
business identities across logical restores into another cluster. This marker
only coalesces uncommitted references; it is not execution authority.
For each key,
the retained reference takes the last allocated revision while preserving its
Fact ID. This matters when a transaction waits for a Session lock after an earlier
trigger. Bindings and commands are not coalesced. Subagent revision assignment is
a BEFORE trigger; notification is AFTER successful mutation, so a conflicting
INSERT cannot emit a phantom notification.

An input-queue reference may carry `steerPending: true` when its transaction added
held Steer work. It is an additive wake hint, not proof of absence when omitted;
coalescing retains it with OR. Projector bootstrap recovers owned held scopes and
retains them through HTTP acknowledgement until PG confirms no held source remains.
Canonical input/seal events wake only those scopes; capacity overflow falls back
to scoped PG reconciliation, never to dropping input. Assignment replacement
discards this index. Current PG eligibility still decides delivery and consumption.

### Other bounded reads

Preview may resolve authorization, Workspace and owner in one current PG query;
this does not authorize caching permission or sharing tunnels across resources.
Deduplicate identical immutable image references within one decode operation,
preserving tenant/hash/length validation and cancellation. Do not add a global
image-byte cache or raw Tool-result storage.

## Acceptance and cutover

Prove quarantine under publication failure, rollback/owner replacement, usable
partition admission, independent relay progress, duplicate/no-op changes,
notifications racing scans, missed hints, bounded cleanup, cold recovery and
canonical input consumption. Count complete Turn work, not only cache getters.
Existing Pi/Tool/cancellation contracts must continue to pass. Use isolated PG
and Kafka fixtures, then matched drained application/schema deployment and real
GPT-6 Luna acceptance. Preserve the original native log, images and Workspace
Volumes. Record explicit limits; this is not automatic VM rebuild or multi-node
HA acceptance. No legacy protocol/implementation is retained in parallel.

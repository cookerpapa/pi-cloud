# Input-admission read reuse

Source baseline: `a5d64c18`. Decision: [ADR-0240](../adr/0240-transaction-scoped-input-admission.md).
This is one intake-query slice on schema 183, without a cross-request cache,
new storage authority or public protocol change.

ControlPlaneStore now supplies a callback-scoped transaction with the locked
Session, a fresh initial-request lookup and a bound action for accepting that
request. QueuedInputService uses the same facts when it chooses initial intake
or native continuation. The action rejects calls after the callback ends.
Worker delivery and its fresh grant check remain outside this transaction.

## Query counts

The real PG tests count completed application SQL statements, not CTE-builder
callbacks or SQL executed internally by triggers. Normal intake means an
existing conversation, an elastic Workspace and a new text-only initial request.

| Path | Before | After |
| --- | ---: | ---: |
| Public initial-intake business statements | 9 | 8 |
| Same-key initial-input retry | 3 | 2 |
| Direct internal Store initial submission | 5 | 5 |
| Worker claim/admission | 9 | 9 |

Authentication normally adds one SQL statement; driver BEGIN/COMMIT add two.
The ordinary browser request therefore goes from 12 to 11, with one more
statement when authentication usage metadata needs refreshing. These counts do
not include creating the Session, attachments, development-machine checks,
environment replacement or later Worker/Kafka/native projection work.
This removes one round trip; no latency or throughput improvement is asserted.

## Failure checks

The 73-test targeted intake/admission/recovery group passes. New real PG cases
cover two replicas contending on the Session lock with matching or changed
payloads; model changes before and after intake; atomic rollback/retry; action
lifetime after commit/rollback; Workspace deletion after the Session read; and
mismatched tenant scope. Existing native input, Stop and recovery tests pass.
Both the direct Store and Worker claim query budgets remain unchanged.

The separate idempotency query deliberately remains after the Session lock.
It sees a Run committed during a lock wait, avoiding a stale joined snapshot.
Model/environment/Workspace validation is retained, and no snapshot is reused
by a later request or by post-transaction Worker delivery.

## Verification and rollout

- All 22 workspace typechecks pass.
- All 227 registered deterministic fault cases pass, including seven new
  input-admission cases.
- Acceptance helpers: 15 files, 64 tests pass.
- Formatting and documentation checks pass.
- The complete workspace test run and authorized matched rollout are pending.

Source checks use disposable PG fixtures and spend no model tokens. Deployment
will preserve original accounts/configuration and use owned Luna/Cube/browser
fixtures through the maintained matched release procedure.

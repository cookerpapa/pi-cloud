# ADR-0218: consistent input, time and cleanup boundaries

Status: accepted for implementation, 2026-10-04, following the owner's request
to implement the follow-up review and ensuing discussion.

## Scope and existing infrastructure

Implement R2-01–06, Q2-01 and O2-01 from the
[follow-up review](../reports/repository-review-20261003-r2.md) in independent
verified slices. The Cube ordered-stop protocol is a separate decision.
Reuse the pinned Pi public SDK, TypeBox/Node encoding, PostgreSQL time/row locks,
existing control notifications and explicit disposable PostgreSQL/Kafka fixtures.
No additional scheduler, broker, active writer or attachment authority is needed.

## Decisions

- Human input acceptance, queue edits, direct/promoted Steer and Worker command
  validation share a serialized-input budget. Account for Pi's three startup
  copies, composed upload metadata and packed image references inside the
  existing 900 KiB Fact bound. Preserve the 100,000-character bound and ordinary
  maximum-length Unicode text. Reject unsupported storage text and oversize
  combinations before committing accepted input; never silently truncate user
  content or enlarge Kafka records. Image preparation retains a bounded,
  code-owned hint allowance and a final Runner check.
- Subagent availability, cancellation and supervisor request/reply deadlines
  use PG time, including a fresh post-lock expiry decision. Local wake timers
  remain monotonic hints, not the authority for persisted deadlines.
- Existing Workspace/image inventories own cleanup retry metadata. A failed
  object cannot indefinitely monopolize the oldest batch or abort unrelated
  deletions. Keep reference/Run/VM-absence protections, join an in-flight delete
  before retrying locally, and perform external deletion outside transactions.
  Retries use bounded backoff and errors contain no object content or credentials.
- Normal Subagent maintenance is scoped to the Session/Run whose ordered fact
  changed. Bootstrap and timed recovery retain bounded global reconciliation;
  scoping must not hide overflow, closed-parent work or abandoned preparations.
- Verification recipe directories resolve against the immutable Run cwd.
  SSH and development-machine terminal open/resize share the existing terminal
  dimension contract rather than defining different limits in each adapter.
- Current verification commands use explicitly configured isolated fixtures.
  Remove retired production Docker-network assumptions. Diagnose and repair the
  default test failure without disabling cancellation/concurrency assertions.

## Acceptance

Cover native-size boundaries and failed input transactions; edited/steered inputs
and attachments; positive/negative application-clock skew and expiry after a lock
wait; failed-first-item and failed-full-batch cleanup with later healthy items;
scope-specific reaping and startup recovery; machine/subdirectory verification;
wide SSH open/resize; and the previously failing local test sequence. Record exact
source, fixture topology, measurements and remaining deployment limits. Existing
durable acknowledgements, output seals and UNKNOWN external effects remain intact.

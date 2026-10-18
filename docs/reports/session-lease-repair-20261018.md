# Session lease repair and delivery

Date: 2026-10-18. Decision: [ADR-0258](../adr/0258-bounded-session-lease-renewal.md).
Review baseline: `ddc404f8`. Status: source implemented; complete CI, artifact
preparation, matched deployment and live acceptance are pending. Serving release
remains `browser-delivery-205e6ac0` until the deployment evidence below is completed.

## Changes

- WLR-01: the shared observer enforces active deadlines independently of reads,
  including synchronous checks after event-loop delay. Pending callers receive
  abort; close does not wait for PG. Fresh cold authorization remains required.
  A dedicated two-connection Worker lease pool bounds acquisition and complete
  checkouts to five seconds each, including COMMIT, and destroys failed sockets.
- WLR-02: fatal renewal failure disables local claims and revokes executions
  before bounded PG quarantine. Diagnostics cannot suppress that revocation.
- WLR-03: available lease rows renew in one batch while eligible busy rows are
  explicitly deferred. Deferral never extends a local lifetime. Both consumers
  validate identities and disjoint outcomes; batch retry is at most one second.
  Expired, closed, failed and mismatched owners still cannot renew.

Normal nonempty renewal remains three business SQL statements plus BEGIN/COMMIT.
There is no new authority service, PG table, Kafka record or compatibility decoder.
Only the private heartbeat acknowledgement requires a matched schema replacement.
The former review-only probes are retained in Git at `ddc404f8`, replaced in the
working tree by maintained observer, database and real-PG renewal regressions.

## Verification record

The first targeted run passes 69 tests across six files. The initial transport
budget run passes 40 of 41 tests; its pool fixture incorrectly required an already
waiting acquirer to survive its own timeout while the expired socket closed.
The corrected fixture accepts that bounded refusal, then independently verifies
old backend disappearance, rollback and a new working connection while the old
transaction callback is still held. All four checkout cases pass on that repeat.
No production timeout was widened. A later source inspection also makes idle
socket destruction explicit; complete CI will verify that final implementation.

The first workspace typecheck finds an unused variable in the revised grant
lock-wait fixture. Removing it makes all five affected workspace typechecks pass.
The renewal lock case now tests nonblocking deferral plus positive rejection after
expiry, rather than expecting renewal to wait for the held lock. Grant admission
still tests post-wait expiry. The real TCP lost-COMMIT test confirms exactly one
fixture insert, rejection of the unconfirmed return and no automatic replay.

Private evidence is under `deploy/production/runtime/release-evidence/session-lease-20261018/`.
Do not treat source checks as a serving deployment or new live recovery evidence.

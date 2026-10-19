# ADR-0261: Bounded seal projection and writer-owned live views

Status: implemented and deployed as `seal-projection-0de1fe7f`, 2026-10-19.
Source/artifact and native/browser/child/outage/full-Cube gates pass; image cold
recall remains unaccepted after model response-header timeouts. Cleanup is confirmed.
The owner approved repairing SPJ-01/02 and SPJ-O1/O2 from the
[closure review](../reports/seal-projection-review-20261019.md).
Baseline: `450a1efd`. No schema, public API, Kafka, Pi or guest protocol change.
[Verification and delivery](../reports/seal-projection-repair-20261019.md).

## Decision

Keep the existing ordered Session Projector and PG closure transaction. A complete
native checkpoint, old-writer release and successor eligibility still commit
together. A missing COMMIT reply remains uncertain until ordered replay reads PG.
No timeout, memory eviction or Kafka receipt grants successor execution authority.

1. Give the Control Plane's existing projection path a dedicated direct-PG pool,
   reusing the bounded node-postgres checkout adapter from ADR-0258/0260. Retain
   the previous 12-connection upper bound for projection concurrency. Acquisition
   and checkout each have a 30-second budget; the existing per-statement 10-second
   and lock 2-second transaction budgets remain. The longer outer checkout allows
   multi-statement checkpoint transactions while bounding their total duration.
   This pool covers native projection, cold boundary reads, replay floors, control
   projection positions, routing-owner lookup and retention metadata. Publication,
   expiry maintenance and general APIs retain their existing separate pools.
   Dispose the projection pool after its consumers, including failed startup.
2. Scope disposable native live views by the existing tenant/physical-Session/
   writer identity. Conversations and Run anchors of one writer still share the
   same view. A new lease incarnation gets its own view; this is no new lease,
   writer, persisted checkpoint or replay authority. After PG confirms immutable
   writer closure, prepare cleanup of that exact view and invoke it only after
   transaction success while the ownership generation and object still match.
   Repeat this cleanup on duplicate closure, including a lost prior COMMIT return.
   An old seal cannot remove a successor's view. Do not remove required live data
   before closure or treat an uncertain commit as confirmed.
3. Resolve the latest hash proof separately for each pending live document, using
   its existing `replay_seq` lower bound and the Session/sequence primary index.
   Select the latest matching hash within that range; preserve exact sequence and
   fingerprint checks. This avoids unrelated lifetime headers without adding a
   second index/projection authority or writing streaming bodies to PG. An actual
   long pending suffix may still require work proportional to that suffix.
4. Include `row_version` in the initial locked Run read and use the existing
   `transitionLockedRun()` helper. Preserve transition CAS/history and the ordered
   intermediate writes required by the writer-handoff trigger. Reuse only facts
   protected by this transaction, not a cross-request control cache.

## Adoption and limits

Reuse existing pinned node-postgres/Kysely and PostgreSQL transaction/index
facilities. ADR-0258/0259/0260 already document the database adapter decision;
ADR-0244 defines the native checkpoint/replay authority. Another event store,
queue, workflow engine or cached authority would duplicate those responsibilities.
No new dependency or native-library patch is necessary.

The projection pool bounds resource/I/O lifetime, not product Session or Lane
counts. Its extra server connections are an operational cost. The 30-second
budget is a conservative ceiling to verify with source and live acceptance, not
an SLO or fleet-capacity claim. Expired connections must be evicted, never left
running behind a detached Promise timeout. Existing partition retry reconciles
uncertain effects; Tools retain their monotonic dispatch boundary.

## Acceptance and delivery

- Real PG acquisition/lock/checkout waits terminate and leave capacity reusable;
  the production composition passes the bounded pool to all listed projection
  operations. Failed startup closes acquired pools.
- Checkpoint/closure rollback retains replay references and old authority.
  Lost COMMIT return followed by replay yields exact state and removes old live
  memory; terminal and recoverable closure both remain idempotent.
- New-lease projection and historical duplicate/replay can interleave without
  losing the new view. A stale callback or ownership reset cannot remove a new
  object. A successor cannot claim before closure COMMIT.
- The actual checkpoint proof uses the pending range with old-history fixtures,
  multiple interleaved live documents, distinct replay starts, sequence gaps and
  mismatched hashes. No missing/changed proof is silently accepted.
- The measured one-live-document recoverable seal uses one locked Run read and
  one fewer business SQL statement, without changing trigger/CAS behavior.
- Required source, RF3/PG, fault and artifact gates pass, followed by the maintained
  drained matched release and relevant native/Stop/dual-process recovery,
  browser/image, child handoff, Control Plane outage and full Cube acceptance.
  Preserve original accounts/configuration/credentials and confirm owned physical
  cleanup. Record source completion separately from deployment and live results.

This repair does not advance the next walkthrough past replacement Worker/Harness
bootstrap. Deployment uses the existing matched set and needs no compatibility
code or migration. A rollback uses a drained matching artifact set.

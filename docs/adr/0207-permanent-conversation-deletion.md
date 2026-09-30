# ADR-0207: permanent conversation deletion and unused elastic compute

Status: accepted for implementation, 2026-10-01 (owner decision D30-02).

## Decision

- Delete means permanent removal of the selected ordinary conversation tree,
  its delegated logical Sessions and owned native physical Sessions. This
  includes control history, native log bodies and attachment/upload references.
  Independently retained conversations, Workspace/Volume bytes and user-owned
  development machines keep their separate lifetimes.
- Lock and recheck the complete tree. Reject queued/running/cancelling work,
  preparing children, unsealed output and current native writer leases. A busy
  descendant returns a conflict instead of risking a claim/deletion lock cycle.
  A delegated Lane cannot be deleted independently through this public endpoint.
- `DELETE /v1/conversations/:sessionId` commits before HTTP 204. An already absent
  tenant-scoped identity also returns 204. The resource identity makes deletion
  idempotent without keeping an archive receipt or transcript. Remove the
  archive/unarchive service and its obsolete operation schema/table.
- Keep deletion atomic across product control and native history through the
  existing PG transaction/native-storage port. Owned foreign keys cascade;
  independent lineage metadata is detached. Native deletion verifies quiescence
  and the absence of remaining product references before deleting data.
- Session history is not the owner of a shared Cube. Runtime rows retain only
  bounded bootstrap IDs required for cleanup, with no FK dependence on the old
  Session/Run/Turn rows. A surviving conversation using the compute scope keeps
  the VM. The final reference disappearing makes it immediately eligible for
  cleanup without a warm-TTL wait; normal between-Turn reuse is unchanged.
- Reuse the Broker's existing cleanup owner and PostgreSQL notification helper.
  A commit-time empty hint wakes a bounded, non-overlapping cleanup scan; periodic
  scanning covers missed hints. PostgreSQL runtime rows remain the authority.
  No second scheduler, queue or per-Tool operation ledger is introduced.
- Physical VM quota is released after destruction is confirmed. Failed or
  uncertain cleanup remains accounted for and retryable. A notification never
  proves that resources are free. The Cube provider keeps identity checks and
  confirms absence before reporting successful destruction.
- Existing hidden ordinary conversation trees are purged during the matched
  schema cutover with the same quiescence guards. The remaining marker used by
  native branch pruning is named `pruned_at`, with `prunedSessionCount` in the
  prune response. Pruning is context navigation inside retained native history;
  it is not a user archive/restore feature. Pruned logical views do not consume
  the usable-Session quota.
- Unreferenced S3 image objects follow the existing reference-checked reaper.
  Kafka follows its existing safe partition retention. This is not immediate
  per-Session erasure from Kafka, independently retained copies or backups.
  Old append/seal replay must not recreate deleted history or execute Tools.

## Adopt before build

Use PostgreSQL transactions, native foreign keys, the existing Pi storage
adapter, attachment GC and Broker cleanup. PostgreSQL's existing notification
port supplies a hint rather than another durable command authority. No new
infrastructure implementation or alternate sandbox is needed.

## Acceptance

Delete a completed parent/Fork/delegation tree and prove target database history
is absent, retries succeed, another tenant and independent history survive, and
Workspace bytes are retained. Cover races with admission/Fork, unsealed Runs,
active leases, pending uploads and old Kafka replay. Verify shared-VM retention,
unused warm/unknown runtime cleanup, cleanup failure accounting, wake/shutdown
behavior and unchanged owned-machine lifecycle. API/Web/schema deploy together;
restore a matched backup to roll back destructive data changes.

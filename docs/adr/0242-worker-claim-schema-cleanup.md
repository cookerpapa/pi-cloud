# ADR-0242: Worker claim schema and indexed control reads

Status: implemented, source-verified and deployed, 2026-10-10, as `worker-claim-5c803cc5`.
See the [verification record](../reports/worker-claim-repair-20261010.md).
The owner approved all four
findings in the [focused review](../reports/worker-claim-schema-review-20261010.md).

## Decision

Keep PG as the Run/lease authority and retain atomic Worker admission, physical
Session ownership, per-Lane readiness and ordered closure. Native Durable owns
continuation. This slice does not introduce another queue, cache, task history,
RunAttempt or execution authority.

Include the candidate tenant in the child-Run ownership lookup so the existing
`(tenant_id, child_run_id)` index bounds the read. Keep parent liveness and lease
expiry checks. Index Run transition history by `(tenant_id, run_id, occurred_at, id)`.
The isolated review measured avoidable index-page work and a full history scan;
reuse ordinary PostgreSQL indexes rather than build another read model.

Remove `pi_sessions.created_at_ms`, `parent_session_id` and `name`, including
their current creation/Fork/fixture writes. Product metadata stays in `sessions`;
native ancestry stays in Durable. The physical identity, monotonic lease epoch,
transactional unsealed count and generated partition hash remain.

Rename the Worker registry from `sandboxes` to `workers`, its retirement records
to `worker_retirements`, and Worker-reference columns to `worker_id` in leases,
connections, boot credentials, retirements and the derived execution-scope view.
Use Worker names for the corresponding database/domain state types and constraints.
Keep IDs, boot identities, foreign keys, ownership uniqueness, credentials and
retirement evidence. There is no compatibility view, duplicate column or dual read.

This is database/entity naming, not a rewrite of the separate Cube transport.
Cube API sandbox IDs, allocation metadata and the fixed management/guest wire
contracts keep their existing meaning. SQL adapters explicitly map their Worker
references at those boundaries; this does not add an old/new protocol mode.
`workspace_runtimes.sandbox_id` remains part of the recorded physical-allocation
bootstrap context, separate from the Worker's current execution grant.

## Cutover and acceptance

Migration 184 requires drained Runs, current leases and unsealed writers. Apply
it only through the maintained matched release after physical VM absence is
confirmed. Rename existing ownership records rather than discard them; preserve
accounts, model/provider configuration and credentials. Historical migration
fixtures explicitly target their old schema, never compatibility in production.

Require indexed reads with substantial synthetic history; root/child claims and
closed-parent rejection; unchanged normal SQL count; concurrent family ownership;
expiry/rollback/lost-COMMIT behavior; old-writer closure and Durable recovery;
creation/Fork/native Storage; Worker registration/reconnect/retirement; and
migration guard, FK/unique-constraint and recovery/export checks. Run repository
gates, matched deployment and relevant GPT-6 Luna/Worker-family acceptance.

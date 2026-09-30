# September 30 review: repairs and discussion decisions

Date: 2026-10-01. Starting revision: `7c1f46ec`.
Findings originate in the [September 30 review](repository-review-20260930.md).
This record distinguishes completed changes from work still under validation.

## Scope authorized after the review

- Preserve Worker → Kafka → Projector → Broker → Cube command delivery. The
  owner rejected the proposed Worker-direct dispatch alternative.
- Research Cube-owned execution acceptance and Kafka completion publication
  outside the untrusted guest, with Broker-restart independence as the target.
  Research does not authorize a silent Cube upgrade or a second task scheduler.
- Implement confirmed R30 findings and bounded cleanup without compatibility
  paths. Keep pinned Pi and its public execution/storage semantics.
- Delete conversations and their database history instead of archiving them.
  Reclaim unused elastic compute after its final conversation disappears;
  retain current between-Turn warm reuse and owned-machine release semantics.
- Preserve displayed partial Assistant text and confirmed interruption facts
  in subsequent model context, without replaying partial Tool calls or
  presenting unknown effects as successful execution.

## R30-07: direct-Steer runtime composition

The composition test now admits a real Run through the existing test Worker,
then accepts Steer with HTTP 202 and verifies its held source in PostgreSQL.
The actual application reconciler uses the injected remote transport despite
having no local Worker WebSocket connection. The transport reply is deliberately
blocked, proving API acceptance does not wait for delivery. A repeated request
keeps the same source/control identity and does not redeliver an acknowledged
input. No old `kind=steer` fixture or production compatibility branch remains.

Validation: all four `control-plane-runtime.test.ts` tests and the Control Plane
typecheck pass. The complete
release check will be repeated after the remaining review repairs.

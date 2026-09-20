# ADR-0181: Retire duplicate control and dormant accounting paths

Status: accepted, 2026-09-21, following the owner's approval of the six-area review.

Keep PostgreSQL Session ownership, one Run execution, Kafka publication/seals,
Tool UNKNOWN, native usage records and existing user features. This slice does
not change payload storage, split services, replace Pi or change Cube protocols.

Worker WebSocket carries registration and heartbeats. Production Steer uses its
existing HTTP management backend; remove the alternative WebSocket Steer router
and its prepare/commit/release exchange. Local Runner acknowledgement and command
contracts remain where actually used. Missing Steer injection is an explicit
unavailable service, not another transport choice.

Model-request admission is atomic after request-body validation. Body uploads
participate in capability revocation/Worker shutdown; released or expired authority
cannot begin an upstream request. This is process-local state, not another PG check.

Native Pi usage is retained for future accounting. Remove the unused monetary
budget fields, model_rates, model_requests, usage_ledger and environment_operations
from the maintained schema/runtime. Cutover must refuse nonempty historical
usage/request/environment-operation data rather than silently discard it.
Pair CP/Worker deployment after draining; do not retain an old-wire fallback.

Normal input reads a matching environment version under shared protection.
Only an actual image-version change takes the Project update lock and re-reads
current state. Resource deletion/input coordination and per-Lane order remain.
SQL consolidation is allowed only within existing atomic boundaries with lock-wait,
cancel, lost-COMMIT, sibling-Lane and real-runtime regression evidence.

Package-boundary and test-injection cleanups must preserve these contracts; they
do not authorize a new service, scheduling authority or transcript representation.

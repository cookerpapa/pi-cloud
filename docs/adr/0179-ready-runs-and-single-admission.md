# ADR-0179: Durable Lane readiness and one execution admission

Status: accepted, 2026-09-19. Implements the owner-approved separation of
accepted input, dependency readiness and execution authority. No new scheduler,
service, authority cache or execution-log boundary is introduced.

`runs.state = queued` means accepted input. `runs.ready_at` distinguishes its
Lane's dispatchable head from follow-ups still waiting for a predecessor. Input
acceptance and seal projection advance this readiness under the existing product
Session row lock. Child preparation readies a new Lane without waiting for its
parent to end. Notifications are hints, never execution permission.

Readiness proves Lane dependencies, not permanent owner authority. The physical
Session keeps an `unsealed_runs` count: a Run row trigger increments it on
owner binding and decrements it on first seal, in the existing transactions and
without a second client round trip. An existing healthy
owner can execute other ready Lanes; a new owner requires zero unsealed Runs.
This replaces history scans at owner admission, not Lease/Fence or ordered seals.
Duplicate seal projection cannot decrement twice; a missing count is an invariant
failure, never a repair/fallback. Quarantined Sessions additionally require the
existing positive Agent-exit evidence before readiness can advance.

Worker admission selects a ready head and atomically establishes exact ownership,
lease, publication scope and running state. Capacity is Worker-local (ADR-0180).
Reuse only current rows
locked or created in that transaction. Keep post-lock database time and
conditional final writes. Remove the old committed-but-unbound claim branches:
production admission cannot commit a running Run without its owner lease.
One task's finish must not release or transfer sibling Lanes' owner.

Keep the existing foreground-child contract: preparation and parent liveness are
required; a closed parent cannot leave independently runnable child work. Session
ownership/cancellation may change after readiness, so current assignment remains
an atomic decision. An ambiguous committed admission is resolved by exact identity,
not blind claim/Tool replay. Drain, seal, UNKNOWN and user-visible durability stay.

Use the existing PostgreSQL transactions, row locks, partial queue index and
commit-time NOTIFY. A second workflow engine or in-memory ready queue would add
authority/atomicity boundaries without removing these application invariants.
Roll out only after admitted executions and seals drain; preserve history and
Volumes. No old-wire decoder or second scheduling mode is retained.

Acceptance: first input/follow-up FIFO; commit-time seal promotion and rollback;
notifications lost/restarted; concurrent claim/cancel; child Lanes while parent
runs; no owner handoff until all old Lanes close; exact lost COMMIT; model/Cube
multi-round and paid before/after SQL-count and latency comparisons. No performance
claim before measurement; a lower query count does not eliminate storage tails.

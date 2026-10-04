# October 4 review repairs

Started 2026-10-05 from `c3f5f6bd`. The owner approved the repair proposal.
Implementation and validation are in progress; production has not yet changed.

## Lifecycle slice — ADR-0224

- R04-01: separate short observation deadlines from accepted Cube cleanup.
  Use the configured native destroy budget independently of caller cancellation;
  reserve outer transport time through Master, API and the PiCloud client.
  Recheck terminal state after the allocation lock. Cleanup never reopens creation.
- R04-02: prepare recovered bindings and durable state before publishing local
  availability. Storage/binding failure after successful adoption remains retryable
  without quarantining the verified VM. Contain health-target enumeration errors.

Validation so far: native allocation package with race detection; native
paused-delete/managed-cleanup service tests with CGO disabled (local static
cubecow library unavailable); controller, runtime client, monitor and recovery
tests. Native production build and live acceptance remain required.

## PG decision slice — ADR-0224

- R04-04: owned lifecycle transactions lock the controller before resources,
  then check PG expiry again before commit. Retirement uses the same lock order.
  Waiting past expiry rolls back authorization; no Cube RPC runs under a PG lock.
- R04-07: ticket issue returns PG-computed expiry; consume checks it after the
  ticket lock. Removed the independent application-clock policy.

All 22 full-schema ownership tests pass, including both ordering and deadline
cases for creation/closure. All 14 SSH-consumption/development-machine tests pass;
the narrow consumption fixture verifies expiry during lock wait and one-time use.

## Pi request-policy slice — ADR-0224

R04-05: ordinary sampling and native Compaction apply one common request policy
for transport, timeout and frozen service tier. Summary session IDs, cache policy
and output limits remain Pi-owned; hosted search is sampling-only. All 91 runtime,
lifecycle and request-policy tests pass, including Standard/Fast compaction.

## Structured Tool failure slice — ADR-0225

R04-06: v2 boot replies distinguish native `tool_result` from
`execution_failure`. The mailbox validates callback identity and carries typed
failure code/effect status to the Harness. Fixed Tools and workflow dispatch use
the same classification; ordinary native error text is never parsed for control.
Native Bash prefix regressions, mailbox wire/identity checks, real Agent failure
settlement, completion images/probes and dispatch tests pass (82 assertions).
Matched rollout and broad verification remain required.

## Volume state slice — ADR-0226

R04-03 replaces managed allocation reply deltas with durable Volume holds and
versioned node reference state. Node metadata records unfinished detach before
the plugin hook and synchronously commits its incarnation/revision. Master
closes attachment admission before deletion, keeps node identity after allocation
receipt collection and refuses unknown/changed metadata. Cube native protocol is
7; guest Tool protocol remains 3. Migration `20261005000000` adds the Cube Volume
state tables and removes the obsolete managed delta-application flags.

Real Bolt/race tests cover a failed detach-state write, restart and the lost first
allocation cleanup receipt. Six real MySQL/race tests cover shared references,
duplicate/stale replies, metadata replacement, pending creation, receipt GC,
historical untracked holds and concurrent placement/deletion. Native Volume/API
targeted tests and paused-delete composition pass. A broader upstream snapshot
test crashes in uninitialized node-cache fixture setup; the same named test
also fails on unchanged `c3f5f6bd` native source. It is outside this repair's
passing claims. Production build and real-VM acceptance remain pending.

Remaining slices: browser gate and measured cleanup, then full/matched acceptance.

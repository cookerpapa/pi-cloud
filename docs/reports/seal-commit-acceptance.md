# Durable execution-commit notification acceptance

2026-09-08; candidate based on `3eb68459`, working tree modified.
[ADR-0156](../adr/0156-durable-seal-commit-notifications.md).

## Change and boundary

The canonical seal transaction now co-commits a stable `execution_committed`
Outbox notification. Gateway closes the old Attempt at the first seal without a
SELECT and keeps consuming; the notification supplies the exact terminal and
releases that Session's ordered successor display. No token publication delay,
new broker, browser cursor or extra pre-Tool durability barrier was added.
Next-Run admission still waits for PG closure, not notification publication.

The existing Relay now publishes both seal requests and commit notifications.
Repeated seals re-arm the same notification, without rewriting semantic data,
moving the first cutoff or replacing a pending publisher claim. A commit
notification does not generate another notification. Deferred display is bounded
by encoded payload bytes (8 MiB per Session / 64 MiB per Gateway); overflow uses
the existing durable replay and replacement-snapshot path. These are soft-state
payload budgets, not total process RSS limits.

## Real PostgreSQL / Kafka comparison

Run `PI_CLOUD_LIVE_SEAL_COMMIT_CHECK=1 node scripts/run-seal-commit-check.mjs`.
The test uses a disposable PostgreSQL (2 CPU / 768 MiB), a 3 CPU / 2 GiB runner,
four Kafka partitions replicated across the existing three Brokers, four
concurrent Sessions and two rounds per scenario. There is no LLM time.

Both paths observe the same seal and canonical commit. The baseline reproduces
the previous SELECT plus 25 ms exponential backoff, conservatively excluding its
native Kafka pause/seek overhead. The new path uses the actual Outbox Relay and
Kafka live consumer. Artificial delay is per seal in the canonical consumer, so
several Sessions sharing a partition can accumulate more delay than that value.

| Canonical delay | Runs | Baseline seal SELECTs | New seal/commit SELECTs | Old terminal p50 / p95 | New terminal p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 ms | 8 | 22 | 0 | 79.14 / 116.16 ms | 72.49 / 123.58 ms |
| 100 ms | 8 | 25 | 0 | 180.69 / 381.91 ms | 136.93 / 257.43 ms |
| 500 ms | 8 | 56 | 0 | 1,581.52 / 2,584.71 ms | 1,381.78 / 1,861.34 ms |

The 24 runs required 103 baseline seal queries and zero new Gateway seal/commit
queries. Gateway still made 42 metadata/recovery queries; this is not a claim
of a database-free Gateway. One earlier repetition measured normal-load p50 at
26.69 ms for polling versus 68.92 ms for notifications: low-lag completion can
cost an extra few tens of milliseconds because of Relay scheduling/Kafka
delivery. No claim of universally faster completion or lower *total* PG I/O is
made: the new design adds an Outbox write and its reliable delivery bookkeeping.

The same real-log fixture verified commit-before-publication recovery, discarding
and restarting the canonical consumer, an injected lost Kafka delivery ACK,
two notification deliveries and exactly one public terminal row. Pending display
bytes returned to zero. Private topics/groups/containers were removed.
[Raw evidence](seal-commit-acceptance-latest.json).

## Real model / browser checks

* Five actual DeepSeek requests exercised normal Steer/Follow-up, sole-browser
  disconnect/reopen, canonical-consumer restart, a 12-second SIGSTOP of ingress,
  SIGKILL of Worker A, and replacement Worker B. B received the visible prefix;
  late old data changed neither the canonical head nor live output. Delivered
  but unconsumed Steer remained in the durable mailbox, not silently replayed.
  [Worker handoff evidence](worker-handoff-probe-latest.json).
* Browser/Cube coding wrote insertion sort, merge sort and binary search with
  tests, then read/edited the same file to add heap sort. The model corrected
  one initially failing assertion; final Bash results were `OK` for 15 and 25
  tests. Write/edit preparation remained animated and refresh restored it.
  Round totals were 21.695 / 13.561 seconds; nine model usage records were saved.
  [Browser evidence](tool-preparation-acceptance-latest.json).
* Three tenants × two rounds completed 6/6 on both deployed Workers. Three
  markers restored, three cross-tenant API requests were denied, no marker
  leaks, unexpected Tools or extra Attempts. Acceptance p50/p95 43/87 ms;
  first text 2.409/6.298 s, including queue p95 5.602 s while the coding test
  shared two parent slots. Six actual model requests, 831 uncached input,
  671 output and 35,328 cache-read tokens.
  [Multi-tenant evidence](multi-tenant-model-load-latest.json).

## Regression, deployment and cleanup

Targeted tests cover zero-SQL seal/commit handling, rollback on notification
insert failure, reverse-order confirmations, successor ordering, multi-browser
delivery, duplicate/late seals, fixed cutoff after replay and memory overflow.
Fresh-topic acceptance also exposed a Kafka metadata propagation race; the
consumer now retries only unknown-topic/leader-not-ready metadata for at most
five seconds. The native-client regression and subsequent real checks passed.

Migration 129 and topic generation v4 were deployed after draining Runs, seals
and Outbox. The four exact acceptance tenants were deleted only after their
Workspaces were API-released and storage purge confirmed. Counts returned to
35 users, 52 Sessions and one live Workspace. Existing user data and Cube
templates were preserved. Shared Kafka test records age out under normal
retention rather than resetting a shared log. Credential-free reports remain.

The final full `npm test` run passed 686 tests with three existing environment-
gated skips. Type checking, production builds, installer/Helm contracts,
runtime-time-budget and image-closure checks, documentation, formatting and
security audit passed. An initial parallel PGlite authority fixture exceeded
Vitest's default 5-second timeout; runtime-core now bounds test workers to two
and uses explicit database-fixture budgets. This changes test execution only,
not production Lease timeouts. A final bounded-buffer regression also verifies
that overflow stops the remaining events of the current Fact until replay;
all 23 runtime-core tests and its type check passed again.

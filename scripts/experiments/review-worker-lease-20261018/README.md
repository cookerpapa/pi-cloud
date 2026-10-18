# Worker lease review characterizations

Reviewed source: `85eb2f073eb90b678327b38bf712bbc225daf6a5`.
These tests assert existing behavior, including the reported defects. They are
review evidence, not repaired-behavior regressions or runtime changes. Replace
them with maintained regression tests when the repair is approved.

Run only against disposable test PostgreSQL (the wrapper starts/removes it).
Never supply a production database URL:

```bash
node scripts/run-with-test-postgres.mjs -- node node_modules/vitest/vitest.mjs run scripts/experiments/review-worker-lease-20261018 --maxWorkers=1
```

- `observer.test.ts` uses the actual shared observer with deterministic time
  and a withheld PG response. It proves missing active local-deadline cancellation;
  it does not assert that a stale native commit is published.
- `renewal.postgres.test.ts` runs the actual renewal SQL against migrated PG,
  captures SQL counts without parameters, holds one actual row lock, and tests
  failure ordering through real Run admission/backend/Supervisor. Only the latter's
  runner, Kafka and renewal/quarantine outcomes are substituted.
- Test database statement/idle-transaction limits are fixture watchdogs, not
  production changes. The shortened stored lifetime in the lock case models an
  owner approaching expiry; the coordinator retains its production 60-second grant.
- SQL latency is ten small local samples per family count, not a fleet benchmark.

Existing relevant tests:

```bash
node scripts/run-with-test-postgres.mjs -- node node_modules/vitest/vitest.mjs run packages/control-plane/test/authority-time.postgres.test.ts packages/control-plane/test/session-family-lease.test.ts packages/control-plane/test/expired-run-lease.test.ts packages/control-plane/test/atomic-worker-admission.postgres.test.ts packages/control-plane/test/supervisor-reconnect.postgres.test.ts packages/pi-session-postgres/test/session-lease-observer.test.ts packages/sandbox-supervisor/test/agent-run-supervisor.test.ts packages/supervisor-host/test/postgres-pi-worker.test.ts --maxWorkers=1
```

The review ran the first seven existing files together (111 assertions), then
the reconnect file (12) alongside the four characterizations. A final diagnostic
repeat of only the four characterizations captures sanitized measurements using
stdout directly. No assertion was weakened or runtime code changed.

# Control Plane expiry characterizations

Baseline: `3494ff927f0188cf0eeccb33bf5f84845e895601`. These assert current behavior,
including defects, not repaired-behavior regressions. Runtime files are unchanged.
Use disposable PG only; never supply a production integration URL.

```sh
node scripts/run-with-test-postgres.mjs -- node node_modules/vitest/vitest.mjs run scripts/experiments/review-control-expiry-20261018 --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000
```

Each case creates/migrates/drops a separate database. Admission, expiry,
connection and seal code are real; Runner/Kafka are substituted. Physical
inventory/stop ports throw. The starvation case projects one seal in PG, not
through a live Kafka takeover. Fixture SQL timeouts are watchdogs, not product budgets.

The first run has five passes and one incorrect count after requeue clears the
first Run's current seal pointer. Corrected assertions retain the actual
eleventh-Worker starvation/recovery test and count immutable Outbox requests too.
The focused repeat passes:

```sh
node scripts/run-with-test-postgres.mjs -- node node_modules/vitest/vitest.mjs run scripts/experiments/review-control-expiry-20261018 -t 'characterizes pending seals' --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000
```

Existing contracts (50 passing tests):

```sh
node scripts/run-with-test-postgres.mjs -- node node_modules/vitest/vitest.mjs run packages/control-plane/test/control-plane-runtime.test.ts packages/control-plane/test/expired-run-lease.test.ts packages/control-plane/test/session-family-lease.test.ts packages/control-plane/test/execution-stream-seal.test.ts packages/control-plane/test/authority-time.postgres.test.ts packages/control-plane/test/supervisor-reconnect.postgres.test.ts packages/control-plane/test/supervisor-websocket-gateway.test.ts packages/control-plane/test/lease-renewal.postgres.test.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=60000
```

Structured output contains SQL placeholders, never bound values. Counts are
client round trips, not all server operations or fleet latency. The starvation
case uses eleven Workers against the actual ten-Worker default; the serving
deployment currently has two Workers.

# Kafka ACK-only Session append experiment

**Not imported by production Workers, not a second deployed Session backend.**
The maintained production path is still ADR-0159. This directory tests the
proposed ADR-0160 boundary using pinned Pi's public `InMemorySessionStorage` and
ordinary Kafka replication acknowledgements.

```bash
npx tsc -p experiments/kafka-session-append/tsconfig.json
npx vitest run experiments/kafka-session-append/storage.test.ts --maxWorkers=1

PI_CLOUD_KAFKA_SESSION_EXPERIMENT=1 \
  node --import tsx experiments/kafka-session-append/run.ts

# Also spend DeepSeek tokens and allocate/release a disposable real Cube:
PI_CLOUD_KAFKA_SESSION_EXPERIMENT=1 PI_CLOUD_KAFKA_SESSION_PAID_CHECK=1 \
  node --import tsx experiments/kafka-session-append/run.ts
```

Live checks require the repository's local Compose deployment. The runner owns
one private Kafka topic, a disposable PostgreSQL container and an authenticated,
loopback-only test sink. It removes them afterward, including failures. The
optional coding check releases its machine; remove its printed acceptance
identity only after the production Volume reaper confirms byte deletion.

The prototype serializes only native appends within one physical Session;
independent Sessions and model calls remain concurrent. Pi constructs parents,
sequence and timestamps. Each append waits for Kafka ACK before any reader or
dependent Tool sees success. Ambiguous publication poisons that writer, with
no speculative rollback/reuse. PG projects the exact native records. The test
kills its projector process and replaces it using PG-stored Kafka offsets.

The final negative control simulates today's PG-side interrupted-prefix repair
while a Worker still allocates sequence in memory. Kafka ACK succeeds but PG
detects the conflicting sequence. That expected counterexample is why this is
not enabled by swapping one production publisher function.

Limits: no production Authority Gate/Run queue/SSE cutover, no automatic
production retention controller, and no bounded snapshot import. Recovery
replays the small fixture log through Pi's public APIs. The paid Harness runs
in the test process; Bash crosses an authenticated terminal into a disposable
Cube. It does not execute model code on the host or claim to test the production
Kafka Tool-command consumer. `writerId` is a fixture cutoff, not a newly deployed
lease mechanism. Do not infer 1,000-Run capacity from this bounded comparison.

See the [report](../../docs/reports/kafka-native-session-append-experiment.md)
for results and remaining production work.

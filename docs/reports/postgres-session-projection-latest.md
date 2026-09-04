# PostgreSQL Session projection acceptance

- Complete messages: 8000
- Throughput: 903.79 messages/s
- Latency p50/p95/p99: 273.47 / 355.05 / 496.06 ms
- WAL: 54479600 bytes (6809.95 bytes/message)
- Log replay: 6389.47 Sessions/s, 25557.88 events/s
- Log replay latency p50/p95/p99: 36.53 / 45.5 / 51.17 ms
- Failures: 0

This measures complete semantic Session projection, not token deltas.

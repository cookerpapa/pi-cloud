# PostgreSQL Session projection acceptance

- Complete messages: 8000
- Throughput: 292.61 messages/s
- Latency p50/p95/p99: 798.83 / 1108.78 / 1940.54 ms
- WAL: 36622400 bytes (4577.8 bytes/message)
- Log replay: 2465.32 Sessions/s, 9861.27 events/s
- Log replay latency p50/p95/p99: 93.02 / 124.43 / 137.35 ms
- Failures: 0

This measures complete semantic Session projection, not token deltas.

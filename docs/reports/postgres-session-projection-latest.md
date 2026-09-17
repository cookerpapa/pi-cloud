# PostgreSQL Session projection acceptance

- Complete messages: 2048
- Throughput: 421.66 messages/s
- Latency p50/p95/p99: 71.98 / 100.44 / 435.16 ms
- WAL: 9312064 bytes (4546.91 bytes/message)
- Log replay: 1561.26 Sessions/s, 12490.12 events/s
- Log replay latency p50/p95/p99: 14.3 / 43.93 / 50.44 ms
- Failures: 0

This measures complete semantic Session projection, not token deltas.

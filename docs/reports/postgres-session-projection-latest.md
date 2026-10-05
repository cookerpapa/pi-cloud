# PostgreSQL Session projection acceptance

- Complete messages: 24
- Throughput: 157.1 messages/s
- Latency p50/p95/p99: 19.66 / 51.57 / 51.9 ms
- WAL: 81472 bytes (3394.67 bytes/message)
- Log replay: 482.35 Sessions/s, 1447.04 events/s
- Log replay latency p50/p95/p99: 5.11 / 11.33 / 11.33 ms
- Failures: 0

This measures complete semantic Session projection, not token deltas.

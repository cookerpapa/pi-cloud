# PostgreSQL Session projection acceptance

- Complete messages: 2048
- Throughput: 278.29 messages/s
- Latency p50/p95/p99: 102.33 / 177.5 / 454.07 ms
- WAL: 9315288 bytes (4548.48 bytes/message)
- Log replay: 3708.32 Sessions/s, 29666.57 events/s
- Log replay latency p50/p95/p99: 6.63 / 12.65 / 12.91 ms
- Failures: 0

This measures complete semantic Session projection, not token deltas.

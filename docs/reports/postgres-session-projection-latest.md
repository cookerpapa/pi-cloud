# PostgreSQL Session projection acceptance

- Complete messages: 2048
- Throughput: 917.93 messages/s
- Latency p50/p95/p99: 32.32 / 47.57 / 108.52 ms
- WAL: 11077096 bytes (5408.74 bytes/message)
- Log replay: 6027.42 Sessions/s, 24109.69 events/s
- Log replay latency p50/p95/p99: 4.56 / 9.1 / 11.16 ms
- Failures: 0

This measures complete semantic Session projection, not token deltas.

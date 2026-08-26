# Kafka AcceptedFact load

- Checked at: 2026-08-26T09:38:22.798Z
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 147.71 | 3.565 ms | 28.007 ms | 63.678 ms |
| concurrency-16 | 4096 | 786.85 | 5.22 ms | 72.432 ms | 98.531 ms |
| concurrency-64 | 4096 | 3076.29 | 6.105 ms | 77.909 ms | 210.928 ms |
| concurrency-128 | 4096 | 5355.2 | 5.477 ms | 81.216 ms | 89.626 ms |

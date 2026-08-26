# Kafka AcceptedFact load

- Checked at: 2026-08-26T15:13:39.982Z
- Revision: `fa7cde642c10cc044992f667f67fb7e75e8c2388`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 242.44 | 3.811 ms | 4.702 ms | 5.233 ms |
| concurrency-16 | 4096 | 2644.81 | 5.647 ms | 6.374 ms | 6.988 ms |
| concurrency-64 | 4096 | 6601.51 | 7.259 ms | 8.887 ms | 162.092 ms |
| concurrency-128 | 4096 | 13156.55 | 8.023 ms | 10.94 ms | 57.498 ms |
| concurrency-256 | 4096 | 18918.75 | 13.295 ms | 15.078 ms | 16.052 ms |
| concurrency-512 | 4096 | 16129.3 | 31.512 ms | 37.557 ms | 38.365 ms |
| concurrency-1024 | 4096 | 17010.7 | 55.589 ms | 67.044 ms | 68.246 ms |

# Kafka AcceptedFact load

- Checked at: 2026-08-26T09:58:52.815Z
- Revision: `c832d92a6f357641f80a6243ddfb3dca7144cfa0`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 125.2 | 3.769 ms | 46.956 ms | 65.273 ms |
| concurrency-16 | 4096 | 894.78 | 5.655 ms | 77.257 ms | 80.064 ms |
| concurrency-64 | 4096 | 2176.98 | 8.172 ms | 84.639 ms | 225.448 ms |
| concurrency-128 | 4096 | 5973.16 | 5.392 ms | 75.093 ms | 103.296 ms |

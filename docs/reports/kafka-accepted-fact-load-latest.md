# Kafka AcceptedFact load

- Checked at: 2026-08-26T10:25:51.895Z
- Revision: `67d2da5edf7613be3df1a908971196fb2b850a3e`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 177.44 | 3.468 ms | 4.79 ms | 53.111 ms |
| concurrency-16 | 4096 | 1629.47 | 4.829 ms | 54.743 ms | 72.641 ms |
| concurrency-64 | 4096 | 1043.67 | 55.904 ms | 100.536 ms | 299.367 ms |
| concurrency-128 | 4096 | 4764.84 | 5.454 ms | 92.965 ms | 104.083 ms |

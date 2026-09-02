# Kafka AcceptedFact load

- Checked at: 2026-09-02T03:41:12.567Z
- Revision: `2d79609e7f95012a7f2d455b6d97455628290976`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false
- Producer delivery report: batch
- Producer lanes: 4

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 280.68 | 3.233 ms | 3.72 ms | 4.124 ms |
| concurrency-16 | 4096 | 3387.69 | 4.175 ms | 5.259 ms | 24.423 ms |
| concurrency-64 | 4096 | 7349.13 | 4.867 ms | 32.723 ms | 135.893 ms |
| concurrency-128 | 4096 | 19896.78 | 5.128 ms | 7.117 ms | 43.022 ms |
| concurrency-256 | 4096 | 40903.13 | 5.804 ms | 7.911 ms | 8.704 ms |
| concurrency-512 | 4096 | 42547.51 | 9.711 ms | 19.32 ms | 21.781 ms |
| concurrency-1024 | 4096 | 51550.88 | 15.665 ms | 23.176 ms | 30.263 ms |
| sustained-256 | 262144 | 37250.87 | 6.13 ms | 10.43 ms | 26.768 ms |
| sustained-512 | 262144 | 61482.51 | 6.58 ms | 13.338 ms | 24.479 ms |
| sustained-1024 | 262144 | 70012.54 | 12.715 ms | 23.841 ms | 35.432 ms |

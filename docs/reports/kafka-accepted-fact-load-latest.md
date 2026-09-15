# Kafka AcceptedFact load

- Checked at: 2026-09-15T02:19:54.890Z
- Revision: `7e929c671a31c27b1311b84a99d2f8df6f888207`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false
- Producer delivery report: batch
- Producer lanes: 4
- Record trust: trusted-private-producer
- Measurement scope: unsigned Worker record -> Kafka ACK; excludes publication opening, Projector, PostgreSQL, model and Cube

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 301.36 | 3.134 ms | 3.59 ms | 3.894 ms |
| concurrency-16 | 4096 | 3777.72 | 3.759 ms | 4.738 ms | 16.172 ms |
| concurrency-64 | 4096 | 9330.7 | 4.236 ms | 5.911 ms | 154.132 ms |
| concurrency-128 | 4096 | 23375.43 | 4.81 ms | 6.493 ms | 24.181 ms |
| concurrency-256 | 4096 | 45593.93 | 5.427 ms | 6.827 ms | 7.555 ms |
| concurrency-512 | 4096 | 63023.87 | 7.043 ms | 11.404 ms | 11.763 ms |
| concurrency-1024 | 4096 | 43789.61 | 16.52 ms | 38.547 ms | 41.081 ms |
| sustained-256 | 262144 | 50496.68 | 4.94 ms | 6.632 ms | 8.593 ms |
| sustained-512 | 262144 | 58068.56 | 5.687 ms | 10.968 ms | 15.504 ms |
| sustained-1024 | 747520 | 74668.2 | 12.173 ms | 22.39 ms | 28.085 ms |

# Kafka AcceptedFact load

- Checked at: 2026-09-08T17:20:08.492Z
- Revision: `c2f2cc580e11571134e21be392b3ab6e7b3f29e4`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false
- Producer delivery report: batch
- Producer lanes: 4

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 245.27 | 3.953 ms | 4.543 ms | 4.958 ms |
| concurrency-16 | 4096 | 2011.68 | 6.497 ms | 8.74 ms | 43.417 ms |
| concurrency-64 | 4096 | 3707.06 | 10.15 ms | 42.483 ms | 207.114 ms |
| concurrency-128 | 4096 | 9503.59 | 11.14 ms | 38.663 ms | 41.132 ms |
| concurrency-256 | 4096 | 11744.28 | 15.804 ms | 51.473 ms | 54.723 ms |
| concurrency-512 | 4096 | 17672.92 | 20.453 ms | 53.736 ms | 69.466 ms |
| concurrency-1024 | 4096 | 19316.75 | 38.623 ms | 76.367 ms | 78.691 ms |
| sustained-256 | 262144 | 20042.27 | 11.384 ms | 22.793 ms | 36.854 ms |
| sustained-512 | 262144 | 29846.14 | 12.076 ms | 31.508 ms | 48.336 ms |
| sustained-1024 | 262144 | 31805.98 | 25.684 ms | 58.713 ms | 81.525 ms |

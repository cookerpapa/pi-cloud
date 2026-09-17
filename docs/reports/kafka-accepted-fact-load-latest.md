# Kafka AcceptedFact load

- Checked at: 2026-09-17T00:11:08.626Z
- Revision: `408f78580c587c637edfd81a86c8035ab5b546ca`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false
- Producer delivery report: batch
- Producer lanes: 4
- Record trust: trusted-private-producer
- Measurement scope: unsigned Worker record -> Kafka ACK; excludes publication opening, Projector, PostgreSQL, model and Cube

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 272.24 | 3.586 ms | 4.124 ms | 4.501 ms |
| concurrency-16 | 4096 | 2765.26 | 4.936 ms | 6.447 ms | 19.718 ms |
| concurrency-64 | 4096 | 7111.42 | 5.695 ms | 9.02 ms | 150.671 ms |
| concurrency-128 | 4096 | 15747.37 | 6.926 ms | 10.334 ms | 41.373 ms |
| concurrency-256 | 4096 | 29318.03 | 8.142 ms | 11.795 ms | 14.224 ms |
| concurrency-512 | 4096 | 41847.11 | 10.32 ms | 16.518 ms | 19.366 ms |
| concurrency-1024 | 4096 | 29986.03 | 25.019 ms | 54.55 ms | 59.063 ms |
| sustained-256 | 262144 | 27506.06 | 8.306 ms | 14.992 ms | 29.419 ms |
| sustained-512 | 262144 | 39382.25 | 10.618 ms | 22.266 ms | 30.127 ms |
| sustained-1024 | 435383 | 43448.23 | 20.871 ms | 41.586 ms | 53.988 ms |

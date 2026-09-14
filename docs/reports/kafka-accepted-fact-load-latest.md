# Kafka AcceptedFact load

- Checked at: 2026-09-14T09:48:57.659Z
- Revision: `1da357d3cc79b6420ecd8c6e51d7c9133e418226`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false
- Producer delivery report: batch
- Producer lanes: 4
- Record trust: trusted-private-producer
- Measurement scope: unsigned Worker record -> Kafka ACK; excludes publication opening, Projector, PostgreSQL, model and Cube

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 304.82 | 3.011 ms | 3.408 ms | 3.611 ms |
| concurrency-16 | 4096 | 3804.64 | 3.598 ms | 4.696 ms | 7.758 ms |
| concurrency-64 | 4096 | 10301.16 | 4.031 ms | 5.58 ms | 139.597 ms |
| concurrency-128 | 4096 | 26908.16 | 4.455 ms | 5.407 ms | 16.394 ms |
| concurrency-256 | 4096 | 52915.68 | 4.644 ms | 6.141 ms | 7.062 ms |
| concurrency-512 | 4096 | 63115.41 | 5.402 ms | 14.801 ms | 15.04 ms |
| concurrency-1024 | 4096 | 65549.94 | 12.594 ms | 29.467 ms | 31.744 ms |
| sustained-256 | 262144 | 51817.55 | 4.747 ms | 6.491 ms | 11.957 ms |
| sustained-512 | 262144 | 76139.81 | 5.537 ms | 8.836 ms | 12.909 ms |
| sustained-1024 | 5055873 | 84255.36 | 10.874 ms | 19.441 ms | 24.438 ms |

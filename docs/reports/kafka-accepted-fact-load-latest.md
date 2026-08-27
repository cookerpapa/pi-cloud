# Kafka AcceptedFact load

- Checked at: 2026-08-27T11:48:46.777Z
- Revision: `61ba57ec7528d544356b42285c942447689bb085`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false
- Producer delivery report: batch
- Producer lanes: 4

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 230.87 | 4.018 ms | 4.792 ms | 5.479 ms |
| concurrency-16 | 4096 | 1963.13 | 6.398 ms | 19.844 ms | 39.273 ms |
| concurrency-64 | 4096 | 4230.6 | 11.352 ms | 21.278 ms | 204.092 ms |
| concurrency-128 | 4096 | 8139.96 | 12.8 ms | 44.733 ms | 50.207 ms |
| concurrency-256 | 4096 | 11742.55 | 18.947 ms | 38.128 ms | 44.194 ms |
| concurrency-512 | 4096 | 16064.1 | 28.5 ms | 49.963 ms | 60.226 ms |
| concurrency-1024 | 4096 | 18457.39 | 38.615 ms | 66.318 ms | 74.979 ms |
| sustained-256 | 262144 | 13596.59 | 17.376 ms | 33.601 ms | 44.798 ms |
| sustained-512 | 262144 | 23363.54 | 19.911 ms | 36.507 ms | 47.891 ms |
| sustained-1024 | 262144 | 24190.38 | 38.317 ms | 73.139 ms | 89.238 ms |

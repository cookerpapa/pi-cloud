# Kafka AcceptedFact load

- Checked at: 2026-08-30T16:36:55.894Z
- Revision: `133dfab76b08936bcab8bb96e133a1212d18a604`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false
- Producer delivery report: batch
- Producer lanes: 4

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 204.21 | 3.966 ms | 5.464 ms | 6.957 ms |
| concurrency-16 | 4096 | 1906.23 | 7.331 ms | 10.432 ms | 25.455 ms |
| concurrency-64 | 4096 | 2038.31 | 12.445 ms | 90.406 ms | 351.164 ms |
| concurrency-128 | 4096 | 6544.88 | 11.801 ms | 58.605 ms | 78.164 ms |
| concurrency-256 | 4096 | 9062.53 | 17.879 ms | 64.15 ms | 64.639 ms |
| concurrency-512 | 4096 | 13881.74 | 32.566 ms | 49.791 ms | 54.742 ms |
| concurrency-1024 | 4096 | 18484.94 | 45.32 ms | 71.867 ms | 82.378 ms |
| sustained-256 | 262144 | 17366.95 | 12.012 ms | 35.375 ms | 55.432 ms |
| sustained-512 | 262144 | 28961.5 | 14.675 ms | 33.919 ms | 44.533 ms |
| sustained-1024 | 262144 | 31274.82 | 28.945 ms | 59.092 ms | 74.065 ms |

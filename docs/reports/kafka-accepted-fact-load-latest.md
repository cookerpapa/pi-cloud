# Kafka AcceptedFact load

- Checked at: 2026-08-26T15:19:01.933Z
- Revision: `e1b76d66ae809ec5b31818ebe4d3dc8fbaf99a06`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false
- Producer delivery report: batch

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 260.08 | 3.585 ms | 4.142 ms | 4.492 ms |
| concurrency-16 | 4096 | 2983.62 | 4.91 ms | 5.636 ms | 6.521 ms |
| concurrency-64 | 4096 | 8114.01 | 6.151 ms | 7.131 ms | 126.213 ms |
| concurrency-128 | 4096 | 16887.44 | 6.093 ms | 7.249 ms | 54.838 ms |
| concurrency-256 | 4096 | 26436.06 | 9.591 ms | 10.311 ms | 10.492 ms |
| concurrency-512 | 4096 | 18838.8 | 25.081 ms | 36.105 ms | 40.927 ms |
| concurrency-1024 | 4096 | 22662.23 | 41.193 ms | 48.916 ms | 49.313 ms |

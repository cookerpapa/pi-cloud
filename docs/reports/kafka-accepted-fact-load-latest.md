# Kafka AcceptedFact load

- Checked at: 2026-08-26T14:27:09.340Z
- Revision: `357c4f80fd22eb2bada91a0c023d2af473140895`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 112.43 | 4.111 ms | 51.155 ms | 69.878 ms |
| concurrency-16 | 4096 | 723.57 | 5.789 ms | 78.43 ms | 85.21 ms |
| concurrency-64 | 4096 | 2534.07 | 7.427 ms | 75.434 ms | 329.482 ms |
| concurrency-128 | 4096 | 5948.12 | 5.411 ms | 80.599 ms | 112.09 ms |

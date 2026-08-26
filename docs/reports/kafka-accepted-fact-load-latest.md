# Kafka AcceptedFact load

- Checked at: 2026-08-26T14:51:23.936Z
- Revision: `24929729cd093a01ef11010a57c04dcb0249d656`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 186.72 | 4.045 ms | 5.709 ms | 24.774 ms |
| concurrency-16 | 4096 | 1030.51 | 7.572 ms | 62.081 ms | 66.971 ms |
| concurrency-64 | 4096 | 3973.38 | 7.73 ms | 59.924 ms | 196.579 ms |
| concurrency-128 | 4096 | 10388.72 | 6.255 ms | 49.826 ms | 74.124 ms |

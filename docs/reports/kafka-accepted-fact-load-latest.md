# Kafka AcceptedFact load

- Checked at: 2026-09-07T04:54:24.566Z
- Revision: `b03391483f74969b38da4e384140bd8240fb0056`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false
- Producer delivery report: batch
- Producer lanes: 4

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 270.04 | 3.372 ms | 4.102 ms | 4.449 ms |
| concurrency-16 | 4096 | 3066.72 | 4.319 ms | 5.428 ms | 28.591 ms |
| concurrency-64 | 4096 | 6864.76 | 5.072 ms | 31.277 ms | 163.78 ms |
| concurrency-128 | 4096 | 15073.01 | 6.04 ms | 31.432 ms | 49.555 ms |
| concurrency-256 | 4096 | 33154.46 | 7.169 ms | 10.248 ms | 10.521 ms |
| concurrency-512 | 4096 | 37165.76 | 9.985 ms | 19.738 ms | 24.848 ms |
| concurrency-1024 | 4096 | 39123.01 | 16.443 ms | 42.357 ms | 45.082 ms |
| sustained-256 | 262144 | 37310.75 | 5.985 ms | 9.954 ms | 31.564 ms |
| sustained-512 | 262144 | 61007.11 | 6.637 ms | 13.401 ms | 23.664 ms |
| sustained-1024 | 262144 | 68191.32 | 13.908 ms | 22.993 ms | 28.551 ms |

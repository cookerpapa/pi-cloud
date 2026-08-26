# Kafka AcceptedFact load

- Checked at: 2026-08-26T15:46:06.615Z
- Revision: `f92dd18faaf3a8eb6c965043cb7a7d4c00c93ba7`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false
- Producer delivery report: batch
- Producer lanes: 4

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 257.09 | 3.631 ms | 4.137 ms | 4.434 ms |
| concurrency-16 | 4096 | 2886.64 | 4.977 ms | 6.448 ms | 7.41 ms |
| concurrency-64 | 4096 | 7324.03 | 6.057 ms | 10.68 ms | 154.573 ms |
| concurrency-128 | 4096 | 13953.77 | 7.564 ms | 11.152 ms | 51.079 ms |
| concurrency-256 | 4096 | 22265.25 | 10.827 ms | 15.158 ms | 17.828 ms |
| concurrency-512 | 4096 | 24300.16 | 16.693 ms | 36.696 ms | 40.302 ms |
| concurrency-1024 | 4096 | 25286.41 | 33.783 ms | 49.808 ms | 61.552 ms |
| sustained-256 | 262144 | 19104.65 | 11.917 ms | 24.781 ms | 36.928 ms |
| sustained-512 | 262144 | 27175.21 | 16.163 ms | 30.284 ms | 41.707 ms |
| sustained-1024 | 262144 | 27567.7 | 33.802 ms | 60.522 ms | 75.053 ms |

# Kafka AcceptedFact load

- Checked at: 2026-09-09T10:46:45.038Z
- Revision: `0dd25fe344a2cd5edc34c98551d3743c990995d8`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false
- Producer delivery report: batch
- Producer lanes: 4
- Record trust: trusted-private-producer
- Measurement scope: unsigned Worker record -> Kafka ACK; excludes publication opening, Projector, PostgreSQL, model and Cube

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 254.03 | 3.856 ms | 4.599 ms | 5.028 ms |
| concurrency-16 | 4096 | 2500.69 | 5.379 ms | 7.206 ms | 20.618 ms |
| concurrency-64 | 4096 | 6886.41 | 6.902 ms | 12.759 ms | 129.181 ms |
| concurrency-128 | 4096 | 13463.04 | 7.254 ms | 13.963 ms | 64.917 ms |
| concurrency-256 | 4096 | 29114.77 | 7.729 ms | 12.962 ms | 16.719 ms |
| concurrency-512 | 4096 | 38856.76 | 11.623 ms | 16.607 ms | 17.444 ms |
| concurrency-1024 | 4096 | 35614.1 | 21.296 ms | 43.364 ms | 48.178 ms |
| sustained-256 | 262144 | 24496.85 | 9.703 ms | 15.636 ms | 26.099 ms |
| sustained-512 | 262144 | 29791.9 | 13.69 ms | 29.786 ms | 39.574 ms |
| sustained-1024 | 262144 | 32730.94 | 27.76 ms | 52.879 ms | 65.571 ms |

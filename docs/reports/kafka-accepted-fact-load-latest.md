# Kafka AcceptedFact load

- Checked at: 2026-09-10T15:03:50.481Z
- Revision: `260e1fba3f954e5dd86d8793ee01b02665feb102`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false
- Producer delivery report: batch
- Producer lanes: 4
- Record trust: trusted-private-producer
- Measurement scope: unsigned Worker record -> Kafka ACK; excludes publication opening, Projector, PostgreSQL, model and Cube

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 260.15 | 3.779 ms | 4.596 ms | 5.194 ms |
| concurrency-16 | 4096 | 2179.32 | 5.685 ms | 20.412 ms | 39.489 ms |
| concurrency-64 | 4096 | 6360.54 | 7.275 ms | 11.637 ms | 131.636 ms |
| concurrency-128 | 4096 | 12659.98 | 8.195 ms | 13.057 ms | 60.308 ms |
| concurrency-256 | 4096 | 20120.63 | 11.55 ms | 22.526 ms | 25.123 ms |
| concurrency-512 | 4096 | 24645.34 | 13.833 ms | 37.307 ms | 39.742 ms |
| concurrency-1024 | 4096 | 27235.02 | 27.185 ms | 50.055 ms | 63.303 ms |
| sustained-256 | 262144 | 22789.47 | 9.894 ms | 19.838 ms | 35.161 ms |
| sustained-512 | 262144 | 38488.2 | 10.431 ms | 22.924 ms | 33.044 ms |
| sustained-1024 | 262144 | 35794.37 | 25.223 ms | 48.723 ms | 59.228 ms |

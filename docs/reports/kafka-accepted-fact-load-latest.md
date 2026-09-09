# Kafka AcceptedFact load

- Checked at: 2026-09-09T05:25:56.633Z
- Revision: `e5ae889ff2aaa02ca540ae615f70c57b2365291d`
- Kafka: 3 brokers / 32 partitions / RF 3 / acks=all
- Application microbatch: false
- Producer delivery report: batch
- Producer lanes: 4

| Case | Events | Events/s | ACK p50 | ACK p95 | ACK p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 4096 | 237.56 | 4.164 ms | 4.776 ms | 5.188 ms |
| concurrency-16 | 4096 | 2303.1 | 6.027 ms | 8.595 ms | 21.749 ms |
| concurrency-64 | 4096 | 3942.36 | 11.621 ms | 31.771 ms | 254.889 ms |
| concurrency-128 | 4096 | 8097.94 | 13.588 ms | 26.912 ms | 70.158 ms |
| concurrency-256 | 4096 | 11417.62 | 21.623 ms | 27.254 ms | 31.657 ms |
| concurrency-512 | 4096 | 11070.67 | 37.95 ms | 71.869 ms | 82.118 ms |
| concurrency-1024 | 4096 | 11277.7 | 76.508 ms | 142.898 ms | 145.523 ms |
| sustained-256 | 262144 | 10877.28 | 22.557 ms | 31.834 ms | 37.664 ms |
| sustained-512 | 262144 | 12791.11 | 29.499 ms | 65.452 ms | 76.806 ms |
| sustained-1024 | 262144 | 12815.57 | 63.897 ms | 127.779 ms | 149.154 ms |

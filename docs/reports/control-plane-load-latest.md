# PiCloud control-plane load evaluation

Generated: 2026-08-30T16:38:06.800Z

This loopback test measures tenant-scoped cold Session admission and conversation reads at 10/50/100 simultaneous HTTP requests. It does **not** claim 100 concurrent model/sandbox Runs; active execution capacity is evaluated separately.

- Requests: 320
- Errors: 0

- Cleanup errors: 0

| Operation | Concurrency | Success | Errors | Throughput | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create_cold_session | 10 | 10 | 0 | 34.35/s | 166 ms | 288 ms | 288 ms |
| read_conversation | 10 | 10 | 0 | 202.01/s | 47 ms | 49 ms | 49 ms |
| create_cold_session | 50 | 50 | 0 | 67.2/s | 486 ms | 715 ms | 736 ms |
| read_conversation | 50 | 50 | 0 | 213.96/s | 176 ms | 225 ms | 226 ms |
| create_cold_session | 100 | 100 | 0 | 67.99/s | 888 ms | 1393 ms | 1439 ms |
| read_conversation | 100 | 100 | 0 | 165.19/s | 562 ms | 583 ms | 585 ms |

# PiCloud control-plane load evaluation

Generated: 2026-08-27T11:52:26.866Z

This loopback test measures tenant-scoped cold Session admission and conversation reads at 10/50/100 simultaneous HTTP requests. It does **not** claim 100 concurrent model/sandbox Runs; active execution capacity is evaluated separately.

- Requests: 320
- Errors: 0

- Cleanup errors: 0

| Operation | Concurrency | Success | Errors | Throughput | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create_cold_session | 10 | 10 | 0 | 26.47/s | 219 ms | 373 ms | 373 ms |
| read_conversation | 10 | 10 | 0 | 110.47/s | 84 ms | 88 ms | 88 ms |
| create_cold_session | 50 | 50 | 0 | 63.16/s | 461 ms | 756 ms | 782 ms |
| read_conversation | 50 | 50 | 0 | 167.54/s | 235 ms | 288 ms | 290 ms |
| create_cold_session | 100 | 100 | 0 | 76.15/s | 773 ms | 1247 ms | 1294 ms |
| read_conversation | 100 | 100 | 0 | 149.65/s | 622 ms | 647 ms | 655 ms |

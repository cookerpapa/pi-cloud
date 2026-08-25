# PiCloud control-plane load evaluation

Generated: 2026-08-25T09:46:21.563Z

This loopback test measures tenant-scoped cold Session admission and conversation reads at 10/50/100 simultaneous HTTP requests. It does **not** claim 100 concurrent model/sandbox Runs; active execution capacity is evaluated separately.

- Requests: 320
- Errors: 0

- Cleanup errors: 0

| Operation | Concurrency | Success | Errors | Throughput | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create_cold_session | 10 | 10 | 0 | 32.95/s | 181 ms | 301 ms | 301 ms |
| read_conversation | 10 | 10 | 0 | 90.77/s | 106 ms | 109 ms | 109 ms |
| create_cold_session | 50 | 50 | 0 | 70.65/s | 467 ms | 681 ms | 702 ms |
| read_conversation | 50 | 50 | 0 | 164.23/s | 285 ms | 297 ms | 298 ms |
| create_cold_session | 100 | 100 | 0 | 89.79/s | 626 ms | 1038 ms | 1088 ms |
| read_conversation | 100 | 100 | 0 | 133.6/s | 706 ms | 726 ms | 728 ms |

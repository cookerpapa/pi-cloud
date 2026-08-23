# PiCloud control-plane load evaluation

Generated: 2026-08-23T19:59:36.362Z

This loopback test measures tenant-scoped cold Session admission and conversation reads at 10/50/100 simultaneous HTTP requests. It does **not** claim 100 concurrent model/sandbox Runs; active execution capacity is evaluated separately.

- Requests: 320
- Errors: 0

- Cleanup errors: 0

| Operation | Concurrency | Success | Errors | Throughput | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create_cold_session | 10 | 10 | 0 | 36.55/s | 158 ms | 270 ms | 270 ms |
| read_conversation | 10 | 10 | 0 | 221.35/s | 43 ms | 45 ms | 45 ms |
| create_cold_session | 50 | 50 | 0 | 96.86/s | 294 ms | 492 ms | 506 ms |
| read_conversation | 50 | 50 | 0 | 240.26/s | 197 ms | 204 ms | 204 ms |
| create_cold_session | 100 | 100 | 0 | 83.38/s | 686 ms | 1136 ms | 1179 ms |
| read_conversation | 100 | 100 | 0 | 238.69/s | 393 ms | 406 ms | 407 ms |

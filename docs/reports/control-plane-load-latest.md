# PiCloud control-plane load evaluation

Generated: 2026-09-17T01:02:17.786Z

This loopback test measures tenant-scoped cold Session admission and conversation reads at 10/50/100 simultaneous HTTP requests. It does **not** claim 100 concurrent model/sandbox Runs; active execution capacity is evaluated separately.

- Requests: 320
- Errors: 0

- Cleanup errors: 0

| Operation | Concurrency | Success | Errors | Throughput | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create_cold_session | 10 | 10 | 0 | 34.86/s | 136 ms | 283 ms | 283 ms |
| read_conversation | 10 | 10 | 0 | 209.33/s | 41 ms | 46 ms | 46 ms |
| create_cold_session | 50 | 50 | 0 | 46.78/s | 831 ms | 1040 ms | 1060 ms |
| read_conversation | 50 | 50 | 0 | 315.22/s | 104 ms | 150 ms | 152 ms |
| create_cold_session | 100 | 100 | 0 | 123.83/s | 470 ms | 757 ms | 787 ms |
| read_conversation | 100 | 100 | 0 | 446.3/s | 112 ms | 207 ms | 210 ms |

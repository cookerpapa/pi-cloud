# PiCloud control-plane load evaluation

Generated: 2026-09-02T05:24:29.031Z

This loopback test measures tenant-scoped cold Session admission and conversation reads at 10/50/100 simultaneous HTTP requests. It does **not** claim 100 concurrent model/sandbox Runs; active execution capacity is evaluated separately.

- Requests: 320
- Errors: 0

- Cleanup errors: 0

| Operation | Concurrency | Success | Errors | Throughput | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| create_cold_session | 10 | 10 | 0 | 47.33/s | 108 ms | 205 ms | 205 ms |
| read_conversation | 10 | 10 | 0 | 431.3/s | 22 ms | 22 ms | 22 ms |
| create_cold_session | 50 | 50 | 0 | 93.69/s | 321 ms | 511 ms | 529 ms |
| read_conversation | 50 | 50 | 0 | 319.69/s | 140 ms | 151 ms | 151 ms |
| create_cold_session | 100 | 100 | 0 | 106.13/s | 562 ms | 893 ms | 927 ms |
| read_conversation | 100 | 100 | 0 | 283.71/s | 328 ms | 342 ms | 345 ms |

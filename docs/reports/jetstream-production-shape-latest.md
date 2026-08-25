# JetStream production-shape acceptance

Generated: 2026-08-25T04:21:53.977Z

Revision: `d785354481fd8245d34320c18919fa83be9d3f07`

- Stream: R=3, file
- Baseline ordered/durable projection: passed
- Stale fence rejected: yes
- Gateway replay after loss: passed
- Projector commit-before-ACK redelivery: idempotent
- Stream leader loss delivery: passed (3299.879 ms)
- Authority batching: 102.96 → 1359.69 events/s (13.21x)
- PostgreSQL authority writes: 4096 for 2048 events → 64 for 8192 events
- SSE first-connection delivery: 2000/2000
- SSE effective delivery after reconnect: 2000/2000

- Publish phase: 2274.436 ms; browser read phase: 101.532 ms

| SSE connections | Connect p95 | Gateway RSS | JetStream consumers | Host free memory |
| ---: | ---: | ---: | ---: | ---: |
| 250 | 277.782 ms | 77.47 MiB | 1 | 6.88 GiB |
| 500 | 85.664 ms | 82.22 MiB | 1 | 6.84 GiB |
| 1000 | 88.616 ms | 92.95 MiB | 1 | 6.83 GiB |
| 2000 | 73.35 ms | 115.45 MiB | 1 | 6.76 GiB |

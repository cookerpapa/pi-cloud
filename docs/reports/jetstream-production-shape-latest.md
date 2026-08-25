# JetStream production-shape acceptance

Generated: 2026-08-25T05:03:56.384Z

Revision: `87d5f00d4b57d6ff4ae53d471c768a4ae561cf4d`

- Stream: R=3, file
- Baseline ordered/durable projection: passed
- Stale fence rejected: yes
- Gateway replay after loss: passed
- Projector commit-before-ACK redelivery: idempotent
- Stream leader loss delivery: passed (2299.603 ms)
- Authority batching: 94.72 → 1379.97 events/s (14.57x)
- PostgreSQL authority statements: 4096 for 2048 events → 64 for 8192 events
- SSE first-connection delivery: 2000/2000
- SSE effective delivery after reconnect: 2000/2000

- Publish phase: 3028.307 ms; browser read phase: 58.101 ms

| SSE connections | Connect p95 | Gateway RSS | JetStream consumers | Host free memory |
| ---: | ---: | ---: | ---: | ---: |
| 250 | 339.209 ms | 79.29 MiB | 1 | 6.94 GiB |
| 500 | 115.118 ms | 80.54 MiB | 1 | 6.95 GiB |
| 1000 | 85.348 ms | 92.29 MiB | 1 | 6.91 GiB |
| 2000 | 79.385 ms | 112.61 MiB | 1 | 6.83 GiB |

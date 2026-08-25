# JetStream production-shape acceptance

Generated: 2026-08-25T08:23:42.302Z

Revision: `f2027a786dd7818c796586146260563a286ce738`

- Stream: R=3, file
- Baseline ordered/durable projection: passed
- Stale ExecutionGrant rejected: yes
- Gateway replay after loss: passed
- Projector commit-before-ACK redelivery: idempotent
- Stream leader loss delivery: passed (4817.375 ms)
- Authority batching: 241.99 → 1514.52 events/s (6.26x)
- PostgreSQL authority statements: 4096 for 2048 events → 64 for 8192 events
- SSE first-connection delivery: 2000/2000
- SSE effective delivery after reconnect: 2000/2000

- Publish phase: 2589.348 ms; browser read phase: 56.3 ms

| SSE connections | Connect p95 | Gateway RSS | JetStream consumers | Host free memory |
| ---: | ---: | ---: | ---: | ---: |
| 250 | 302.516 ms | 76.3 MiB | 1 | 7.02 GiB |
| 500 | 106.213 ms | 78.41 MiB | 1 | 7 GiB |
| 1000 | 93.065 ms | 93.25 MiB | 1 | 6.96 GiB |
| 2000 | 69.528 ms | 113.75 MiB | 1 | 6.87 GiB |

# JetStream production-shape acceptance

Generated: 2026-08-25T02:29:05.655Z

Revision: `5dd15883ae5b96c63b9df9453574daa43044db2e`

- Stream: R=3, file
- Baseline ordered/durable projection: passed
- Stale fence rejected: yes
- Gateway replay after loss: passed
- Projector commit-before-ACK redelivery: idempotent
- Stream leader loss delivery: passed (4307.667 ms)
- SSE first-connection delivery: 2000/2000
- SSE effective delivery after reconnect: 2000/2000

- Publish phase: 2624.2 ms; browser read phase: 85.37 ms

| SSE connections | Connect p95 | Gateway RSS | JetStream consumers | Host free memory |
| ---: | ---: | ---: | ---: | ---: |
| 250 | 238.62 ms | 78.48 MiB | 1 | 6.42 GiB |
| 500 | 85.035 ms | 81.48 MiB | 1 | 6.4 GiB |
| 1000 | 66.218 ms | 92.71 MiB | 1 | 6.36 GiB |
| 2000 | 75.135 ms | 117.54 MiB | 1 | 6.28 GiB |

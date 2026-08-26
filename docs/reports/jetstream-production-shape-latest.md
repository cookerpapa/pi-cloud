# JetStream production-shape acceptance

Generated: 2026-08-26T01:30:23.266Z

Revision: `59c6e4a4a3c24868cf31e7f8edc22aab30f0c73d`

- Stream: R=3, file
- Baseline ordered/durable projection: passed
- Stale ExecutionGrant rejected: yes
- Gateway replay after loss: passed
- Projector commit-before-ACK redelivery: idempotent
- Stream leader loss delivery: passed (5812.164 ms)
- Authority batching: 243.3 → 1383.54 events/s (5.69x)
- PostgreSQL authority statements: 4096 for 2048 events → 64 for 8192 events
- Exact Worker HTTP → PostgreSQL authority → JetStream R=3 sustained throughput: 578.86 events/s
- Exact-channel Leader loss: passed (2048 events)
- SSE first-connection delivery: 2000/2000
- SSE effective delivery after reconnect: 2000/2000

- Publish phase: 2712.907 ms; browser read phase: 48.032 ms

| SSE connections | Connect p95 | Gateway RSS | JetStream consumers | Host free memory |
| ---: | ---: | ---: | ---: | ---: |
| 250 | 255.739 ms | 76.1 MiB | 1 | 6.63 GiB |
| 500 | 117.322 ms | 78.1 MiB | 1 | 6.59 GiB |
| 1000 | 94.72 ms | 94.85 MiB | 1 | 6.56 GiB |
| 2000 | 113.27 ms | 118.52 MiB | 1 | 6.45 GiB |

## Exact Worker ingest channel

The measured boundary is the production Worker HTTP client through the Fastify ingest Gateway, PostgreSQL ExecutionGrant batch authority, and synchronous JetStream R=3 file-storage PubAck. LLM, Cube, SSE delivery, and the SessionStorage projector are excluded.

| Case | Events | HTTP concurrency | Text payload | Events/s | ACK p50 | ACK p95 | Events/authority transaction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 2048 | 1 | 1024 B | 70.11 | 13.961 ms | 17.259 ms | 1 |
| concurrency-16 | 8192 | 16 | 1024 B | 349.86 | 44.772 ms | 59.353 ms | 8.02 |
| concurrency-64 | 8192 | 64 | 1024 B | 524.31 | 117.473 ms | 162.661 ms | 32 |
| concurrency-128 | 8192 | 128 | 1024 B | 505.28 | 244.857 ms | 362.083 ms | 63.5 |
| payload-256b | 8192 | 64 | 256 B | 528.13 | 117.574 ms | 165.738 ms | 32.25 |
| payload-4kib | 8192 | 64 | 4096 B | 422.94 | 144.086 ms | 228.659 ms | 33.03 |
| 256-active-sessions | 8192 | 64 | 1024 B | 518.79 | 120.962 ms | 158.608 ms | 32.25 |
| sustained-32k | 32768 | 128 | 1024 B | 578.86 | 214.23 ms | 286.724 ms | 64.63 |

Leader loss changed n1 to n3; all 2048 events crossed the durability boundary. ACK p99 during failover was 20399.695 ms.

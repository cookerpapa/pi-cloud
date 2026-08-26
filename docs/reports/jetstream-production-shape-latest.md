# JetStream production-shape acceptance

Generated: 2026-08-26T06:50:22.217Z

Revision: `cf18930a7a6b8810ed5956cc3561a8b2d49f4b83`

- Stream: R=3, file
- Baseline ordered/durable projection: passed
- Stale ExecutionGrant rejected: yes
- Gateway replay after loss: passed
- Projector commit-before-ACK redelivery: idempotent
- Stream leader loss delivery: passed (4315.073 ms)
- Exact Worker EventWriterChannel → JetStream R=3 sustained throughput: 492.44 events/s
- Exact-channel Leader loss: passed (2048 events)
- SSE first-connection delivery: 2000/2000
- SSE effective delivery after reconnect: 2000/2000

- Publish phase: 2475.626 ms; browser read phase: 42.862 ms

| SSE connections | Connect p95 | Gateway RSS | JetStream consumers | Host free memory |
| ---: | ---: | ---: | ---: | ---: |
| 250 | 269.725 ms | 74.8 MiB | 1 | 7.13 GiB |
| 500 | 105.574 ms | 77.21 MiB | 1 | 7.13 GiB |
| 1000 | 73.687 ms | 91.27 MiB | 1 | 7.09 GiB |
| 2000 | 77.179 ms | 114.02 MiB | 1 | 7.02 GiB |

## Exact Worker ingest channel

The measured boundary is the production Worker EventWriterChannel through the Fastify WebSocket Gateway and synchronous JetStream R=3 file-storage PubAck. PostgreSQL admits and renews the channel rather than every event. LLM, Cube, SSE delivery, and the SessionStorage projector are excluded.

| Case | Events | Writer channels | Active concurrency | Text payload | Events/s | ACK p50 | ACK p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 8192 | undefined | 1 | 1024 B | 230.91 | 4.208 ms | 5.456 ms |
| concurrency-16 | 8192 | undefined | 16 | 1024 B | 477.82 | 32.028 ms | 45.96 ms |
| concurrency-64 | 8192 | undefined | 64 | 1024 B | 487.92 | 122.214 ms | 162.938 ms |
| concurrency-128 | 8192 | undefined | 128 | 1024 B | 473.83 | 219.48 ms | 328.659 ms |
| payload-256b | 8192 | undefined | 64 | 256 B | 501.44 | 119.165 ms | 158.465 ms |
| payload-4kib | 8192 | undefined | 64 | 4096 B | 464.48 | 126.75 ms | 173.733 ms |
| 256-sessions-128-active | 8192 | undefined | 128 | 1024 B | 408.93 | 205.1 ms | 408.488 ms |
| sustained-32k | 32768 | undefined | 128 | 1024 B | 492.44 | 238.809 ms | 309.919 ms |

Leader loss changed n1 to n3; all 2048 events crossed the durability boundary. ACK p99 during failover was 6587.538 ms.

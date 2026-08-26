# JetStream production-shape acceptance

Generated: 2026-08-26T04:09:43.507Z

Revision: `66a8f528977208c1572f154bf70830a040d66068`

- Stream: R=3, file
- Baseline ordered/durable projection: passed
- Stale ExecutionGrant rejected: yes
- Gateway replay after loss: passed
- Projector commit-before-ACK redelivery: idempotent
- Stream leader loss delivery: passed (4797.832 ms)
- Exact Worker EventWriterChannel → JetStream R=3 sustained throughput: 485.56 events/s
- Exact-channel Leader loss: passed (2048 events)
- SSE first-connection delivery: 2000/2000
- SSE effective delivery after reconnect: 2000/2000

- Publish phase: 2098.616 ms; browser read phase: 43.272 ms

| SSE connections | Connect p95 | Gateway RSS | JetStream consumers | Host free memory |
| ---: | ---: | ---: | ---: | ---: |
| 250 | 342.174 ms | 75.41 MiB | 1 | 7.3 GiB |
| 500 | 107.68 ms | 78.91 MiB | 1 | 7.28 GiB |
| 1000 | 82.754 ms | 90.66 MiB | 1 | 7.24 GiB |
| 2000 | 65.472 ms | 113.16 MiB | 1 | 7.17 GiB |

## Exact Worker ingest channel

The measured boundary is the production Worker EventWriterChannel through the Fastify WebSocket Gateway and synchronous JetStream R=3 file-storage PubAck. PostgreSQL admits and renews the channel rather than every event. LLM, Cube, SSE delivery, and the SessionStorage projector are excluded.

| Case | Events | Writer channels | Active concurrency | Text payload | Events/s | ACK p50 | ACK p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| concurrency-1 | 8192 | 1 | 1 | 1024 B | 227.4 | 4.291 ms | 5.594 ms |
| concurrency-16 | 8192 | 16 | 16 | 1024 B | 452.95 | 33.236 ms | 49.464 ms |
| concurrency-64 | 8192 | 64 | 64 | 1024 B | 482.94 | 124.212 ms | 168.001 ms |
| concurrency-128 | 8192 | 128 | 128 | 1024 B | 468.34 | 230.381 ms | 339.544 ms |
| payload-256b | 8192 | 64 | 64 | 256 B | 487.11 | 121.054 ms | 171.802 ms |
| payload-4kib | 8192 | 64 | 64 | 4096 B | 448.71 | 132.673 ms | 187.361 ms |
| 256-sessions-128-active | 8192 | 256 | 128 | 1024 B | 452.48 | 200.537 ms | 267.855 ms |
| sustained-32k | 32768 | 256 | 128 | 1024 B | 485.56 | 238.407 ms | 325.377 ms |

Leader loss changed n1 to n2; all 2048 events crossed the durability boundary. ACK p99 during failover was 151.647 ms.

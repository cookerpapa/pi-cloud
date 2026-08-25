# JetStream production-shape spike

This isolated follow-up validates the leading transport candidate without
changing PiCloud production services.

```text
trusted Worker simulator
        │ HTTP, current Attempt/Fence
        ▼
stateless Event Ingest ──PubAck──> NATS JetStream R=3 / file storage
                                      ├── filtered ordered consumer ──> SSE Gateway
                                      └── durable explicit-ACK consumer ──> PostgreSQL
```

The PostgreSQL projector persists only complete Assistant messages and Turn
terminal records. Text deltas remain in the bounded JetStream hot log. The
ingest boundary validates current Session/Attempt/Fence state before an event
can enter the browser-visible Stream.

The acceptance kills the SSE Gateway, kills the projector after its database
commit but before broker ACK, kills the current Stream Leader, and then opens
250/500/1,000/2,000 sustained Session-filtered SSE connections. Experimental
credentials and ports are loopback-only.

Run from the repository root:

```bash
npm run eval:jetstream-production-shape
```

The report is written to
`docs/reports/jetstream-production-shape-latest.{json,md}`. The Compose project
and all experimental Volumes are removed afterward.

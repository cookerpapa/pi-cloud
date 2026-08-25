# Streaming backend comparison

This spike compares the existing Kafka hot-event authority with Valkey Streams
and NATS JetStream. It does not change the production topology.

The workload uses the same bounded, Session-keyed event envelope for every
backend and measures:

- acknowledged publish throughput and latency;
- one global canonical projector draining every Session;
- replay of one Session among concurrent background Sessions;
- per-Session ordering and duplicate detection;
- replay after a broker process restart;
- the state a browser Gateway must maintain.

Run from the repository root:

```bash
npm run eval:streaming-backends
```

The command creates isolated, pinned single-node brokers and writes its report
to `docs/reports/streaming-backend-comparison-latest.{json,md}`. Single-node
results are comparative development evidence, not an HA or enterprise-capacity
claim. Kafka and JetStream use file-backed logs; Valkey uses AOF with
`appendfsync everysec`. Their acknowledgement contracts are reported rather
than treated as identical.

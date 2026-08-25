# Streaming backend comparison

Generated: 2026-08-25T01:58:46.132Z

Revision: `5d84c5ae9738b06b91abefc222d2874766294e1a`

Workload: 64 Sessions × 32 events, 256-byte target payload, isolated single-node brokers.

| Backend | Acked publish | Ack p95 | Projection p95 | Focused replay scan | ACKed sentinel after process kill |
| --- | ---: | ---: | ---: | ---: | ---: |
| kafka | 821.83/s | 225.169 ms | 503.573 ms | 47.56x | yes |
| valkey-aof-everysec | 31,606.65/s | 3.405 ms | 153.653 ms | 1x | yes |
| valkey-aof-always | 4,378.98/s | 18.832 ms | 1146.504 ms | 1x | yes |
| nats-jetstream | 15,625.37/s | 6.787 ms | 8.51 ms | 1x | yes |

## Gateway state

- **kafka:** Session-indexed replay projection or partition scan
- **valkey-aof-everysec:** Direct per-Session XREAD; projector must discover dynamic Stream keys
- **valkey-aof-always:** Direct per-Session XREAD; projector must discover dynamic Stream keys
- **nats-jetstream:** Filtered ordered consumer per active Session; no replay projection

## 256 idle Gateway readers

- **kafka:** 1 shared partition consumer; setup 0 ms. Kafka cannot filter by Session key; one shared consumer requires an in-process Session projection.
- **valkey-aof-everysec:** 256 blocking client connections; setup 487.782 ms. The direct one-Stream-per-Session path consumes one blocking connection per ungrouped reader.
- **valkey-aof-always:** 256 blocking client connections; setup 422.492 ms. The direct one-Stream-per-Session path consumes one blocking connection per ungrouped reader.
- **nats-jetstream:** 256 ephemeral filtered consumers; setup 71.392 ms. JetStream owns each filtered replay cursor; a high connection count creates broker consumer metadata.

## Guardrails

- Absolute throughput is not comparable to a replicated multi-node production topology.
- Valkey AOF everysec can acknowledge before fsync; AOF always measures the stronger local-disk contract.
- Kafka focused replay scans interleaved partition records because Kafka has no per-key subscription.
- JetStream ordered consumers are ephemeral broker resources and their per-connection cost still needs a long-connection load test.
- Authority/fence validation and PostgreSQL semantic projection are intentionally outside this transport-only spike.

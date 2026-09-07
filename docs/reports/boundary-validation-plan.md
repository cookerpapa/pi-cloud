# Boundary validation campaign

Started 2026-09-07 after ADR-0153. Run sequentially on WSL; use isolated data,
bounded resources and real middleware. Never reboot the user's host or stop a
production service to simulate another machine. Record simulated and physical
evidence separately. Stop for discussion if a correctness failure requires a
new architecture contract rather than a local repair.

| Order | Boundary | Required evidence |
| --- | --- | --- |
| 1 | Late publisher after authority expiry | pause ingress after acceptance, rotate authority, project recovery barrier, resume old publisher; old work must not silently alter the recovered branch |
| 2 | Kafka/Projector crash windows | concurrent output during broker loss; kill projector after DB commit/before offset commit; exact idempotent recovery |
| 3 | Host, multi-node, retention and backup | isolate process/VM tests locally; physical host/storage failover and node drain require actual independent nodes; test loss of unprojected retained data explicitly |
| 4 | End-to-end capacity | bounded synthetic loops plus SSE clients, lag/memory/GC and a sustained run; distinguish producer-only throughput |
| 5 | Long context | real paid coding with repeated Compaction, new Worker restoration and interruption; do not call a lowered-threshold test a 1M-context test |

Initial late-publisher probe uses a temporary PostgreSQL instance with the full
current schema, a private topic on the real R=3 Kafka cluster, and separate Node
processes. It exercises production FactChannel, authority, Kafka adapter,
consumer and Session projection code. Fixture authority replacement is atomic
SQL: it isolates the ingress/projection contract, not the Run reaper or a full
Agent takeover. No model tokens are needed to establish this ordering property.

Campaign paused at item 1: [reproducible late-publisher counterexample](late-publisher-findings.md).
Items 2–5 remain pending; do not interpret the existence of this plan as test evidence.

# PiCloud deterministic fault evaluation

Generated: 2026-08-27T11:31:13.505Z

Revision: 54784f68c11312d03579c8dce390eaca58ae2589

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 18
- Invariants preserved: 18/18 (100.0%)
- p50 / p95: 11364 ms / 12336 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| duplicate-command | pass | At-least-once delivery does not execute the same command twice. | 4779 ms |
| stale-execution-lease | pass | A released or recovered old Worker cannot reuse an obsolete ExecutionLease. | 4872 ms |
| stale-accepted-log-authority | pass | A stale Worker cannot cross the PostgreSQL ExecutionLease boundary into either Kafka AcceptedFact log. | 12246 ms |
| session-mutation-redelivery | pass | At-least-once Session mutation delivery creates one canonical PostgreSQL effect. | 9072 ms |
| session-projection-barrier-before-read | pass | A replacement Worker crosses the Session-keyed projection barrier and rechecks its ExecutionLease before reading PostgreSQL. | 2206 ms |
| message-stream-independence | pass | A streaming-path failure cannot roll back a complete Pi message already committed to SessionStorage. | 8516 ms |
| interrupted-visible-prefix | pass | A browser-visible failed prefix remains model-visible after Worker replacement. | 8618 ms |
| terminal-stream-independence | pass | A successful Run terminal commit does not reconstruct a complete message from the short-lived delta tail. | 12099 ms |
| accepted-projection-ahead-of-worker-ack | pass | A Kafka AcceptedFact watermark already ahead of the Worker ACK cannot strand terminal Run settlement. | 12201 ms |
| control-plane-process-sigkill | pass | A Control Plane process replacement does not revoke a healthy Agent Loop's ExecutionLease. | 4907 ms |
| control-channel-expiry-with-live-run | pass | A stale Control Channel cannot retire a Worker whose active RunAttempt still has fresh database authority. | 12049 ms |
| dead-worker-management-unavailable | pass | After connection and ExecutionLease expiry, a dead management endpoint cannot strand the interrupted Run or Session. | 12336 ms |
| assignment-loss-releases-model-reservation | pass | Worker loss settles its model reservation so the replacement Run does not wait for quota TTL. | 11382 ms |
| terminal-tool-activation-before-next-writer | pass | A replacement writer can retire a failed activation, while a revoked ExecutionLease cannot start another Tool operation. | 9748 ms |
| checkpoint-corruption-and-cas | pass | Checkpoint integrity and compare-and-swap fencing token checks survive cold recovery. | 11364 ms |
| cancel-complete-race | pass | Exactly one terminal Run outcome wins a cancel/complete race. | 12197 ms |
| stale-dispatch-claim | pass | A superseded dispatcher cannot start external work. | 12072 ms |
| orphan-runtime-cleanup | pass | Expired ownership is reconciled only after the orphan runtime is terminated. | 11980 ms |

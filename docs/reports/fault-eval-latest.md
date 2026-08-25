# PiCloud deterministic fault evaluation

Generated: 2026-08-25T08:22:03.441Z

Revision: f2027a786dd7818c796586146260563a286ce738

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 18
- Invariants preserved: 18/18 (100.0%)
- p50 / p95: 8301 ms / 9282 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| duplicate-command | pass | At-least-once delivery does not execute the same command twice. | 3424 ms |
| stale-execution-grant | pass | A released or recovered old Worker cannot reuse an obsolete ExecutionGrant. | 3859 ms |
| stale-jetstream-event-authority | pass | A stale Worker cannot cross the transaction-scoped ExecutionGrant boundary into browser-visible JetStream events. | 8536 ms |
| session-mutation-redelivery | pass | At-least-once Session mutation delivery creates one canonical PostgreSQL effect. | 6177 ms |
| session-projection-barrier-before-read | pass | A replacement Worker crosses the Session-keyed projection barrier and rechecks its ExecutionGrant before reading PostgreSQL. | 1644 ms |
| message-stream-independence | pass | A streaming-path failure cannot roll back a complete Pi message already committed to SessionStorage. | 6262 ms |
| interrupted-visible-prefix | pass | A browser-visible failed prefix remains model-visible after Worker replacement. | 6466 ms |
| terminal-stream-independence | pass | A successful Run terminal commit does not reconstruct a complete message from the short-lived delta tail. | 8924 ms |
| accepted-projection-ahead-of-worker-ack | pass | A JetStream event watermark already ahead of the Worker ACK cannot strand terminal Run settlement. | 8832 ms |
| control-plane-process-sigkill | pass | A Control Plane process replacement does not revoke a healthy Agent Loop's ExecutionGrant. | 3894 ms |
| control-channel-expiry-with-live-run | pass | A stale Control Channel cannot retire a Worker whose active RunAttempt still has fresh database authority. | 8301 ms |
| dead-worker-management-unavailable | pass | After connection and ExecutionGrant expiry, a dead management endpoint cannot strand the interrupted Run or Session. | 8544 ms |
| assignment-loss-releases-model-reservation | pass | Worker loss settles its model reservation so the replacement Run does not wait for quota TTL. | 8596 ms |
| terminal-tool-activation-before-next-writer | pass | A replacement writer can retire a failed activation, while a revoked ExecutionGrant cannot start another Tool operation. | 7339 ms |
| checkpoint-corruption-and-cas | pass | Checkpoint integrity and compare-and-swap generation checks survive cold recovery. | 8442 ms |
| cancel-complete-race | pass | Exactly one terminal Run outcome wins a cancel/complete race. | 9238 ms |
| stale-dispatch-claim | pass | A superseded dispatcher cannot start external work. | 9282 ms |
| orphan-runtime-cleanup | pass | Expired ownership is reconciled only after the orphan runtime is terminated. | 8439 ms |

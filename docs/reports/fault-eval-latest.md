# PiCloud deterministic fault evaluation

Generated: 2026-08-25T10:16:08.929Z

Revision: f22e1344f5e30a0f275effb7827316a06fde2774

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 18
- Invariants preserved: 18/18 (100.0%)
- p50 / p95: 8520 ms / 9553 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| duplicate-command | pass | At-least-once delivery does not execute the same command twice. | 3378 ms |
| stale-execution-grant | pass | A released or recovered old Worker cannot reuse an obsolete ExecutionGrant. | 3987 ms |
| stale-jetstream-event-authority | pass | A stale Worker cannot cross the transaction-scoped ExecutionGrant boundary into browser-visible JetStream events. | 8795 ms |
| session-mutation-redelivery | pass | At-least-once Session mutation delivery creates one canonical PostgreSQL effect. | 6366 ms |
| session-projection-barrier-before-read | pass | A replacement Worker crosses the Session-keyed projection barrier and rechecks its ExecutionGrant before reading PostgreSQL. | 1572 ms |
| message-stream-independence | pass | A streaming-path failure cannot roll back a complete Pi message already committed to SessionStorage. | 6501 ms |
| interrupted-visible-prefix | pass | A browser-visible failed prefix remains model-visible after Worker replacement. | 6553 ms |
| terminal-stream-independence | pass | A successful Run terminal commit does not reconstruct a complete message from the short-lived delta tail. | 9012 ms |
| accepted-projection-ahead-of-worker-ack | pass | A JetStream event watermark already ahead of the Worker ACK cannot strand terminal Run settlement. | 9553 ms |
| control-plane-process-sigkill | pass | A Control Plane process replacement does not revoke a healthy Agent Loop's ExecutionGrant. | 4038 ms |
| control-channel-expiry-with-live-run | pass | A stale Control Channel cannot retire a Worker whose active RunAttempt still has fresh database authority. | 8608 ms |
| dead-worker-management-unavailable | pass | After connection and ExecutionGrant expiry, a dead management endpoint cannot strand the interrupted Run or Session. | 8610 ms |
| assignment-loss-releases-model-reservation | pass | Worker loss settles its model reservation so the replacement Run does not wait for quota TTL. | 8520 ms |
| terminal-tool-activation-before-next-writer | pass | A replacement writer can retire a failed activation, while a revoked ExecutionGrant cannot start another Tool operation. | 8036 ms |
| checkpoint-corruption-and-cas | pass | Checkpoint integrity and compare-and-swap generation checks survive cold recovery. | 9141 ms |
| cancel-complete-race | pass | Exactly one terminal Run outcome wins a cancel/complete race. | 9193 ms |
| stale-dispatch-claim | pass | A superseded dispatcher cannot start external work. | 9196 ms |
| orphan-runtime-cleanup | pass | Expired ownership is reconciled only after the orphan runtime is terminated. | 8758 ms |

# PiCloud deterministic fault evaluation

Generated: 2026-08-25T05:10:06.232Z

Revision: 87d5f00d4b57d6ff4ae53d471c768a4ae561cf4d

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 18
- Invariants preserved: 18/18 (100.0%)
- p50 / p95: 8662 ms / 9569 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| duplicate-command | pass | At-least-once delivery does not execute the same command twice. | 4380 ms |
| stale-fencing-token | pass | A released or recovered old worker cannot reacquire an obsolete fence. | 3854 ms |
| stale-jetstream-event-authority | pass | A stale Worker cannot cross the transaction-scoped authority/Fence boundary into browser-visible JetStream events. | 9286 ms |
| session-mutation-redelivery | pass | At-least-once Session mutation delivery creates one canonical PostgreSQL effect. | 6061 ms |
| session-projection-barrier-before-read | pass | A replacement Worker crosses the Session-keyed projection barrier and rechecks its fence before reading PostgreSQL. | 1329 ms |
| message-stream-independence | pass | A streaming-path failure cannot roll back a complete Pi message already committed to SessionStorage. | 6756 ms |
| interrupted-visible-prefix | pass | A browser-visible failed prefix remains model-visible after Worker replacement. | 6407 ms |
| terminal-stream-independence | pass | A successful Run terminal commit does not reconstruct a complete message from the short-lived delta tail. | 9080 ms |
| accepted-projection-ahead-of-worker-ack | pass | A JetStream event watermark already ahead of the Worker ACK cannot strand terminal Run settlement. | 9569 ms |
| control-plane-process-sigkill | pass | A Control Plane process replacement does not revoke a healthy fenced Agent Loop. | 3557 ms |
| control-channel-expiry-with-live-run | pass | A stale Control Channel cannot retire a Worker whose active RunAttempt still has fresh database authority. | 8903 ms |
| dead-worker-management-unavailable | pass | After connection and lease expiry, a dead management endpoint cannot strand the interrupted Run or Session. | 9335 ms |
| assignment-loss-releases-model-reservation | pass | Worker loss settles its model reservation so the replacement Run does not wait for quota TTL. | 9095 ms |
| terminal-tool-activation-before-next-writer | pass | A replacement writer can synchronously claim and retire the failed Run's fenced Tool activation. | 7914 ms |
| checkpoint-corruption-and-cas | pass | Checkpoint integrity and compare-and-swap fencing survive cold recovery. | 8728 ms |
| cancel-complete-race | pass | Exactly one terminal Run outcome wins a cancel/complete race. | 8996 ms |
| stale-dispatch-claim | pass | A superseded dispatcher cannot start external work. | 9384 ms |
| orphan-runtime-cleanup | pass | Expired ownership is reconciled only after the orphan runtime is terminated. | 8662 ms |

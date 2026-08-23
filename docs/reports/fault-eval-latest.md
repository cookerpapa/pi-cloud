# PiCloud deterministic fault evaluation

Generated: 2026-08-23T08:30:11.443Z

Revision: 0dd33a1d21e4e7d7df76c4aa6908fc5f92c3720d

These are targeted, deterministic fault injections against the durable execution protocol. They complement the production smoke test's live container restart; they are not presented as a distributed chaos benchmark.

- Cases: 18
- Invariants preserved: 18/18 (100.0%)
- p50 / p95: 6887 ms / 10658 ms

| Fault | Result | Protected invariant | Duration |
| --- | --- | --- | ---: |
| duplicate-command | pass | At-least-once delivery does not execute the same command twice. | 4531 ms |
| stale-fencing-token | pass | A released or recovered old worker cannot reacquire an obsolete fence. | 4371 ms |
| stale-kafka-event-authority | pass | A stale Worker may reach Raw Kafka but cannot publish browser-visible Accepted events. | 10303 ms |
| session-mutation-redelivery | pass | At-least-once Session mutation delivery creates one canonical PostgreSQL effect. | 6663 ms |
| session-projection-barrier-before-read | pass | A replacement Worker crosses the Session-keyed projection barrier and rechecks its fence before reading PostgreSQL. | 1870 ms |
| message-stream-independence | pass | A streaming-path failure cannot roll back a complete Pi message already committed to SessionStorage. | 6849 ms |
| interrupted-visible-prefix | pass | A browser-visible failed prefix remains model-visible after Worker replacement. | 6887 ms |
| terminal-stream-independence | pass | A successful Run terminal commit does not reconstruct a complete message from the short-lived delta tail. | 10658 ms |
| accepted-projection-ahead-of-worker-ack | pass | An Accepted projector that commits before the Worker observes its ACK cannot strand terminal Run settlement. | 10098 ms |
| control-plane-process-sigkill | pass | A Control Plane process replacement does not revoke a healthy fenced Agent Loop. | 4679 ms |
| control-channel-expiry-with-live-run | pass | A stale Control Channel cannot retire a Worker whose active RunAttempt still has fresh database authority. | 9527 ms |
| dead-worker-management-unavailable | pass | After connection and lease expiry, a dead management endpoint cannot strand the interrupted Run or Session. | 9439 ms |
| assignment-loss-releases-model-reservation | pass | Worker loss settles its model reservation so the replacement Run does not wait for quota TTL. | 10447 ms |
| terminal-tool-activation-before-next-writer | pass | A replacement writer can synchronously claim and retire the failed Run's fenced Tool activation. | 7204 ms |
| checkpoint-corruption-and-cas | pass | Checkpoint integrity and compare-and-swap fencing survive cold recovery. | 6631 ms |
| cancel-complete-race | pass | Exactly one terminal Run outcome wins a cancel/complete race. | 6890 ms |
| stale-dispatch-claim | pass | A superseded dispatcher cannot start external work. | 7072 ms |
| orphan-runtime-cleanup | pass | Expired ownership is reconciled only after the orphan runtime is terminated. | 6666 ms |
